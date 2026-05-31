import type {
  RecordingEvent,
  RecordingPackageV1,
  ReplayPlaybackRate,
  ReplayScheduler,
  ReplaySchedulerState,
  ReplayStableState,
  TimelineClock,
} from "@/shared/recording-schema";
import type { ReplayMediaClockAdapter } from "./mediaClockAdapter";
import { buildInitialState, cloneState } from "./initialState";
import { findSnapshotAtMost, buildReplayIndex } from "./replayIndex";
import { replayReducer } from "./replayReducer";
import { createTimelineClock } from "./timelineClock";

export type TickListener = (
  state: ReplayStableState,
  transientEvents: RecordingEvent[],
  timelineTimeMs: number,
) => void;

export type ReplaySchedulerOptions = {
  clock?: TimelineClock;
  mediaAdapter?: ReplayMediaClockAdapter | null;
  /**
   * Drives the rendering loop. Tests pass a synchronous ticker; the runtime
   * driver passes a requestAnimationFrame-based ticker.
   */
  tickStrategy?: TickStrategy;
  /** Wall-clock provider for buffering thresholds. */
  wallNow?: () => number;
  /** Notify on each tick — receives the new stable state and any transient
   *  events (mouse-move/shortcut flashes) that arrived during the tick. */
  onTick?: TickListener;
  /** Called once when stalled media has been blocking replay for 2s. */
  onMediaFallbackReady?: () => void;
};

export type TickStrategy = {
  start(onFrame: () => void): void;
  stop(): void;
};

const DEFAULT_RAF_INTERVAL_MS = 1000 / 60;
const MEDIA_DRIFT_THRESHOLD_MS = 250;
const MEDIA_BUFFERING_THRESHOLD_MS = 500;
const MEDIA_FALLBACK_THRESHOLD_MS = 2000;
const SEEK_POINTER_WINDOW_MS = 1200;
const SEEK_SHORTCUT_WINDOW_MS = 1200;
const SEEK_CLICK_WINDOW_MS = 500;

export function defaultTickStrategy(): TickStrategy {
  let handle: number | null = null;
  return {
    start(onFrame) {
      if (handle !== null) return;
      const loop = () => {
        onFrame();
        if (typeof requestAnimationFrame === "function") {
          handle = requestAnimationFrame(loop) as unknown as number;
        } else {
          handle = setTimeout(loop, DEFAULT_RAF_INTERVAL_MS) as unknown as number;
        }
      };
      handle = typeof requestAnimationFrame === "function"
        ? (requestAnimationFrame(loop) as unknown as number)
        : (setTimeout(loop, DEFAULT_RAF_INTERVAL_MS) as unknown as number);
    },
    stop() {
      if (handle === null) return;
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
      else clearTimeout(handle);
      handle = null;
    },
  };
}

/**
 * Replay scheduler — owns:
 *   - timeline clock (advances replay time per playback rate)
 *   - replay index (events by seq/type/time)
 *   - replay state (current stable state + last applied seq)
 *   - tick loop (consumes scheduled events between two timestamps)
 *
 * Seek algorithm (matches ADR-011 inclusive-snapshot strategy):
 *   1. Find snapshot S with timestamp <= target. State = snapshot's state.
 *   2. Apply every stable event whose seq > S.eventSeq and timestamp <= target.
 *   3. Set lastAppliedSeq to the highest event applied (or S.eventSeq if none).
 */
export function createReplayScheduler(options: ReplaySchedulerOptions = {}): ReplayScheduler & {
  /** Runtime hook — connects the media element after the replay package loads. */
  setMediaAdapter(adapter: ReplayMediaClockAdapter | null): void;
  /** Test hook — runs a single tick without the driver loop. */
  tick(): void;
  /** Test hook — exposes the latest stable state. */
  getStableState(): ReplayStableState;
} {
  const clock = options.clock ?? createTimelineClock();
  const tickStrategy = options.tickStrategy ?? defaultTickStrategy();
  const wallNow =
    options.wallNow ??
    (() => (typeof performance === "undefined" ? Date.now() : performance.now()));
  const stateListeners = new Set<(s: ReplaySchedulerState) => void>();
  let pkg: RecordingPackageV1 | null = null;
  let index = emptyIndex();
  let initial: ReplayStableState = emptyState();
  let stableState: ReplayStableState = emptyState();
  let driving = false;
  let mediaAdapter = options.mediaAdapter ?? null;
  let mediaBlockedSinceMs: number | null = null;
  let mediaFallbackNotified = false;
  let nextEventIndex = 0;

  let schedulerState: ReplaySchedulerState = {
    status: "loading",
    timelineTimeMs: 0,
    playbackRate: 1,
    lastAppliedSeq: 0,
    mediaStatus: "none",
    driftMs: 0,
  };

  const publish = () => stateListeners.forEach((fn) => fn(schedulerState));
  const updateState = (patch: Partial<ReplaySchedulerState>) => {
    schedulerState = { ...schedulerState, ...patch };
    publish();
  };
  const resetMediaBlock = () => {
    mediaBlockedSinceMs = null;
    mediaFallbackNotified = false;
  };
  const reportMediaOperationError = (error: unknown) => {
    console.warn("[replay-scheduler] media operation failed:", error);
  };
  const runMediaOperation = (operation: () => Promise<void>) => {
    try {
      void operation().catch(reportMediaOperationError);
    } catch (error) {
      reportMediaOperationError(error);
    }
  };

  const recomputeFromTime = (targetMs: number): { state: ReplayStableState; lastSeq: number } => {
    const snapshot = findSnapshotAtMost(index.snapshotsByTime, targetMs);
    let state = snapshot ? cloneState(snapshot.state) : cloneState(initial);
    let lastSeq = snapshot ? snapshot.eventSeq : 0;
    for (const event of index.stableEventsByTime) {
      if (event.timestampMs > targetMs) break;
      if (event.seq <= lastSeq) continue;
      state = replayReducer(state, event);
      lastSeq = Math.max(lastSeq, event.seq);
    }
    return { state, lastSeq };
  };

  const findFirstEventIndexAfterSeq = (lastSeq: number): number => {
    let lo = 0;
    let hi = index.eventsBySeq.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (index.eventsBySeq[mid].seq <= lastSeq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const currentMediaStatus = (): ReplaySchedulerState["mediaStatus"] => {
    if (!pkg?.media) return "none";
    if (!mediaAdapter) return "missing";
    return mediaAdapter.getStatus();
  };

  const noteMediaStatus = (mediaStatus: ReplaySchedulerState["mediaStatus"]) => {
    if (mediaStatus !== "stalled") {
      mediaBlockedSinceMs = null;
      mediaFallbackNotified = false;
      return 0;
    }
    const now = wallNow();
    if (mediaBlockedSinceMs === null) mediaBlockedSinceMs = now;
    const elapsedMs = now - mediaBlockedSinceMs;
    if (elapsedMs >= MEDIA_FALLBACK_THRESHOLD_MS && !mediaFallbackNotified) {
      mediaFallbackNotified = true;
      options.onMediaFallbackReady?.();
    }
    return elapsedMs;
  };

  const resolveFrame = (): {
    timelineTimeMs: number;
    driftMs: number;
    mediaStatus: ReplaySchedulerState["mediaStatus"];
    shouldAdvanceEvents: boolean;
    status: ReplaySchedulerState["status"];
  } => {
    const clockTimeMs = Math.max(0, clock.now());
    const mediaStatus = currentMediaStatus();
    const mediaWasBlocked = mediaBlockedSinceMs !== null;
    const blockedMs = noteMediaStatus(mediaStatus);

    if (mediaStatus === "stalled") {
      return {
        timelineTimeMs: schedulerState.timelineTimeMs,
        driftMs: schedulerState.driftMs,
        mediaStatus,
        shouldAdvanceEvents: false,
        status: blockedMs >= MEDIA_BUFFERING_THRESHOLD_MS ? "buffering" : schedulerState.status,
      };
    }

    if (mediaStatus !== "ready" || !mediaAdapter) {
      return {
        timelineTimeMs: clockTimeMs,
        driftMs: 0,
        mediaStatus,
        shouldAdvanceEvents: true,
        status: schedulerState.status === "buffering" ? "playing" : schedulerState.status,
      };
    }

    const readyMediaAdapter = mediaAdapter;
    runMediaOperation(() => readyMediaAdapter.flushPendingSeek());
    const mediaCurrentTimeSec = readyMediaAdapter.getCurrentTimeSec();
    const mediaTimelineMs =
      mediaCurrentTimeSec === null
        ? null
        : readyMediaAdapter.mediaToTimelineTime(mediaCurrentTimeSec);
    const recoveringFromStalled = mediaWasBlocked;

    if (mediaTimelineMs === null) {
      return {
        timelineTimeMs: clockTimeMs,
        driftMs: 0,
        mediaStatus,
        shouldAdvanceEvents: true,
        status: schedulerState.status === "buffering" ? "playing" : schedulerState.status,
      };
    }

    if (!recoveringFromStalled && readyMediaAdapter.timelineToMediaTime(clockTimeMs) === null) {
      return {
        timelineTimeMs: clockTimeMs,
        driftMs: 0,
        mediaStatus,
        shouldAdvanceEvents: true,
        status: schedulerState.status === "buffering" ? "playing" : schedulerState.status,
      };
    }

    const timelineTimeMs = Math.max(0, mediaTimelineMs);
    let driftMs = clockTimeMs - timelineTimeMs;
    if (recoveringFromStalled) {
      clock.setBase(timelineTimeMs);
      driftMs = 0;
    } else if (Math.abs(driftMs) > MEDIA_DRIFT_THRESHOLD_MS) {
      runMediaOperation(() => readyMediaAdapter.seek(clockTimeMs));
    }

    return {
      timelineTimeMs,
      driftMs,
      mediaStatus,
      shouldAdvanceEvents: true,
      status: schedulerState.status === "buffering" ? "playing" : schedulerState.status,
    };
  };

  const applyEventsUntil = (
    targetMs: number,
  ): { transientEvents: RecordingEvent[]; lastSeq: number } => {
    const transientEvents: RecordingEvent[] = [];
    let lastSeq = schedulerState.lastAppliedSeq;
    let cursor = nextEventIndex;
    for (; cursor < index.eventsBySeq.length; cursor += 1) {
      const event = index.eventsBySeq[cursor];
      if (event.seq <= lastSeq) continue;
      if (event.timestampMs > targetMs) break;
      if (
        event.type === "mouse-move" ||
        event.type === "mouse-click" ||
        event.type === "shortcut" ||
        event.type === "chapter-marker"
      ) {
        transientEvents.push(event);
      } else {
        stableState = replayReducer(stableState, event);
      }
      lastSeq = event.seq;
    }
    nextEventIndex = cursor;
    return { transientEvents, lastSeq };
  };

  const latestEventInWindow = (
    events: RecordingEvent[],
    targetMs: number,
    windowMs: number,
  ): RecordingEvent | null => {
    let latest: RecordingEvent | null = null;
    const minTimeMs = Math.max(0, targetMs - windowMs);
    for (const event of events) {
      if (event.timestampMs < minTimeMs || event.timestampMs > targetMs) continue;
      if (
        !latest ||
        event.timestampMs > latest.timestampMs ||
        (event.timestampMs === latest.timestampMs && event.seq > latest.seq)
      ) {
        latest = event;
      }
    }
    return latest;
  };

  const transientEventsForSeek = (targetMs: number): RecordingEvent[] => {
    const latestMove = latestEventInWindow(
      index.eventsByType.get("mouse-move") ?? [],
      targetMs,
      SEEK_POINTER_WINDOW_MS,
    );
    const latestClick = latestEventInWindow(
      index.eventsByType.get("mouse-click") ?? [],
      targetMs,
      SEEK_CLICK_WINDOW_MS,
    );
    const latestShortcut = latestEventInWindow(
      index.eventsByType.get("shortcut") ?? [],
      targetMs,
      SEEK_SHORTCUT_WINDOW_MS,
    );
    return [latestMove, latestClick, latestShortcut]
      .filter((event): event is RecordingEvent => Boolean(event))
      .sort((left, right) => left.timestampMs - right.timestampMs || left.seq - right.seq);
  };

  const tickOnce = () => {
    if (!pkg) return;
    const frame = resolveFrame();
    const now = frame.timelineTimeMs;
    if (frame.shouldAdvanceEvents && now < schedulerState.timelineTimeMs) {
      const { state, lastSeq } = recomputeFromTime(now);
      stableState = state;
      nextEventIndex = findFirstEventIndexAfterSeq(lastSeq);
      updateState({
        timelineTimeMs: Math.max(0, now),
        lastAppliedSeq: lastSeq,
        mediaStatus: frame.mediaStatus,
        driftMs: frame.driftMs,
        status: frame.status,
      });
      options.onTick?.(stableState, [], now);
      return;
    }
    if (!frame.shouldAdvanceEvents || now <= schedulerState.timelineTimeMs) {
      updateState({
        timelineTimeMs: Math.max(0, now),
        mediaStatus: frame.mediaStatus,
        driftMs: frame.driftMs,
        status: frame.status,
      });
      options.onTick?.(stableState, [], now);
      return;
    }
    const ended = pkg.meta.durationMs > 0 && now >= pkg.meta.durationMs;
    const eventTargetMs = ended ? pkg.meta.durationMs : now;
    const { transientEvents, lastSeq } = applyEventsUntil(eventTargetMs);
    updateState({
      timelineTimeMs: ended ? pkg.meta.durationMs : now,
      lastAppliedSeq: lastSeq,
      mediaStatus: frame.mediaStatus,
      driftMs: frame.driftMs,
      status: ended ? "ended" : frame.status,
    });
    if (ended) {
      tickStrategy.stop();
      driving = false;
    }
    options.onTick?.(stableState, transientEvents, schedulerState.timelineTimeMs);
  };

  const ensureDriving = () => {
    if (driving) return;
    driving = true;
    tickStrategy.start(tickOnce);
  };

  return {
    setMediaAdapter(adapter) {
      const adapterChanged = adapter !== mediaAdapter;
      mediaAdapter = adapter;
      if (adapterChanged) resetMediaBlock();
      adapter?.setRate(schedulerState.playbackRate);
      const mediaStatus = currentMediaStatus();
      if (mediaStatus === "ready" && adapter) {
        runMediaOperation(() => adapter.flushPendingSeek());
      }
      updateState({ mediaStatus });
    },
    async load(input) {
      pkg = input;
      index = buildReplayIndex(input);
      initial = buildInitialState(input);
      stableState = cloneState(initial);
      nextEventIndex = 0;
      tickStrategy.stop();
      driving = false;
      resetMediaBlock();
      updateState({
        status: "ready",
        timelineTimeMs: 0,
        lastAppliedSeq: 0,
        mediaStatus: currentMediaStatus(),
        driftMs: 0,
      });
    },
    play() {
      if (!pkg) return;
      if (schedulerState.status === "ended") {
        const { state, lastSeq } = recomputeFromTime(0);
        stableState = state;
        nextEventIndex = findFirstEventIndexAfterSeq(lastSeq);
        clock.setBase(0);
        const replayMediaAdapter = mediaAdapter;
        if (replayMediaAdapter) runMediaOperation(() => replayMediaAdapter.seek(0));
        updateState({
          status: "playing",
          timelineTimeMs: 0,
          lastAppliedSeq: lastSeq,
          mediaStatus: currentMediaStatus(),
          driftMs: 0,
        });
        options.onTick?.(stableState, transientEventsForSeek(0), 0);
      }
      clock.play();
      updateState({ status: "playing" });
      ensureDriving();
    },
    pause() {
      clock.pause();
      tickStrategy.stop();
      driving = false;
      updateState({ status: "paused" });
    },
    async seek(targetMs) {
      if (!pkg) return;
      const shouldResumePlayback =
        schedulerState.status === "playing" || schedulerState.status === "buffering";
      tickStrategy.stop();
      driving = false;
      updateState({ status: "seeking" });
      const clamped = Math.max(0, Math.min(targetMs, pkg.meta.durationMs));
      const { state, lastSeq } = recomputeFromTime(clamped);
      stableState = state;
      nextEventIndex = findFirstEventIndexAfterSeq(lastSeq);
      clock.setBase(clamped);
      if (mediaAdapter) await mediaAdapter.seek(clamped);
      updateState({
        timelineTimeMs: clamped,
        lastAppliedSeq: lastSeq,
        status: shouldResumePlayback ? "playing" : "paused",
        mediaStatus: currentMediaStatus(),
        driftMs: 0,
      });
      if (shouldResumePlayback) ensureDriving();
      options.onTick?.(stableState, transientEventsForSeek(clamped), clamped);
    },
    setRate(rate: ReplayPlaybackRate) {
      clock.setRate(rate);
      mediaAdapter?.setRate(rate);
      updateState({ playbackRate: rate });
    },
    setVolume(_volume) {
      /* Forwarded by the HTMLMediaElement driver — schedulerState doesn't track it. */
    },
    setMuted(_muted) {
      /* Forwarded by the HTMLMediaElement driver. */
    },
    destroy() {
      tickStrategy.stop();
      stateListeners.clear();
      driving = false;
      pkg = null;
    },
    subscribe(listener) {
      stateListeners.add(listener);
      listener(schedulerState);
      return () => stateListeners.delete(listener);
    },
    tick: tickOnce,
    getStableState: () => stableState,
  };
}

function emptyIndex() {
  return {
    eventsBySeq: [],
    eventsByType: new Map(),
    snapshotsByTime: [],
    stableEventsByTime: [],
    markersByTime: [],
    activityDensity: [],
  } as const as ReturnType<typeof buildReplayIndex>;
}

function emptyState(): ReplayStableState {
  return {
    editor: {
      code: "",
      language: "javascript",
      cursor: null,
      selection: null,
      scrollTop: 0,
      scrollLeft: 0,
      fontSize: 14,
      theme: "dark",
    },
    pointer: null,
    media: { microphoneEnabled: false, cameraEnabled: false, cameraPosition: { x: 0, y: 0 } },
    runtime: { status: "idle", stdout: [], stderr: [], previewHtml: null, errorMessage: null },
  };
}
