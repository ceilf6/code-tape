import { describe, expect, it, vi } from "vitest";
import { createMediaClockAdapter } from "../mediaClockAdapter";
import { createReplayScheduler } from "../replayScheduler";
import { createTimelineClock } from "../timelineClock";
import { buildInitialState } from "../initialState";
import { replayReducer } from "../replayReducer";
import type {
  MediaClockAdapter,
  RecordingEvent,
  RecordingPackageV1,
  RecordingSnapshot,
  ReplaySchedulerState,
  ReplayStableState,
} from "@/shared/recording-schema";
import { RECORDING_SCHEMA_VERSION } from "@/shared/recording-schema";

function content(seq: number, t: number, code: string): RecordingEvent {
  return {
    id: `e-${seq}`,
    seq,
    timestampMs: t,
    source: "editor",
    track: "main",
    type: "content-change",
    payload: {
      fileId: "main",
      version: seq,
      code,
      contentHash: code,
      language: "typescript",
      changeReason: "input",
      changeCount: 1,
      flushedBy: "debounce",
    },
  };
}

function countedContent(
  seq: number,
  t: number,
  code: string,
  counter: { reads: number },
): RecordingEvent {
  const event = content(seq, t, code);
  return {
    ...event,
    get seq() {
      counter.reads += 1;
      return seq;
    },
    get timestampMs() {
      counter.reads += 1;
      return t;
    },
  };
}

function shortcut(seq: number, t: number): RecordingEvent {
  return {
    id: `s-${seq}`,
    seq,
    timestampMs: t,
    source: "shortcut",
    track: "ui",
    type: "shortcut",
    payload: { keys: ["Cmd", "S"], label: "Save" },
  };
}

function pointerMove(seq: number, t: number, x = 40, y = 20): RecordingEvent {
  return {
    id: `move-${seq}`,
    seq,
    timestampMs: t,
    source: "pointer",
    track: "ui",
    type: "mouse-move",
    payload: { x, y, containerWidth: 100, containerHeight: 80 },
  };
}

function pointerClick(seq: number, t: number, x = 50, y = 25): RecordingEvent {
  return {
    id: `click-${seq}`,
    seq,
    timestampMs: t,
    source: "pointer",
    track: "ui",
    type: "mouse-click",
    payload: { x, y, containerWidth: 100, containerHeight: 80, button: 0 },
  };
}

function mediaWarning(seq: number, t: number): RecordingEvent {
  return {
    id: `e-${seq}`,
    seq,
    timestampMs: t,
    source: "media",
    track: "media",
    type: "media-warning",
    payload: {
      target: "recorder",
      code: "recorder-error",
      message: "Media could not be saved. Event timeline was preserved.",
    },
  };
}

function makePkg(
  events: RecordingEvent[],
  snapshots: RecordingSnapshot[] = [],
  durationMs = 10_000,
  withMedia = false,
): RecordingPackageV1 {
  return {
    schemaVersion: RECORDING_SCHEMA_VERSION,
    manifest: {
      packageId: "p",
      schemaVersion: RECORDING_SCHEMA_VERSION,
      status: "complete",
      createdAt: "2026-05-24T00:00:00.000Z",
      completedAt: null,
      checksums: { eventsSha256: "", snapshotsSha256: "" },
    },
    meta: {
      id: "rec",
      title: "t",
      createdAt: "2026-05-24T00:00:00.000Z",
      durationMs,
      appVersion: "0",
      ownerId: null,
      creatorInfo: null,
      initialLanguage: "javascript",
      initialFontSize: 14,
      initialTheme: "dark",
      mediaCapability: {
        audio: "available",
        camera: "available",
        selectedAudioDeviceId: null,
        selectedCameraDeviceId: null,
      },
    },
    events,
    snapshots,
    media: withMedia
      ? {
          blobId: "media-1",
          mimeType: "video/webm",
          durationMs,
          sizeBytes: 1024,
          timelineOffsetMs: 0,
          hasAudio: true,
          hasCamera: true,
        }
      : null,
  };
}

function replayFromZeroTo(pkg: RecordingPackageV1, targetMs: number): ReplayStableState {
  let state = buildInitialState(pkg);
  for (const event of pkg.events) {
    if (event.timestampMs > targetMs) break;
    state = replayReducer(state, event);
  }
  return state;
}

type TestMediaAdapter = MediaClockAdapter & {
  getStatus(): ReplaySchedulerState["mediaStatus"];
  getCurrentTimeSec(): number | null;
  flushPendingSeek?(): Promise<void>;
};

function testMediaAdapter({
  currentTimeSec,
  status = "ready",
  seek = vi.fn(async () => {}),
}: {
  currentTimeSec: () => number | null;
  status?: ReplaySchedulerState["mediaStatus"];
  seek?: (targetTimeMs: number) => Promise<void>;
}): TestMediaAdapter {
  return {
    segments: [
      {
        blobId: "media-1",
        timelineStartMs: 0,
        timelineEndMs: 10_000,
        mediaStartMs: 0,
        mediaEndMs: 10_000,
      },
    ],
    timelineToMediaTime(targetTimeMs) {
      return targetTimeMs;
    },
    mediaToTimelineTime(mediaCurrentTimeSec) {
      return mediaCurrentTimeSec * 1000;
    },
    seek,
    setRate: vi.fn(),
    getStatus: () => status,
    getCurrentTimeSec: currentTimeSec,
    flushPendingSeek: vi.fn(async () => {}),
  };
}

function watchState(scheduler: { subscribe(listener: (state: ReplaySchedulerState) => void): () => void }) {
  let latest: ReplaySchedulerState | null = null;
  scheduler.subscribe((state) => {
    latest = state;
  });
  return () => {
    if (!latest) throw new Error("scheduler did not publish state");
    return latest;
  };
}

describe("createReplayScheduler", () => {
  it("INVARIANT: replay-from-zero produces the same stable state as seek(t)", async () => {
    const events: RecordingEvent[] = [];
    let code = "";
    for (let seq = 1; seq <= 60; seq += 1) {
      code += `line ${seq}\n`;
      events.push(content(seq, seq * 100, code));
      if (seq % 5 === 0) events.push(shortcut(events.length + 100, seq * 100 + 10));
    }
    events.sort((a, b) => a.seq - b.seq);
    events.forEach((e, idx) => {
      e.seq = idx + 1;
    });

    const pkg = makePkg(events, [], 10_000);
    const clock = createTimelineClock({ nowProvider: () => 0 });
    const scheduler = createReplayScheduler({
      clock,
      tickStrategy: { start: () => {}, stop: () => {} },
    });
    await scheduler.load(pkg);

    for (const target of [0, 500, 1500, 3300, 5000, 8888, 10_000]) {
      await scheduler.seek(target);
      const fromSeek = scheduler.getStableState();
      const fromZero = replayFromZeroTo(pkg, target);
      expect(fromSeek.editor.code).toBe(fromZero.editor.code);
      expect(fromSeek.editor.language).toBe(fromZero.editor.language);
    }
  });

  it("INVARIANT: seek lands on the inclusive snapshot when present, then applies later events", async () => {
    const events: RecordingEvent[] = [
      content(1, 100, "a"),
      content(2, 200, "ab"),
      content(3, 400, "abc"),
      content(4, 600, "abcd"),
    ];
    const snapshotState: ReplayStableState = {
      ...buildInitialState(makePkg([])),
      editor: {
        code: "ab",
        language: "typescript",
        cursor: null,
        selection: null,
        scrollTop: 0,
        scrollLeft: 0,
        fontSize: 14,
        theme: "dark",
      },
    };
    const snapshot: RecordingSnapshot = {
      id: "snap-1",
      timestampMs: 200,
      eventSeq: 2,
      state: snapshotState,
    };
    const pkg = makePkg(events, [snapshot], 1000);
    const scheduler = createReplayScheduler({
      tickStrategy: { start: () => {}, stop: () => {} },
    });
    await scheduler.load(pkg);

    await scheduler.seek(500);
    const at500 = scheduler.getStableState();
    expect(at500.editor.code).toBe("abc");

    await scheduler.seek(700);
    const at700 = scheduler.getStableState();
    expect(at700.editor.code).toBe("abcd");
  });

  it("status transitions ready → playing → paused → ended", async () => {
    let wall = 0;
    const clock = createTimelineClock({ nowProvider: () => wall });
    const pkg = makePkg([content(1, 100, "a")], [], 500);
    const scheduler = createReplayScheduler({
      clock,
      tickStrategy: { start: () => {}, stop: () => {} },
    });
    const seen: string[] = [];
    scheduler.subscribe((s) => seen.push(s.status));
    await scheduler.load(pkg);
    scheduler.play();
    wall = 200;
    scheduler.tick();
    scheduler.pause();
    expect(seen).toContain("ready");
    expect(seen).toContain("playing");
    expect(seen).toContain("paused");

    scheduler.play();
    wall += 600; // advance wall enough to push timeline past duration
    scheduler.tick();
    expect(scheduler.getStableState().editor.code).toBe("a");
    expect(seen).toContain("ended");
  });

  it("does not rescan already-applied events on later playback ticks", async () => {
    const counter = { reads: 0 };
    const events = Array.from({ length: 1_000 }, (_, index) =>
      countedContent(index + 1, index + 1, `line ${index + 1}`, counter),
    );
    let wall = 0;
    const clock = createTimelineClock({ nowProvider: () => wall });
    const scheduler = createReplayScheduler({
      clock,
      tickStrategy: { start: () => {}, stop: () => {} },
    });
    const latest = watchState(scheduler);
    await scheduler.load(makePkg(events, [], 2_000));

    scheduler.play();
    wall = 1_000;
    scheduler.tick();
    expect(latest().lastAppliedSeq).toBe(1_000);

    counter.reads = 0;
    wall = 1_001;
    scheduler.tick();

    expect(latest().lastAppliedSeq).toBe(1_000);
    expect(counter.reads).toBeLessThan(20);
  });

  it("uses ready media currentTime as the main replay clock", async () => {
    let wall = 0;
    let mediaCurrentTimeSec = 0;
    const clock = createTimelineClock({ nowProvider: () => wall });
    const scheduler = createReplayScheduler({
      clock,
      mediaAdapter: testMediaAdapter({
        currentTimeSec: () => mediaCurrentTimeSec,
      }) as never,
      tickStrategy: { start: () => {}, stop: () => {} },
    });
    const latest = watchState(scheduler);
    await scheduler.load(makePkg([content(1, 1000, "media-driven")], [], 5000, true));

    scheduler.play();
    wall = 1250;
    mediaCurrentTimeSec = 1.2;
    scheduler.tick();

    expect(latest().mediaStatus).toBe("ready");
    expect(latest().timelineTimeMs).toBe(1200);
    expect(latest().driftMs).toBe(50);
    expect(scheduler.getStableState().editor.code).toBe("media-driven");
  });

  it("uses the production media adapter to map HTMLMediaElement seconds to timeline milliseconds", async () => {
    let wall = 0;
    const clock = createTimelineClock({ nowProvider: () => wall });
    const adapter = createMediaClockAdapter({
      segments: [
        {
          blobId: "media-1",
          timelineStartMs: 0,
          timelineEndMs: 5000,
          mediaStartMs: 0,
          mediaEndMs: 5000,
        },
      ],
      currentTimeProvider: () => 1.2,
      statusProvider: () => "ready",
    });
    const scheduler = createReplayScheduler({
      clock,
      mediaAdapter: adapter,
      tickStrategy: { start: () => {}, stop: () => {} },
    });
    const latest = watchState(scheduler);
    await scheduler.load(makePkg([], [], 5000, true));

    scheduler.play();
    wall = 1250;
    scheduler.tick();

    expect(latest().timelineTimeMs).toBe(1200);
    expect(latest().driftMs).toBe(50);
  });

  it("uses the timeline clock before an offset media segment starts", async () => {
    let wall = 0;
    const clock = createTimelineClock({ nowProvider: () => wall });
    const adapter = createMediaClockAdapter({
      segments: [
        {
          blobId: "media-1",
          timelineStartMs: 1000,
          timelineEndMs: 2000,
          mediaStartMs: 0,
          mediaEndMs: 1000,
        },
      ],
      currentTimeProvider: () => 0,
      statusProvider: () => "ready",
    });
    const scheduler = createReplayScheduler({
      clock,
      mediaAdapter: adapter,
      tickStrategy: { start: () => {}, stop: () => {} },
    });
    const latest = watchState(scheduler);
    await scheduler.load(
      makePkg([content(1, 500, "before-media"), content(2, 1000, "media-start")], [], 5000, true),
    );

    scheduler.play();
    wall = 500;
    scheduler.tick();

    expect(latest().mediaStatus).toBe("ready");
    expect(latest().timelineTimeMs).toBe(500);
    expect(latest().driftMs).toBe(0);
    expect(scheduler.getStableState().editor.code).toBe("before-media");
  });

  it("keeps applying pure events after the media segment ends", async () => {
    let wall = 0;
    const clock = createTimelineClock({ nowProvider: () => wall });
    const adapter = createMediaClockAdapter({
      segments: [
        {
          blobId: "media-1",
          timelineStartMs: 1000,
          timelineEndMs: 2000,
          mediaStartMs: 0,
          mediaEndMs: 1000,
        },
      ],
      currentTimeProvider: () => 1,
      statusProvider: () => "ready",
    });
    const scheduler = createReplayScheduler({
      clock,
      mediaAdapter: adapter,
      tickStrategy: { start: () => {}, stop: () => {} },
    });
    const latest = watchState(scheduler);
    await scheduler.load(makePkg([content(1, 2400, "after-media")], [], 5000, true));

    scheduler.play();
    wall = 2500;
    scheduler.tick();

    expect(latest().mediaStatus).toBe("ready");
    expect(latest().timelineTimeMs).toBe(2500);
    expect(latest().driftMs).toBe(0);
    expect(scheduler.getStableState().editor.code).toBe("after-media");
  });

  it("rolls stable state back when media currentTime moves backward", async () => {
    let wall = 0;
    let mediaCurrentTimeSec = 0;
    const clock = createTimelineClock({ nowProvider: () => wall });
    const scheduler = createReplayScheduler({
      clock,
      mediaAdapter: testMediaAdapter({
        currentTimeSec: () => mediaCurrentTimeSec,
      }) as never,
      tickStrategy: { start: () => {}, stop: () => {} },
    });
    const latest = watchState(scheduler);
    await scheduler.load(makePkg([content(1, 1000, "after-event")], [], 5000, true));

    scheduler.play();
    wall = 1200;
    mediaCurrentTimeSec = 1.2;
    scheduler.tick();
    expect(scheduler.getStableState().editor.code).toBe("after-event");

    wall = 500;
    mediaCurrentTimeSec = 0.5;
    scheduler.tick();

    expect(latest().timelineTimeMs).toBe(500);
    expect(latest().lastAppliedSeq).toBe(0);
    expect(scheduler.getStableState().editor.code).toBe("");
  });

  it("does not seek media to stale clock time when stalled media becomes ready", async () => {
    let wall = 0;
    let schedulerWall = 0;
    let mediaStatus: ReplaySchedulerState["mediaStatus"] = "ready";
    let mediaCurrentTimeSec = 1;
    const seek = vi.fn(async () => {});
    const adapter = testMediaAdapter({
      currentTimeSec: () => mediaCurrentTimeSec,
      seek,
    });
    adapter.getStatus = () => mediaStatus;
    const clock = createTimelineClock({ nowProvider: () => wall });
    const scheduler = createReplayScheduler({
      clock,
      mediaAdapter: adapter as never,
      tickStrategy: { start: () => {}, stop: () => {} },
      wallNow: () => schedulerWall,
    });
    const latest = watchState(scheduler);
    await scheduler.load(makePkg([content(1, 1500, "skipped")], [], 5000, true));

    scheduler.play();
    wall = 1000;
    scheduler.tick();
    mediaStatus = "stalled";
    scheduler.tick();
    wall = 2000;
    schedulerWall = 700;
    scheduler.tick();
    mediaStatus = "ready";
    mediaCurrentTimeSec = 1;
    scheduler.setMediaAdapter(adapter as never);
    scheduler.tick();

    expect(seek).not.toHaveBeenCalled();
    expect(latest().timelineTimeMs).toBe(1000);
    expect(scheduler.getStableState().editor.code).toBe("");
  });

  it("falls back to the timeline clock when package media is missing", async () => {
    let wall = 0;
    const clock = createTimelineClock({ nowProvider: () => wall });
    const scheduler = createReplayScheduler({
      clock,
      tickStrategy: { start: () => {}, stop: () => {} },
    });
    const latest = watchState(scheduler);
    await scheduler.load(makePkg([content(1, 300, "timeline-fallback")], [], 5000, true));

    scheduler.play();
    wall = 400;
    scheduler.tick();

    expect(latest().mediaStatus).toBe("missing");
    expect(latest().timelineTimeMs).toBe(400);
    expect(scheduler.getStableState().editor.code).toBe("timeline-fallback");
  });

  it("plays an event-only package with media-warning using the timeline clock", async () => {
    let wall = 0;
    const clock = createTimelineClock({ nowProvider: () => wall });
    const scheduler = createReplayScheduler({
      clock,
      tickStrategy: { start: () => {}, stop: () => {} },
    });
    const latest = watchState(scheduler);
    await scheduler.load(makePkg([mediaWarning(1, 0), content(2, 300, "event-only")], [], 5000, false));

    scheduler.play();
    wall = 400;
    scheduler.tick();

    expect(latest().mediaStatus).toBe("none");
    expect(latest().timelineTimeMs).toBe(400);
    expect(scheduler.getStableState().editor.code).toBe("event-only");
  });

  it("records drift and asks the media adapter to correct large drift", async () => {
    let wall = 0;
    let mediaCurrentTimeSec = 0;
    const seek = vi.fn(async () => {});
    const clock = createTimelineClock({ nowProvider: () => wall });
    const scheduler = createReplayScheduler({
      clock,
      mediaAdapter: testMediaAdapter({
        currentTimeSec: () => mediaCurrentTimeSec,
        seek,
      }) as never,
      tickStrategy: { start: () => {}, stop: () => {} },
    });
    const latest = watchState(scheduler);
    await scheduler.load(makePkg([], [], 5000, true));

    scheduler.play();
    wall = 1600;
    mediaCurrentTimeSec = 1;
    scheduler.tick();

    expect(latest().timelineTimeMs).toBe(1000);
    expect(latest().driftMs).toBe(600);
    expect(seek).toHaveBeenCalledWith(1600);
  });

  it("clears stale drift after seek completes", async () => {
    let wall = 0;
    let mediaCurrentTimeSec = 0;
    const clock = createTimelineClock({ nowProvider: () => wall });
    const scheduler = createReplayScheduler({
      clock,
      mediaAdapter: testMediaAdapter({
        currentTimeSec: () => mediaCurrentTimeSec,
      }) as never,
      tickStrategy: { start: () => {}, stop: () => {} },
    });
    const latest = watchState(scheduler);
    await scheduler.load(makePkg([], [], 5000, true));

    scheduler.play();
    wall = 1600;
    mediaCurrentTimeSec = 1;
    scheduler.tick();
    expect(latest().driftMs).toBe(600);

    await scheduler.seek(1200);

    expect(latest().timelineTimeMs).toBe(1200);
    expect(latest().driftMs).toBe(0);
  });

  it("does not apply events beyond duration when ending after a clock overshoot", async () => {
    let wall = 0;
    const clock = createTimelineClock({ nowProvider: () => wall });
    const scheduler = createReplayScheduler({
      clock,
      tickStrategy: { start: () => {}, stop: () => {} },
    });
    const latest = watchState(scheduler);
    await scheduler.load(makePkg([content(1, 1200, "past-duration")], [], 1000));

    scheduler.play();
    wall = 1500;
    scheduler.tick();

    expect(latest().status).toBe("ended");
    expect(latest().timelineTimeMs).toBe(1000);
    expect(latest().lastAppliedSeq).toBe(0);
    expect(scheduler.getStableState().editor.code).toBe("");
  });

  it("restores playback after seek when replay was playing", async () => {
    let wall = 0;
    const start = vi.fn();
    const stop = vi.fn();
    const clock = createTimelineClock({ nowProvider: () => wall });
    const scheduler = createReplayScheduler({
      clock,
      tickStrategy: { start, stop },
    });
    const latest = watchState(scheduler);
    await scheduler.load(makePkg([content(1, 1000, "after-seek")], [], 5000));

    scheduler.play();
    await scheduler.seek(900);

    expect(latest().status).toBe("playing");
    expect(start).toHaveBeenCalledTimes(2);

    wall = 300;
    scheduler.tick();

    expect(latest().timelineTimeMs).toBe(1200);
    expect(scheduler.getStableState().editor.code).toBe("after-seek");
  });

  it("keeps replay paused after seek when replay was paused", async () => {
    const scheduler = createReplayScheduler({
      tickStrategy: { start: vi.fn(), stop: vi.fn() },
    });
    const latest = watchState(scheduler);
    await scheduler.load(makePkg([content(1, 1000, "paused-seek")], [], 5000));

    await scheduler.seek(1200);

    expect(latest().status).toBe("paused");
    expect(scheduler.getStableState().editor.code).toBe("paused-seek");
  });

  it("replays recent transient pointer and shortcut overlays after seek", async () => {
    const transientTicks: RecordingEvent[][] = [];
    const scheduler = createReplayScheduler({
      tickStrategy: { start: vi.fn(), stop: vi.fn() },
      onTick: (_state, transientEvents) => {
        transientTicks.push(transientEvents);
      },
    });
    await scheduler.load(
      makePkg(
        [
          pointerMove(1, 900),
          shortcut(2, 1_000),
          pointerClick(3, 1_400),
          content(4, 1_600, "after-stable"),
        ],
        [],
        5_000,
      ),
    );

    await scheduler.seek(1_850);

    expect(transientTicks.at(-1)?.map((event) => event.id)).toEqual(["move-1", "s-2", "click-3"]);
    expect(scheduler.getStableState().editor.code).toBe("after-stable");
  });

  it("keeps recent click and later pointer move overlays after seek", async () => {
    const transientTicks: RecordingEvent[][] = [];
    const scheduler = createReplayScheduler({
      tickStrategy: { start: vi.fn(), stop: vi.fn() },
      onTick: (_state, transientEvents) => {
        transientTicks.push(transientEvents);
      },
    });
    await scheduler.load(
      makePkg(
        [
          pointerClick(1, 1_000),
          pointerMove(2, 1_250, 70, 40),
          content(3, 1_600, "after-stable"),
        ],
        [],
        5_000,
      ),
    );

    await scheduler.seek(1_450);

    expect(transientTicks.at(-1)?.map((event) => event.id)).toEqual(["click-1", "move-2"]);
  });

  it("handles rejected async media operations during ready ticks", async () => {
    let wall = 0;
    let mediaCurrentTimeSec = 0;
    const flushError = new Error("flush failed");
    const seekError = new Error("seek failed");
    const seek = vi.fn(async () => {
      throw seekError;
    });
    const adapter = testMediaAdapter({
      currentTimeSec: () => mediaCurrentTimeSec,
      seek,
    });
    adapter.flushPendingSeek = vi.fn(async () => {
      throw flushError;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const clock = createTimelineClock({ nowProvider: () => wall });
    const scheduler = createReplayScheduler({
      clock,
      mediaAdapter: adapter as never,
      tickStrategy: { start: () => {}, stop: () => {} },
    });

    await scheduler.load(makePkg([], [], 5000, true));
    scheduler.play();
    wall = 500;
    mediaCurrentTimeSec = 0;
    scheduler.tick();
    await Promise.resolve();

    try {
      expect(warn).toHaveBeenCalledWith(
        "[replay-scheduler] media operation failed:",
        flushError,
      );
      expect(warn).toHaveBeenCalledWith("[replay-scheduler] media operation failed:", seekError);
    } finally {
      warn.mockRestore();
    }
  });

  it("enters buffering and stops applying events after media is stalled for 500ms", async () => {
    let wall = 0;
    let schedulerWall = 0;
    const clock = createTimelineClock({ nowProvider: () => wall });
    const scheduler = createReplayScheduler({
      clock,
      mediaAdapter: testMediaAdapter({
        currentTimeSec: () => 0,
        status: "stalled",
      }) as never,
      tickStrategy: { start: () => {}, stop: () => {} },
      wallNow: () => schedulerWall,
    } as never);
    const latest = watchState(scheduler);
    await scheduler.load(makePkg([content(1, 100, "should-not-advance")], [], 5000, true));

    scheduler.play();
    wall = 700;
    scheduler.tick();
    schedulerWall = 600;
    scheduler.tick();

    expect(latest().mediaStatus).toBe("stalled");
    expect(latest().status).toBe("buffering");
    expect(latest().timelineTimeMs).toBe(0);
    expect(scheduler.getStableState().editor.code).toBe("");
  });

  it("exposes a pure-event fallback callback after media is stalled for 2s", async () => {
    const wall = 0;
    let schedulerWall = 0;
    const onMediaFallbackReady = vi.fn();
    const clock = createTimelineClock({ nowProvider: () => wall });
    const scheduler = createReplayScheduler({
      clock,
      mediaAdapter: testMediaAdapter({
        currentTimeSec: () => 0,
        status: "stalled",
      }) as never,
      tickStrategy: { start: () => {}, stop: () => {} },
      wallNow: () => schedulerWall,
      onMediaFallbackReady,
    } as never);
    await scheduler.load(makePkg([], [], 5000, true));

    scheduler.play();
    scheduler.tick();
    schedulerWall = 2100;
    scheduler.tick();
    scheduler.tick();

    expect(onMediaFallbackReady).toHaveBeenCalledTimes(1);
  });

  it("resets stalled media timers when loading a new package", async () => {
    const wall = 0;
    let schedulerWall = 0;
    const clock = createTimelineClock({ nowProvider: () => wall });
    const scheduler = createReplayScheduler({
      clock,
      mediaAdapter: testMediaAdapter({
        currentTimeSec: () => 0,
        status: "stalled",
      }) as never,
      tickStrategy: { start: () => {}, stop: () => {} },
      wallNow: () => schedulerWall,
    } as never);
    const latest = watchState(scheduler);

    await scheduler.load(makePkg([], [], 5000, true));
    scheduler.play();
    scheduler.tick();
    schedulerWall = 700;
    scheduler.tick();
    expect(latest().status).toBe("buffering");

    await scheduler.load(makePkg([], [], 5000, true));
    scheduler.play();
    scheduler.tick();

    expect(latest().status).toBe("playing");
  });

  it("flushes a pending media seek when metadata becomes ready while replay is paused", async () => {
    let metadataReady = false;
    const seekHandler = vi.fn();
    const adapter = createMediaClockAdapter({
      segments: [
        {
          blobId: "media-1",
          timelineStartMs: 0,
          timelineEndMs: 5000,
          mediaStartMs: 0,
          mediaEndMs: 5000,
        },
      ],
      metadataReadyProvider: () => metadataReady,
      statusProvider: () => (metadataReady ? "ready" : "loading"),
      seekHandler,
    });
    const scheduler = createReplayScheduler({
      mediaAdapter: adapter,
      tickStrategy: { start: () => {}, stop: () => {} },
    });
    await scheduler.load(makePkg([], [], 5000, true));

    await scheduler.seek(1800);
    expect(seekHandler).not.toHaveBeenCalled();

    metadataReady = true;
    scheduler.setMediaAdapter(adapter);

    expect(seekHandler).toHaveBeenCalledWith(adapter.segments[0], 1800);
  });

  it("applies the current playback rate when a media adapter is attached", async () => {
    const setRate = vi.fn();
    const adapter = testMediaAdapter({
      currentTimeSec: () => 0,
      status: "ready",
    });
    adapter.setRate = setRate;
    const scheduler = createReplayScheduler({
      tickStrategy: { start: () => {}, stop: () => {} },
    });
    await scheduler.load(makePkg([], [], 5000, true));

    scheduler.setRate(2);
    scheduler.setMediaAdapter(adapter as never);

    expect(setRate).toHaveBeenCalledWith(2);
  });
});
