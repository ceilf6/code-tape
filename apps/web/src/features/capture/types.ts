/*
 * Producer factory contracts.
 *
 * Authority: docs/技术方案.md §5.3 (事件采集). Producer factories live OUTSIDE
 * shared/recording-schema because their dependency surface includes DOM /
 * Monaco / browser types — schema must stay free of those imports.
 *
 * Each factory returns an `EventProducer` (schema-level interface) plus,
 * optionally, additional commands the host page may call directly
 * (e.g. EditorProducer.takeSnapshot, RuntimeProducer.trigger).
 */
import type { editor as MonacoEditor } from "monaco-editor";
import type {
  EventBus,
  EventProducer,
  MediaCapability,
  MediaDevicesController,
  RecordingClock,
  RecordingLanguage,
  RecordingSnapshot,
} from "@/shared/recording-schema";
import type { IframeRunResult, IframeRuntime, PreviewCompiler } from "@/shared/recording-schema";

export type ProducerCommonDeps = {
  bus: EventBus;
  clock: RecordingClock;
};

// ─────────────────────────────────────────────────────────────────────────────
// Editor
// ─────────────────────────────────────────────────────────────────────────────

export type EditorProducerDeps = ProducerCommonDeps & {
  /** Lazily resolved Monaco instance; producer must tolerate `null` between mounts. */
  getEditor(): MonacoEditor.IStandaloneCodeEditor | null;
  /** Reports the *current* editor language so language-change events can be deduped. */
  getCurrentLanguage(): RecordingLanguage;
  /** Applies a producer-driven language change to the current Monaco model. */
  setModelLanguage?(
    model: MonacoEditor.ITextModel,
    language: RecordingLanguage,
  ): void;
};

export type EditorProducerHandle = EventProducer & {
  /** Force-flush any pending content-change before the controller stops or pauses. */
  flushPending(): void;
  /** Take a stable-state snapshot of the editor for packageBuilder / resume-baseline. */
  takeSnapshot(): Promise<RecordingSnapshot | null>;
  /** Imperatively change the language (also emits the language-change event). */
  setLanguage(next: RecordingLanguage): void;
};

export type CreateEditorProducer = (deps: EditorProducerDeps) => EditorProducerHandle;

// ─────────────────────────────────────────────────────────────────────────────
// Pointer
// ─────────────────────────────────────────────────────────────────────────────

export type PointerProducerDeps = ProducerCommonDeps & {
  /** Element whose pointer events are recorded (editor host, typically). */
  getHost(): HTMLElement | null;
};

export type CreatePointerProducer = (deps: PointerProducerDeps) => EventProducer;

// ─────────────────────────────────────────────────────────────────────────────
// Shortcut
// ─────────────────────────────────────────────────────────────────────────────

export type ShortcutProducerDeps = ProducerCommonDeps & {
  /** Window/element to attach keydown listeners. Defaults to window in tests. */
  getRoot(): Window | HTMLElement | null;
  /** Map raw event → friendly label + optional command (e.g. "Save", "Format"). */
  resolveLabel?(event: KeyboardEvent): { label: string; command?: string } | null;
};

export type CreateShortcutProducer = (deps: ShortcutProducerDeps) => EventProducer;

// ─────────────────────────────────────────────────────────────────────────────
// Media
// ─────────────────────────────────────────────────────────────────────────────

export type MediaProducerDeps = ProducerCommonDeps & {
  devices: MediaDevicesController;
  /** Initial capability snapshot at record-start. */
  getCapability(): MediaCapability;
};

export type MediaProducerHandle = EventProducer & {
  /** Toggle microphone (also emits media-toggle). */
  setMicrophoneEnabled(enabled: boolean): void;
  /** Toggle camera (also emits media-toggle). */
  setCameraEnabled(enabled: boolean): void;
  /** Report a new camera preview position (also emits camera-position). */
  reportCameraPosition(position: { x: number; y: number }): void;
};

export type CreateMediaProducer = (deps: MediaProducerDeps) => MediaProducerHandle;

// ─────────────────────────────────────────────────────────────────────────────
// Runtime
// ─────────────────────────────────────────────────────────────────────────────

export type RuntimeProducerDeps = ProducerCommonDeps & {
  compiler: PreviewCompiler;
  runtime: IframeRuntime;
};

export type RuntimeProducerRunResult =
  | IframeRunResult
  | {
      runId: string;
      status: "error";
      phase: "transpile";
      message: string;
      stack?: string;
      stdout: string[];
      stderr: string[];
      previewHtml: null;
    };

export type RuntimeProducerHandle = EventProducer & {
  /**
   * Compile + execute the user's source. Emits `run-start`, then exactly one of
   * `run-output` / `run-error` on completion. Returns the underlying iframe
   * result so the page UI can render console output during the run.
   */
  trigger(input: {
    language: "javascript" | "typescript";
    source: string;
  }): Promise<RuntimeProducerRunResult>;
};

export type CreateRuntimeProducer = (deps: RuntimeProducerDeps) => RuntimeProducerHandle;
