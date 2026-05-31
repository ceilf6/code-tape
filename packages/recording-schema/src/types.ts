/*
 * Recording schema — single source of truth for recording packages.
 *
 * Authority: docs/技术方案.md §4 (录制包与事件模型) + §5/§6/§7/§9 接口签名。
 * 任何字段变更必须先在 docs/技术方案.md 同步更新并在 ADR 注册。
 *
 * Only pure data / capability shapes live here. Monaco-/React-/DOM-specific
 * dependencies belong in their feature folders.
 */

export const RECORDING_SCHEMA_VERSION = "0.1.0" as const;
export type RecordingSchemaVersion = typeof RECORDING_SCHEMA_VERSION;

// ─────────────────────────────────────────────────────────────────────────────
// Meta / Manifest / Media / Indexes
// ─────────────────────────────────────────────────────────────────────────────

export type RecordingLanguage = "javascript" | "typescript" | "python" | "html" | "css";
export type RecordingTheme = "light" | "dark";

export type MediaCapability = {
  audio: "available" | "denied" | "not-found" | "busy" | "unsupported";
  camera: "available" | "denied" | "not-found" | "busy" | "unsupported";
  selectedAudioDeviceId: string | null;
  selectedCameraDeviceId: string | null;
};

export type RecordingMeta = {
  id: string;
  title: string;
  createdAt: string;
  durationMs: number;
  appVersion: string;
  ownerId: string | null;
  creatorInfo: { displayName: string; source: "local" | "account" } | null;
  initialLanguage: RecordingLanguage;
  initialFontSize: number;
  initialTheme: RecordingTheme;
  mediaCapability: MediaCapability;
};

export type RecordingMedia = {
  blobId: string;
  mimeType: string;
  durationMs: number;
  sizeBytes: number;
  timelineOffsetMs: number;
  hasAudio: boolean;
  hasCamera: boolean;
};

export type RecordingManifest = {
  packageId: string;
  schemaVersion: RecordingSchemaVersion;
  status: "draft" | "complete";
  createdAt: string;
  completedAt: string | null;
  checksums: {
    eventsSha256: string;
    snapshotsSha256: string;
    mediaSha256?: string;
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Event envelope + payloads
// ─────────────────────────────────────────────────────────────────────────────

export type RecordingEventType =
  | "record-start"
  | "record-pause"
  | "record-resume"
  | "resume-baseline"
  | "record-stop"
  | "content-change"
  | "language-change"
  | "selection-change"
  | "editor-scroll"
  | "mouse-move"
  | "mouse-click"
  | "shortcut"
  | "media-toggle"
  | "media-warning"
  | "camera-position"
  | "run-start"
  | "run-output"
  | "run-error"
  | "chapter-marker";

export type RecordingEventSource =
  | "recorder"
  | "editor"
  | "pointer"
  | "shortcut"
  | "media"
  | "runtime"
  | "annotation";

export type RecordingEventTrack = "main" | "media" | "runtime" | "ui";

export type BaseRecordingEvent<
  TType extends RecordingEventType,
  TSource extends RecordingEventSource,
  TTrack extends RecordingEventTrack,
  TPayload,
> = {
  id: string;
  seq: number;
  timestampMs: number;
  wallTime?: string;
  source: TSource;
  track: TTrack;
  type: TType;
  payload: TPayload;
};

// — Recorder lifecycle —

export type RecordStartPayload = {
  initialLanguage: RecordingLanguage;
  initialTheme: RecordingTheme;
  initialFontSize: number;
  selectedAudioDeviceId: string | null;
  selectedCameraDeviceId: string | null;
  mediaCapability: MediaCapability;
};

export type RecordPausePayload = { reason: "user"; stateSeq: number };
export type RecordResumePayload = { reason: "user"; baselineSnapshotId?: string };
export type RecordStopPayload = { durationMs: number; reason: "user" | "error" };
export type ResumeBaselinePayload = { snapshot: ReplayStableState; reason: "paused-state-changed" };

// — Editor —

export type ContentChangePayload = {
  fileId: "main";
  version: number;
  code: string;
  contentHash: string;
  language: RecordingLanguage;
  changeReason: "input" | "paste" | "format" | "undo" | "redo" | "programmatic";
  changeCount: number;
  flushedBy: "debounce" | "idle" | "paste" | "format" | "undo" | "redo" | "run" | "pause" | "stop" | "snapshot";
};

export type LanguageChangePayload = { from: RecordingLanguage; to: RecordingLanguage };

export type SelectionChangePayload = {
  cursor: { lineNumber: number; column: number } | null;
  selection: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  } | null;
};

export type EditorScrollPayload = { scrollTop: number; scrollLeft: number };

// — Pointer / shortcut —

export type PointerPayload = { x: number; y: number; containerWidth: number; containerHeight: number };
export type PointerClickPayload = PointerPayload & { button: 0 | 1 | 2 };
export type ShortcutPayload = { keys: string[]; label: string; command?: string };

// — Media —

export type MediaTogglePayload = { microphoneEnabled: boolean; cameraEnabled: boolean };

export type MediaWarningPayload = {
  target: "audio" | "camera" | "recorder";
  code: "permission-denied" | "not-found" | "busy" | "unsupported" | "track-ended" | "recorder-error";
  message: string;
};

export type CameraPositionPayload = { x: number; y: number };

// — Runtime —

export type RunStartPayload = {
  language: "javascript" | "typescript" | "html" | "css";
  runtime: "iframe";
  runId: string;
};

export type RunOutputPayload = {
  runId: string;
  stdout: string[];
  stderr: string[];
  previewHtml: string | null;
  status: "success";
};

export type RunErrorPayload = {
  runId: string;
  phase: "transpile" | "runtime";
  message: string;
  stack?: string;
  stdout: string[];
  stderr: string[];
  previewHtml: string | null;
};

// — Annotation —

export type ChapterMarkerPayload = { title: string; note?: string };

// — Event union —

export type RecordingEvent =
  | BaseRecordingEvent<"record-start", "recorder", "main", RecordStartPayload>
  | BaseRecordingEvent<"record-pause", "recorder", "main", RecordPausePayload>
  | BaseRecordingEvent<"record-resume", "recorder", "main", RecordResumePayload>
  | BaseRecordingEvent<"resume-baseline", "recorder", "main", ResumeBaselinePayload>
  | BaseRecordingEvent<"record-stop", "recorder", "main", RecordStopPayload>
  | BaseRecordingEvent<"content-change", "editor", "main", ContentChangePayload>
  | BaseRecordingEvent<"language-change", "editor", "main", LanguageChangePayload>
  | BaseRecordingEvent<"selection-change", "editor", "main", SelectionChangePayload>
  | BaseRecordingEvent<"editor-scroll", "editor", "main", EditorScrollPayload>
  | BaseRecordingEvent<"mouse-move", "pointer", "ui", PointerPayload>
  | BaseRecordingEvent<"mouse-click", "pointer", "ui", PointerClickPayload>
  | BaseRecordingEvent<"shortcut", "shortcut", "ui", ShortcutPayload>
  | BaseRecordingEvent<"media-toggle", "media", "media", MediaTogglePayload>
  | BaseRecordingEvent<"media-warning", "media", "media", MediaWarningPayload>
  | BaseRecordingEvent<"camera-position", "media", "ui", CameraPositionPayload>
  | BaseRecordingEvent<"run-start", "runtime", "runtime", RunStartPayload>
  | BaseRecordingEvent<"run-output", "runtime", "runtime", RunOutputPayload>
  | BaseRecordingEvent<"run-error", "runtime", "runtime", RunErrorPayload>
  | BaseRecordingEvent<"chapter-marker", "annotation", "ui", ChapterMarkerPayload>;

export type EventPayloadByType<TType extends RecordingEventType> = Extract<
  RecordingEvent,
  { type: TType }
>["payload"];

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot + ReplayStableState
// ─────────────────────────────────────────────────────────────────────────────

export type ReplayStableState = {
  editor: {
    code: string;
    language: RecordingLanguage;
    cursor: { lineNumber: number; column: number } | null;
    selection: {
      startLineNumber: number;
      startColumn: number;
      endLineNumber: number;
      endColumn: number;
    } | null;
    scrollTop: number;
    scrollLeft: number;
    fontSize: number;
    theme: RecordingTheme;
  };
  pointer: {
    x: number;
    y: number;
    visible: boolean;
  } | null;
  media: {
    microphoneEnabled: boolean;
    cameraEnabled: boolean;
    cameraPosition: { x: number; y: number };
  };
  runtime: {
    status: "idle" | "running" | "success" | "error";
    stdout: string[];
    stderr: string[];
    previewHtml: string | null;
    errorMessage: string | null;
  };
};

export type RecordingSnapshot = {
  id: string;
  timestampMs: number;
  /** Inclusive: this snapshot already includes all events whose seq <= eventSeq. */
  eventSeq: number;
  state: ReplayStableState;
};

// ─────────────────────────────────────────────────────────────────────────────
// Package + indexes
// ─────────────────────────────────────────────────────────────────────────────

export type RecordingIndexes = {
  generatedAt: string;
  eventsByType: Record<RecordingEventType, number[]>;
  snapshotSeqsByTime: number[];
  markers: Array<{ timestampMs: number; eventSeq: number; type: RecordingEventType }>;
};

export type RecordingPackageV1 = {
  schemaVersion: RecordingSchemaVersion;
  manifest: RecordingManifest;
  meta: RecordingMeta;
  events: RecordingEvent[];
  snapshots: RecordingSnapshot[];
  media: RecordingMedia | null;
  indexes?: RecordingIndexes;
};

// ─────────────────────────────────────────────────────────────────────────────
// Loader / validator / migration
// ─────────────────────────────────────────────────────────────────────────────

export type SchemaValidationIssue = { path: string; message: string };

export type SchemaValidationResult = { ok: true } | { ok: false; errors: SchemaValidationIssue[] };

export type MigrationRegistryEntry = {
  from: string;
  to: string;
  migrate(input: unknown): unknown;
};

export type PackageLoadError =
  | { code: "unsupported-schema"; schemaVersion: string }
  | { code: "invalid-manifest"; message: string }
  | { code: "invalid-event"; seq?: number; message: string }
  | { code: "checksum-mismatch"; target: "events" | "snapshots" | "media" }
  | { code: "incomplete-package"; packageId: string };

export type PackageWarning =
  | { code: "media-missing"; blobId: string }
  | { code: "unknown-event-skipped"; seq: number; type: string };

export type PackageLoadResult =
  | { ok: true; package: RecordingPackageV1; mediaBlob: Blob | null; warnings: PackageWarning[] }
  | { ok: false; error: PackageLoadError };

export type MigrateResult =
  | { ok: true; package: RecordingPackageV1; appliedMigrations: string[] }
  | { ok: false; error: PackageLoadError };

export type PackageLoaderInput =
  | { kind: "indexeddb"; recordingId: string }
  | { kind: "file"; zip: Blob };

export type PackageLoader = {
  load(input: PackageLoaderInput): Promise<PackageLoadResult>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Storage list / repository
// ─────────────────────────────────────────────────────────────────────────────

export type RecordingListItem = {
  id: string;
  title: string;
  createdAt: string;
  durationMs: number;
  ownerId: string | null;
  creatorInfo: { displayName: string; source: "local" | "account" } | null;
  initialLanguage: string;
  hasAudio: boolean;
  hasCamera: boolean;
  thumbnailBlobId: string | null;
};

export type SaveDraftInput = {
  meta: RecordingMeta;
  events: RecordingEvent[];
  snapshots: RecordingSnapshot[];
  indexes: RecordingIndexes;
  mediaBlob: Blob | null;
};

export type SaveResult =
  | { ok: true; recordingId: string }
  | {
      ok: false;
      reason: "quota-exceeded" | "media-write-failed" | "validation-failed" | "unknown";
      message: string;
    };

export type RecordingRepository = {
  saveDraft(input: SaveDraftInput): Promise<SaveResult>;
  commit(recordingId: string): Promise<SaveResult>;
  list(): Promise<RecordingListItem[]>;
  load(recordingId: string): Promise<PackageLoadResult>;
  rename(recordingId: string, title: string): Promise<void>;
  remove(recordingId: string): Promise<void>;
  exportZip(recordingId: string): Promise<Blob>;
  importZip(zip: Blob): Promise<SaveResult>;
  sweep(): Promise<{ removedDrafts: number; removedBlobs: number }>;
  estimateQuota(): Promise<{ usageBytes: number; quotaBytes: number }>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Replay scheduler + reducer + index
// ─────────────────────────────────────────────────────────────────────────────

export type ReplayIndex = {
  eventsBySeq: RecordingEvent[];
  eventsByType: Map<RecordingEventType, RecordingEvent[]>;
  snapshotsByTime: RecordingSnapshot[];
  stableEventsByTime: RecordingEvent[];
  markersByTime: RecordingEvent[];
};

export type ReplayPlaybackRate = 0.5 | 1 | 1.5 | 2;

export type ReplaySchedulerState = {
  status: "loading" | "ready" | "playing" | "paused" | "seeking" | "buffering" | "ended" | "error";
  timelineTimeMs: number;
  playbackRate: ReplayPlaybackRate;
  lastAppliedSeq: number;
  mediaStatus: "none" | "loading" | "ready" | "stalled" | "missing" | "error";
  driftMs: number;
};

export type ReplayScheduler = {
  load(packageData: RecordingPackageV1): Promise<void>;
  play(): void;
  pause(): void;
  seek(targetTimeMs: number): Promise<void>;
  setRate(rate: ReplayPlaybackRate): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  destroy(): void;
  subscribe(listener: (state: ReplaySchedulerState) => void): () => void;
};

export type ReplayReducer = (state: ReplayStableState, event: RecordingEvent) => ReplayStableState;

// ─────────────────────────────────────────────────────────────────────────────
// Clocks (recording + replay) + media adapter
// ─────────────────────────────────────────────────────────────────────────────

export type RecordingClockStatus = "idle" | "running" | "paused" | "stopped";

export type RecordingClock = {
  readonly status: RecordingClockStatus;
  start(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  /** Effective ms since record-start; excludes paused intervals. */
  now(): number;
  durationMs(): number;
  subscribe(listener: (status: RecordingClockStatus) => void): () => void;
};

export type TimelineClock = {
  play(): void;
  pause(): void;
  setBase(targetTimeMs: number): void;
  setRate(rate: number): void;
  now(): number;
  subscribe(listener: (timeMs: number) => void): () => void;
};

export type MediaTimelineSegment = {
  blobId: string;
  timelineStartMs: number;
  timelineEndMs: number;
  mediaStartMs: number;
  mediaEndMs: number;
};

export type MediaClockAdapter = {
  segments: MediaTimelineSegment[];
  timelineToMediaTime(targetTimeMs: number): number | null;
  mediaToTimelineTime(mediaCurrentTimeSec: number): number | null;
  seek(targetTimeMs: number): Promise<void>;
  setRate(rate: number): void;
};

// ─────────────────────────────────────────────────────────────────────────────
// Event bus + producer + recording controller + package builder
// ─────────────────────────────────────────────────────────────────────────────

export type EventBusInput<TType extends RecordingEventType> = {
  type: TType;
  source: RecordingEventSource;
  track: RecordingEventTrack;
  payload: EventPayloadByType<TType>;
  wallTime?: string;
};

export type EventBus = {
  emit<TType extends RecordingEventType>(
    input: EventBusInput<TType>,
  ): Extract<RecordingEvent, { type: TType }>;
  drain(): RecordingEvent[];
  peek(): readonly RecordingEvent[];
  lastSeq(): number;
  subscribe(listener: (event: RecordingEvent) => void): () => void;
  reset(): void;
};

export type EventProducer = {
  start(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  dispose(): void;
};

export type RecordingControllerStatus =
  | "idle"
  | "requestingPermission"
  | "recording"
  | "paused"
  | "stopping"
  | "processing"
  | "completed"
  | "failed";

export type RecordingControllerState = {
  status: RecordingControllerStatus;
  startedAt: string | null;
  durationMs: number;
  mediaCapability: MediaCapability;
  lastError: { code: string; message: string } | null;
};

export type RecordingControllerDeps = {
  clock: RecordingClock;
  bus: EventBus;
  producers: EventProducer[];
  packageBuilder: PackageBuilder;
  repository: RecordingRepository;
};

export type RecordingController = {
  readonly state: RecordingControllerState;
  start(input: RecordStartPayload): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  stop(reason: "user" | "error"): Promise<RecordingPackageV1>;
  reset(): void;
  subscribe(listener: (state: RecordingControllerState) => void): () => void;
};

export type PackageBuildInput = {
  meta: RecordingMeta;
  events: RecordingEvent[];
  snapshots: RecordingSnapshot[];
  media: {
    blob: Blob;
    durationMs: number;
    mimeType: string;
    hasAudio: boolean;
    hasCamera: boolean;
  } | null;
};

export type PackageBuilder = {
  build(input: PackageBuildInput): Promise<{ pkg: RecordingPackageV1; mediaBlob: Blob | null }>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Runtime preview
// ─────────────────────────────────────────────────────────────────────────────

export type RuntimeMessage =
  | { source: "code-tape-runtime"; runId: string; type: "ready"; payload: Record<string, never> }
  | {
      source: "code-tape-runtime";
      runId: string;
      type: "console";
      payload: { level: "log" | "warn" | "error"; args: string[] };
    }
  | { source: "code-tape-runtime"; runId: string; type: "error"; payload: { message: string; stack?: string } }
  | { source: "code-tape-runtime"; runId: string; type: "blocked-alert"; payload: { message: string } }
  | { source: "code-tape-runtime"; runId: string; type: "complete"; payload: { previewHtml: string } };

export type CompileLanguage = "javascript" | "typescript";

export type CompileResult =
  | { ok: true; code: string; warnings: string[] }
  | { ok: false; phase: "transpile"; message: string; stack?: string };

export type PreviewCompiler = {
  compile(source: string, language: CompileLanguage): Promise<CompileResult>;
};

export type IframeRunInput = {
  runId: string;
  compiledCode: string;
  timeoutMs: number;
};

export type IframeRunResult =
  | { runId: string; status: "complete"; previewHtml: string | null; stdout: string[]; stderr: string[] }
  | {
      runId: string;
      status: "error";
      phase: "runtime";
      message: string;
      stack?: string;
      stdout: string[];
      stderr: string[];
    }
  | { runId: string; status: "timeout"; stdout: string[]; stderr: string[] };

export type IframeRuntime = {
  mount(host: HTMLElement): Promise<void>;
  run(input: IframeRunInput): Promise<IframeRunResult>;
  renderPreview(previewHtml: string): Promise<void>;
  /**
   * Render static HTML markup into a read-only (no-script) sandbox iframe and
   * return the sanitized markup actually written, so the caller can persist it
   * as the run's previewHtml for replay. Used for HTML/CSS "run" (no JS exec).
   */
  renderDocument(html: string): Promise<string>;
  reset(): void;
  destroy(): void;
};

// ─────────────────────────────────────────────────────────────────────────────
// Media devices + recorder (capability-only; DOM bindings live in features/media)
// ─────────────────────────────────────────────────────────────────────────────

export type DeviceInfo = { deviceId: string; label: string; kind: "audioinput" | "videoinput" };

export type OpenStreamRequest = {
  audioDeviceId?: string | null;
  cameraDeviceId?: string | null;
};

export type OpenStreamResult = {
  stream: MediaStream | null;
  capability: MediaCapability;
  warnings: MediaWarningPayload[];
};

export type MediaDevicesController = {
  enumerate(): Promise<{ audio: DeviceInfo[]; camera: DeviceInfo[] }>;
  requestPermission(kind: "audio" | "camera"): Promise<"granted" | "denied" | "not-found" | "busy">;
  openStream(request: OpenStreamRequest): Promise<OpenStreamResult>;
  setTrackEnabled(track: "audio" | "camera", enabled: boolean): void;
  release(): void;
  subscribe(listener: (capability: MediaCapability) => void): () => void;
};

export type MediaRecorderChunk = { data: Blob; timestampMs: number };

export type MediaRecorderResult = {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  hasAudio: boolean;
  hasCamera: boolean;
};

export type MediaRecorderWrapper = {
  start(stream: MediaStream): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): Promise<MediaRecorderResult>;
  onChunk(listener: (chunk: MediaRecorderChunk) => void): () => void;
  onError(listener: (error: MediaWarningPayload) => void): () => void;
};
