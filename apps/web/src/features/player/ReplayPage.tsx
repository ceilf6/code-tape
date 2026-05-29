import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Camera, Captions, CircleAlert, Keyboard, MousePointer2, TerminalSquare } from "lucide-react";
import { createReplayScheduler, defaultTickStrategy } from "./replayScheduler";
import { createTimelineClock } from "./timelineClock";
import { ReplayControls } from "./ReplayControls";
import { createMediaClockAdapter } from "./mediaClockAdapter";
import { CodeEditor } from "@/features/editor/CodeEditor";
import { PreviewPane } from "@/features/runtime-preview/PreviewPane";
import { createIframeRuntime } from "@/features/runtime-preview/iframeRuntime";
import { createRecordingStore } from "@/features/library/recordingStore";
import { createCloudRecordingRepository } from "@/features/cloud/cloudRecordingRepository";
import { SubtitlePanel } from "@/features/subtitles";
import { Toggle } from "@/shared/ui";
import type {
  PackageWarning,
  MediaTimelineSegment,
  PackageLoadResult,
  RecordingEvent,
  RecordingPackageV1,
  ReplaySchedulerState,
  ReplayStableState,
} from "@/shared/recording-schema";
import { createCloudPackageLoader } from "./cloudPackageLoader";

const INITIAL_SCHEDULER_STATE: ReplaySchedulerState = {
  status: "loading",
  timelineTimeMs: 0,
  playbackRate: 1,
  lastAppliedSeq: 0,
  mediaStatus: "none",
  driftMs: 0,
};

const INITIAL_STABLE_STATE: ReplayStableState = {
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

type ReplayOverlayState = {
  pointer: {
    id: string;
    xPercent: number;
    yPercent: number;
    clicked: boolean;
  } | null;
  shortcut: {
    id: string;
    label: string;
  } | null;
};

const EMPTY_OVERLAY_STATE: ReplayOverlayState = { pointer: null, shortcut: null };
const TRANSIENT_OVERLAY_TTL_MS = 900;
type RecordedMedia = NonNullable<RecordingPackageV1["media"]>;
const EVENT_ONLY_REPLAY_NOTICE = "音视频不可用，已切换为纯事件流回放";
type ReplayDisplayOptions = {
  pointer: boolean;
  shortcuts: boolean;
  camera: boolean;
  runtime: boolean;
  subtitles: boolean;
};
const DEFAULT_DISPLAY_OPTIONS: ReplayDisplayOptions = {
  pointer: true,
  shortcuts: true,
  camera: true,
  runtime: true,
  subtitles: true,
};
type ReplaySource = "local" | "cloud";
type ReplayPackageLoader = {
  load(recordingId: string): Promise<PackageLoadResult>;
};

function isEventOnlyMediaDegraded(
  pkg: RecordingPackageV1,
  mediaBlob: Blob | null,
  warnings: PackageWarning[],
): boolean {
  if (!pkg.media || mediaBlob) return false;
  return warnings.some((warning) => warning.code === "media-missing");
}

function parseInitialSeekTimeMs(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

/**
 * ReplayPage — wires the replay core (scheduler + clock + repository + runtime)
 * and renders the playback layout.
 */
export type ReplayPageProps = {
  source?: ReplaySource;
};

export function ReplayPage({ source = "local" }: ReplayPageProps) {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const initialSeekTimeMs = parseInitialSeekTimeMs(searchParams.get("t"));
  const packageLoader = useMemo<ReplayPackageLoader>(() => {
    if (source === "cloud") {
      return createCloudPackageLoader({ repository: createCloudRecordingRepository() });
    }
    return createRecordingStore();
  }, [source]);
  const runtime = useMemo(() => createIframeRuntime(), []);
  const [schedulerState, setSchedulerState] =
    useState<ReplaySchedulerState>(INITIAL_SCHEDULER_STATE);
  const [stableState, setStableState] = useState<ReplayStableState>(INITIAL_STABLE_STATE);
  const [overlayState, setOverlayState] = useState<ReplayOverlayState>(EMPTY_OVERLAY_STATE);
  const [pkg, setPkg] = useState<RecordingPackageV1 | null>(null);
  const [mediaBlob, setMediaBlob] = useState<Blob | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [eventOnlyNotice, setEventOnlyNotice] = useState(false);
  const [volume, setVolume] = useState(100);
  const [muted, setMuted] = useState(false);
  const [displayOptions, setDisplayOptions] =
    useState<ReplayDisplayOptions>(DEFAULT_DISPLAY_OPTIONS);
  const recordedMediaVideoRef = useRef<HTMLVideoElement | null>(null);
  const pointerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shortcutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentMedia = pkg?.media ?? null;
  const createRecordedMediaAdapter = useCallback((media: RecordedMedia) => {
    const segment = recordedMediaSegment(media);
    return createMediaClockAdapter({
      segments: segment ? [segment] : [],
      currentTimeProvider: () => recordedMediaVideoRef.current?.currentTime ?? null,
      metadataReadyProvider: () => isMediaMetadataReady(recordedMediaVideoRef.current),
      statusProvider: () => readRecordedMediaStatus(recordedMediaVideoRef.current),
      seekHandler: (_segment, mediaTimeMs) => {
        const video = recordedMediaVideoRef.current;
        if (!video) return;
        video.currentTime = mediaTimeMs / 1000;
      },
      rateHandler: (rate) => {
        if (recordedMediaVideoRef.current) recordedMediaVideoRef.current.playbackRate = rate;
      },
    });
  }, []);
  const mediaAdapter = useMemo(() => {
    if (!currentMedia || !mediaBlob) return null;
    return createRecordedMediaAdapter(currentMedia);
  }, [createRecordedMediaAdapter, currentMedia, mediaBlob]);
  const clearOverlayTimers = useCallback(() => {
    if (pointerTimerRef.current) clearTimeout(pointerTimerRef.current);
    if (shortcutTimerRef.current) clearTimeout(shortcutTimerRef.current);
  }, []);
  const scheduler = useMemo(() => {
    return createReplayScheduler({
      clock: createTimelineClock(),
      tickStrategy: defaultTickStrategy(),
      onTick: (state, transientEvents = []) => {
        setStableState(state);
        setOverlayState((current) => overlayStateFromEvents(current, transientEvents));
        scheduleOverlayCleanup(transientEvents, setOverlayState, pointerTimerRef, shortcutTimerRef);
      },
    });
  }, []);
  const syncSchedulerMediaStatus = useCallback(() => {
    scheduler.setMediaAdapter(mediaAdapter);
  }, [mediaAdapter, scheduler]);
  const playRecordedMedia = useCallback(() => {
    const video = recordedMediaVideoRef.current;
    if (!video) return;
    const targetMs = mediaAdapter?.timelineToMediaTime(schedulerState.timelineTimeMs) ?? null;
    if (targetMs === null) {
      video.pause();
      return;
    }
    void mediaAdapter?.seek(schedulerState.timelineTimeMs);
    void video.play().catch((err) => {
      console.warn("[replay-page] recorded media play failed:", err);
    });
  }, [mediaAdapter, schedulerState.timelineTimeMs]);
  const pauseRecordedMedia = useCallback(() => {
    recordedMediaVideoRef.current?.pause();
  }, []);
  const playReplay = useCallback(() => {
    playRecordedMedia();
    scheduler.play();
  }, [playRecordedMedia, scheduler]);
  const pauseReplay = useCallback(() => {
    pauseRecordedMedia();
    scheduler.pause();
  }, [pauseRecordedMedia, scheduler]);
  const setDisplayOption = useCallback(
    (key: keyof ReplayDisplayOptions, value: boolean) => {
      setDisplayOptions((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  useEffect(() => scheduler.subscribe(setSchedulerState), [scheduler]);
  useEffect(() => () => scheduler.destroy(), [scheduler]);
  useEffect(() => clearOverlayTimers, [clearOverlayTimers]);
  useEffect(() => {
    scheduler.setMediaAdapter(mediaAdapter);
  }, [mediaAdapter, scheduler]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoadError(null);
    setEventOnlyNotice(false);
    setPkg(null);
    setMediaBlob(null);
    setStableState(INITIAL_STABLE_STATE);
    setOverlayState(EMPTY_OVERLAY_STATE);
    clearOverlayTimers();
    recordedMediaVideoRef.current?.pause();
    (async () => {
      const result = await packageLoader.load(id);
      if (cancelled) return;
      if (!result.ok) {
        setLoadError(
          `${result.error.code}: ${"message" in result.error ? result.error.message : ""}`,
        );
        return;
      }
      const loadedMediaAdapter =
        result.package.media && result.mediaBlob
          ? createRecordedMediaAdapter(result.package.media)
          : null;
      scheduler.setMediaAdapter(loadedMediaAdapter);
      setPkg(result.package);
      setMediaBlob(result.mediaBlob);
      setEventOnlyNotice(
        isEventOnlyMediaDegraded(result.package, result.mediaBlob, result.warnings),
      );
      await scheduler.load(result.package);
      if (cancelled) return;
      if (initialSeekTimeMs !== null) await scheduler.seek(initialSeekTimeMs);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    clearOverlayTimers,
    createRecordedMediaAdapter,
    id,
    initialSeekTimeMs,
    packageLoader,
    scheduler,
  ]);

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-danger">加载失败：{loadError}</p>
        <Link to="/" className="text-xs text-muted underline underline-offset-2">
          返回库
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {eventOnlyNotice ? (
        <div
          role="status"
          aria-live="polite"
          className="border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-foreground"
        >
          <div className="flex items-center gap-2">
            <CircleAlert aria-hidden size={16} className="shrink-0 text-warning" />
            <span>{EVENT_ONLY_REPLAY_NOTICE}</span>
          </div>
        </div>
      ) : null}
      <ReplayDisplayToolbar options={displayOptions} onChange={setDisplayOption} />
      <div
        aria-label="回放工作区"
        className={
          displayOptions.runtime
            ? "grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[1fr_minmax(320px,420px)]"
            : "grid min-h-0 flex-1 grid-cols-1"
        }
      >
        <div className="relative min-h-0 border-r border-border">
          <CodeEditor
            language={stableState.editor.language}
            initialValue={stableState.editor.code}
            value={stableState.editor.code}
            fontSize={stableState.editor.fontSize}
            theme={stableState.editor.theme}
            readOnly
            cursor={stableState.editor.cursor}
            selection={stableState.editor.selection}
            scrollTop={stableState.editor.scrollTop}
            scrollLeft={stableState.editor.scrollLeft}
          />
          <ReplayVisualOverlays
            state={overlayState}
            showPointer={displayOptions.pointer}
            showShortcut={displayOptions.shortcuts}
          />
          <RecordedMediaOverlay
            videoRef={recordedMediaVideoRef}
            media={currentMedia}
            mediaBlob={mediaBlob}
            mediaState={stableState.media}
            schedulerState={schedulerState}
            volume={volume}
            muted={muted}
            showCameraLayer={displayOptions.camera}
            onStatusChange={syncSchedulerMediaStatus}
          />
        </div>
        {displayOptions.runtime ? (
          <div className="flex min-h-0 flex-col">
            <PreviewPane runtime={runtime} previewHtml={stableState.runtime.previewHtml} className="min-h-0 flex-1" />
            <RuntimeOutputPanel runtime={stableState.runtime} />
          </div>
        ) : null}
      </div>
      {displayOptions.subtitles ? (
        <SubtitlePanel
          recordingId={pkg?.meta.id ?? null}
          mediaBlob={mediaBlob}
          hasAudio={Boolean(pkg?.media?.hasAudio)}
          durationMs={pkg?.meta.durationMs ?? 0}
          currentTimeMs={schedulerState.timelineTimeMs}
          onSeek={(target) => scheduler.seek(target)}
          postProcessorContext={{
            language: stableState.editor.language,
            code: stableState.editor.code,
            runtimeOutput: replayRuntimeOutputText(stableState.runtime),
            glossary: DEFAULT_SUBTITLE_GLOSSARY,
          }}
        />
      ) : null}
      <ReplayControls
        state={schedulerState}
        durationMs={pkg?.meta.durationMs ?? 0}
        onPlayPause={() =>
          schedulerState.status === "playing" || schedulerState.status === "buffering"
            ? pauseReplay()
            : playReplay()
        }
        onSeek={(target) => scheduler.seek(target)}
        onRate={(rate) => scheduler.setRate(rate)}
        volume={volume}
        muted={muted}
        onVolume={(v) => {
          setVolume(v);
          scheduler.setVolume(v);
        }}
        onMuted={(m) => {
          setMuted(m);
          scheduler.setMuted(m);
        }}
      />
    </div>
  );
}

const DEFAULT_SUBTITLE_GLOSSARY = [
  "React",
  "Vue",
  "TypeScript",
  "JavaScript",
  "CSS",
  "Vite",
  "Monaco",
  "WebRTC",
  "IndexedDB",
  "code-tape",
  "RecordingPackageV1",
];

function replayRuntimeOutputText(runtime: ReplayStableState["runtime"]): string {
  return [...runtime.stdout, ...runtime.stderr, runtime.errorMessage]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function overlayStateFromEvents(
  current: ReplayOverlayState,
  transientEvents: RecordingEvent[],
): ReplayOverlayState {
  let next = current;
  let pointer: ReplayOverlayState["pointer"] = null;
  let pointerClicked = false;
  for (const event of transientEvents) {
    if (event.type === "mouse-move" || event.type === "mouse-click") {
      const { x, y, containerWidth, containerHeight } = event.payload;
      pointerClicked ||= event.type === "mouse-click";
      pointer = {
        id: event.id,
        xPercent: containerWidth > 0 ? (x / containerWidth) * 100 : 0,
        yPercent: containerHeight > 0 ? (y / containerHeight) * 100 : 0,
        clicked: event.type === "mouse-click",
      };
    }
    if (event.type === "shortcut") {
      next = {
        ...next,
        shortcut: {
          id: event.id,
          label: event.payload.label,
        },
      };
    }
  }
  if (pointer) {
    next = {
      ...next,
      pointer: { ...pointer, clicked: pointer.clicked || pointerClicked },
    };
  }
  return next;
}

function timelineToRecordedMediaTime(
  media: RecordingPackageV1["media"] | null,
  timelineTimeMs: number,
): number | null {
  if (!media) return null;
  const segment = recordedMediaSegment(media);
  if (!segment) return null;
  if (timelineTimeMs < segment.timelineStartMs || timelineTimeMs > segment.timelineEndMs) {
    return null;
  }
  return segment.mediaStartMs + (timelineTimeMs - segment.timelineStartMs);
}

function recordedMediaSegment(media: RecordedMedia): MediaTimelineSegment | null {
  const mediaStartMs = Math.max(0, media.timelineOffsetMs);
  if (mediaStartMs >= media.durationMs) return null;
  return {
    blobId: media.blobId,
    timelineStartMs: 0,
    timelineEndMs: media.durationMs - mediaStartMs,
    mediaStartMs,
    mediaEndMs: media.durationMs,
  };
}

function isMediaMetadataReady(video: HTMLVideoElement | null): boolean {
  return Boolean(video && !video.error && video.readyState >= 1);
}

function readRecordedMediaStatus(
  video: HTMLVideoElement | null,
): ReplaySchedulerState["mediaStatus"] {
  if (!video) return "loading";
  if (video.error) return "error";
  if (video.networkState === 3) return "missing";
  if (video.readyState < 1) return "loading";
  if (!video.paused && video.readyState < 3) return "stalled";
  return "ready";
}

function scheduleOverlayCleanup(
  transientEvents: RecordingEvent[],
  setOverlayState: Dispatch<SetStateAction<ReplayOverlayState>>,
  pointerTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
  shortcutTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
) {
  const hasPointer = transientEvents.some((event) => event.type === "mouse-move" || event.type === "mouse-click");
  const hasShortcut = transientEvents.some((event) => event.type === "shortcut");
  if (hasPointer) {
    if (pointerTimerRef.current) clearTimeout(pointerTimerRef.current);
    pointerTimerRef.current = setTimeout(() => {
      setOverlayState((current) => ({
        ...current,
        pointer: current.pointer ? { ...current.pointer, clicked: false } : null,
      }));
    }, TRANSIENT_OVERLAY_TTL_MS);
  }
  if (hasShortcut) {
    if (shortcutTimerRef.current) clearTimeout(shortcutTimerRef.current);
    shortcutTimerRef.current = setTimeout(() => {
      setOverlayState((current) => ({ ...current, shortcut: null }));
    }, TRANSIENT_OVERLAY_TTL_MS);
  }
}

function ReplayDisplayToolbar({
  options,
  onChange,
}: {
  options: ReplayDisplayOptions;
  onChange(key: keyof ReplayDisplayOptions, value: boolean): void;
}) {
  return (
    <div className="flex min-h-11 flex-wrap items-center gap-1 border-b border-border bg-background px-3 py-2">
      <Toggle
        pressed={options.pointer}
        onPressedChange={(pressed) => onChange("pointer", pressed)}
        label="显示鼠标轨迹"
        icon={<MousePointer2 size={17} />}
      />
      <Toggle
        pressed={options.shortcuts}
        onPressedChange={(pressed) => onChange("shortcuts", pressed)}
        label="显示快捷键"
        icon={<Keyboard size={17} />}
      />
      <Toggle
        pressed={options.camera}
        onPressedChange={(pressed) => onChange("camera", pressed)}
        label="显示摄像头"
        icon={<Camera size={17} />}
      />
      <Toggle
        pressed={options.runtime}
        onPressedChange={(pressed) => onChange("runtime", pressed)}
        label="显示运行面板"
        icon={<TerminalSquare size={17} />}
      />
      <Toggle
        pressed={options.subtitles}
        onPressedChange={(pressed) => onChange("subtitles", pressed)}
        label="显示字幕"
        icon={<Captions size={17} />}
      />
    </div>
  );
}

function ReplayVisualOverlays({
  state,
  showPointer,
  showShortcut,
}: {
  state: ReplayOverlayState;
  showPointer: boolean;
  showShortcut: boolean;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden">
      {showPointer && state.pointer ? (
        <div
          aria-label="回放鼠标位置"
          className="absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-primary/20 shadow-[0_0_24px_var(--ct-color-primary)]"
          style={{ left: `${state.pointer.xPercent}%`, top: `${state.pointer.yPercent}%` }}
        >
          {state.pointer.clicked ? (
            <span className="absolute inset-[-10px] rounded-full border border-primary/70 animate-ping" />
          ) : null}
        </div>
      ) : null}
      {showShortcut && state.shortcut ? (
        <div
          aria-label="回放快捷键"
          className="absolute bottom-4 right-4 rounded-md border border-border bg-popover px-3 py-2 font-mono text-sm text-popover-foreground shadow-elevation-2"
        >
          {state.shortcut.label}
        </div>
      ) : null}
    </div>
  );
}

function RecordedMediaOverlay({
  videoRef,
  media,
  mediaBlob,
  mediaState,
  schedulerState,
  volume,
  muted,
  showCameraLayer,
  onStatusChange,
}: {
  videoRef: MutableRefObject<HTMLVideoElement | null>;
  media: RecordingPackageV1["media"];
  mediaBlob: Blob | null;
  mediaState: ReplayStableState["media"];
  schedulerState: ReplaySchedulerState;
  volume: number;
  muted: boolean;
  showCameraLayer: boolean;
  onStatusChange(): void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const hasMedia = Boolean(media && mediaBlob);
  const hasCamera = Boolean(media?.hasCamera);
  const activeMediaTimeMs = timelineToRecordedMediaTime(media, schedulerState.timelineTimeMs);
  const isMediaSegmentActive = hasMedia && activeMediaTimeMs !== null;
  const showCamera = showCameraLayer && isMediaSegmentActive && hasCamera && mediaState.cameraEnabled;

  useEffect(() => {
    if (!mediaBlob || typeof URL.createObjectURL !== "function") {
      setSrc(null);
      return undefined;
    }
    const url = URL.createObjectURL(mediaBlob);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [mediaBlob]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = Math.max(0, Math.min(volume, 100)) / 100;
    video.muted = muted;
  }, [volume, muted, videoRef]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!isMediaSegmentActive) {
      video.pause();
      return;
    }
    if (schedulerState.status === "playing" || schedulerState.status === "buffering") {
      void video.play().catch((err) => {
        console.warn("[replay-page] recorded media play failed:", err);
      });
    } else {
      video.pause();
    }
  }, [isMediaSegmentActive, schedulerState.status, src, videoRef]);

  useEffect(() => {
    onStatusChange();
  }, [onStatusChange, src]);

  if (!src || !hasMedia) return null;

  const style = {
    left: `${mediaState.cameraPosition.x * 100}%`,
    top: `${mediaState.cameraPosition.y * 100}%`,
    transform: `translate(-${mediaState.cameraPosition.x * 100}%, -${mediaState.cameraPosition.y * 100}%)`,
  };

  return (
    <div
      className={
        showCamera
          ? "pointer-events-none absolute z-30 h-32 w-32 overflow-hidden rounded-full border border-border bg-surface-raised shadow-elevation-2"
          : "sr-only"
      }
      style={showCamera ? style : undefined}
    >
      <video
        ref={videoRef}
        aria-label={hasCamera ? "录制摄像头视频" : "录制音频"}
        src={src}
        className="h-full w-full object-cover"
        playsInline
        onLoadedMetadata={onStatusChange}
        onCanPlay={onStatusChange}
        onPlaying={onStatusChange}
        onWaiting={onStatusChange}
        onStalled={onStatusChange}
        onError={onStatusChange}
      />
    </div>
  );
}

function RuntimeOutputPanel({ runtime }: { runtime: ReplayStableState["runtime"] }) {
  const hasOutput = runtime.stdout.length > 0 || runtime.stderr.length > 0 || runtime.errorMessage;

  return (
    <section className="border-t border-border bg-background px-4 py-3" aria-label="Runtime output">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Console</h2>
        <span className="rounded-sm border border-border px-2 py-0.5 text-[11px] font-medium text-muted">
          {runtime.status}
        </span>
      </div>
      {hasOutput ? (
        <div className="max-h-40 space-y-2 overflow-auto font-mono text-xs leading-5">
          {runtime.stdout.map((line, index) => (
            <pre key={`stdout-${index}`} className="whitespace-pre-wrap text-foreground">
              {line}
            </pre>
          ))}
          {runtime.stderr.map((line, index) => (
            <pre key={`stderr-${index}`} className="whitespace-pre-wrap text-warning">
              {line}
            </pre>
          ))}
          {runtime.errorMessage ? (
            <pre className="whitespace-pre-wrap text-danger">{runtime.errorMessage}</pre>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted">No output</p>
      )}
    </section>
  );
}
