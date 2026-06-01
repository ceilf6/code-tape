import type { editor as MonacoEditor } from "monaco-editor";
import type { CreateEditorProducer, EditorProducerHandle } from "./types";
import type {
  ContentChangePayload,
  RecordingLanguage,
  RecordingSnapshot,
  RecordingTheme,
  ReplayStableState,
  SelectionChangePayload,
} from "@/shared/recording-schema";
import { generateId } from "@/shared/util/ids";

const CONTENT_DEBOUNCE_MS = 300;
const CONTENT_IDLE_FLUSH_MS = 1000;
const EDITOR_REBIND_POLL_MS = 100;
const SCROLL_THROTTLE_MS = 100;

type Disposable = { dispose(): void };
type ContentChangedEvent = {
  changes?: Array<{ text?: string; rangeLength?: number }>;
  isUndoing?: boolean;
  isRedoing?: boolean;
};
type DetectedContentChangeReason = Exclude<ContentChangePayload["changeReason"], "programmatic">;
type MonacoSelectionLike = {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};
type ScrollPosition = { scrollTop: number; scrollLeft: number };
type PendingContent = {
  code: string;
  contentHash: string;
  language: RecordingLanguage;
  changeReason: ContentChangePayload["changeReason"];
  changeCount: number;
};
type ContentFlushReason = ContentChangePayload["flushedBy"];

export const createEditorProducer: CreateEditorProducer = (deps): EditorProducerHandle => {
  const { bus, clock } = deps;

  let currentEditor: MonacoEditor.IStandaloneCodeEditor | null = null;
  let currentLanguage = deps.getCurrentLanguage();
  let disposables: Disposable[] = [];
  let rebindTimer: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let scrollTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingContent: PendingContent | null = null;
  let pendingScroll: ScrollPosition | null = null;
  let pasteSignalPending = false;
  let formatSignalPending = false;
  let formatSignalToken = 0;
  let suppressEditorChangeDepth = 0;
  let lastContentHash: string | null = null;
  let version = 0;
  let pausedState: ReplayStableState | null = null;
  let active = false;
  let paused = false;
  let stopped = false;
  let disposed = false;

  const isListening = () => active && !paused && !stopped && !disposed;
  const isCapturingEditorChanges = () => isListening() && suppressEditorChangeDepth === 0;

  const clearContentTimers = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (idleTimer) clearTimeout(idleTimer);
    debounceTimer = null;
    idleTimer = null;
  };

  const clearScrollTimer = () => {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = null;
    pendingScroll = null;
  };

  const stopRebindPolling = () => {
    if (!rebindTimer) return;
    clearInterval(rebindTimer);
    rebindTimer = null;
  };

  const disposeEditorListeners = () => {
    disposables.forEach((disposable) => disposable.dispose());
    disposables = [];
    currentEditor = null;
  };

  const getEditorValue = (editor: MonacoEditor.IStandaloneCodeEditor): string => {
    const model = editor.getModel();
    return model?.getValue() ?? editor.getValue();
  };

  const readLanguage = (): RecordingLanguage => {
    currentLanguage = deps.getCurrentLanguage() ?? currentLanguage;
    return currentLanguage;
  };

  const setStableLanguage = (next: RecordingLanguage) => {
    currentLanguage = next;
  };

  const emitContent = (flushedBy: ContentFlushReason) => {
    if (!pendingContent) return;
    clearContentTimers();

    const pending = pendingContent;
    pendingContent = null;
    if (pending.contentHash === lastContentHash) return;

    version += 1;
    lastContentHash = pending.contentHash;
    bus.emit({
      type: "content-change",
      source: "editor",
      track: "main",
      payload: {
        fileId: "main",
        version,
        code: pending.code,
        contentHash: pending.contentHash,
        language: pending.language,
        changeReason: pending.changeReason,
        changeCount: pending.changeCount,
        flushedBy,
      },
    });
  };

  const scheduleContentFlush = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => emitContent("debounce"), CONTENT_DEBOUNCE_MS);
    idleTimer ??= setTimeout(() => emitContent("idle"), CONTENT_IDLE_FLUSH_MS);
  };

  const emitSelection = (editor: MonacoEditor.IStandaloneCodeEditor) => {
    if (!isCapturingEditorChanges()) return;
    bus.emit({
      type: "selection-change",
      source: "editor",
      track: "main",
      payload: {
        cursor: editor.getPosition(),
        selection: toSelection(editor.getSelection()),
      },
    });
  };

  const emitScroll = () => {
    scrollTimer = null;
    if (!pendingScroll || !isCapturingEditorChanges()) {
      pendingScroll = null;
      return;
    }
    const scroll = pendingScroll;
    pendingScroll = null;
    bus.emit({
      type: "editor-scroll",
      source: "editor",
      track: "main",
      payload: scroll,
    });
  };

  const emitPendingScroll = () => {
    if (!pendingScroll) return;
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = null;
    emitScroll();
  };

  const scheduleScroll = (editor: MonacoEditor.IStandaloneCodeEditor) => {
    if (!isCapturingEditorChanges()) return;
    pendingScroll = {
      scrollTop: editor.getScrollTop(),
      scrollLeft: editor.getScrollLeft(),
    };
    scrollTimer ??= setTimeout(emitScroll, SCROLL_THROTTLE_MS);
  };

  const handleContentChange = (
    editor: MonacoEditor.IStandaloneCodeEditor,
    event: ContentChangedEvent,
  ) => {
    if (!isListening()) return;
    if (suppressEditorChangeDepth > 0) {
      pendingContent = null;
      clearContentTimers();
      lastContentHash = hashContent(getEditorValue(editor));
      return;
    }
    const changeReason = formatSignalPending
      ? "format"
      : pasteSignalPending
        ? "paste"
        : classifyContentChange(event);
    pasteSignalPending = false;
    formatSignalPending = false;
    const code = getEditorValue(editor);
    const existingCount = pendingContent?.changeCount ?? 0;
    pendingContent = {
      code,
      contentHash: hashContent(code),
      language: readLanguage(),
      changeReason,
      changeCount: existingCount + 1,
    };

    if (changeReason !== "input") {
      emitContent(changeReason);
      return;
    }
    scheduleContentFlush();
  };

  const handlePasteSignal = () => {
    if (!isCapturingEditorChanges()) return;
    if (pendingContent) {
      pendingContent = { ...pendingContent, changeReason: "paste" };
      emitContent("paste");
      return;
    }
    pasteSignalPending = true;
    queueMicrotask(() => {
      pasteSignalPending = false;
    });
  };

  const handleFormatSignal = () => {
    if (!isCapturingEditorChanges()) return () => {};
    const token = formatSignalToken + 1;
    formatSignalToken = token;
    formatSignalPending = true;
    queueMicrotask(() => {
      if (formatSignalToken === token) {
        formatSignalPending = false;
      }
    });
    return () => {
      if (formatSignalToken === token) {
        formatSignalPending = false;
      }
    };
  };

  const bindEditor = (editor: MonacoEditor.IStandaloneCodeEditor) => {
    currentEditor = editor;
    currentLanguage = deps.getCurrentLanguage();
    lastContentHash ??= hashContent(getEditorValue(editor));
    disposables = [
      editor.onDidChangeModelContent((event: ContentChangedEvent) => handleContentChange(editor, event)),
      editor.onDidPaste(handlePasteSignal),
      editor.onDidChangeCursorSelection(() => emitSelection(editor)),
      editor.onDidScrollChange(() => scheduleScroll(editor)),
    ];
  };

  const syncEditor = () => {
    const nextEditor = isListening() ? deps.getEditor() : null;
    if (nextEditor === currentEditor) return;
    if (currentEditor && pendingContent) {
      emitContent("snapshot");
    }
    pasteSignalPending = false;
    formatSignalPending = false;
    clearScrollTimer();
    disposeEditorListeners();
    if (nextEditor) bindEditor(nextEditor);
  };

  const startRebindPolling = () => {
    if (rebindTimer || stopped || disposed) return;
    rebindTimer = setInterval(syncEditor, EDITOR_REBIND_POLL_MS);
  };

  const snapshotState = (editor: MonacoEditor.IStandaloneCodeEditor): ReplayStableState => ({
    editor: {
      code: getEditorValue(editor),
      language: readLanguage(),
      cursor: editor.getPosition(),
      selection: toSelection(editor.getSelection()),
      scrollTop: editor.getScrollTop(),
      scrollLeft: editor.getScrollLeft(),
      fontSize: readFontSize(editor),
      theme: readTheme(editor),
    },
    pointer: null,
    media: {
      microphoneEnabled: false,
      cameraEnabled: false,
      cameraPosition: { x: 0, y: 0 },
    },
    runtime: {
      status: "idle",
      stdout: [],
      stderr: [],
      previewHtml: null,
      errorMessage: null,
    },
  });

  const emitResumeBaselineIfNeeded = () => {
    syncEditor();
    if (!currentEditor || !pausedState) return;
    const nextState = snapshotState(currentEditor);
    if (stableStateKey(nextState) === stableStateKey(pausedState)) return;
    lastContentHash = hashContent(nextState.editor.code);
    bus.emit({
      type: "resume-baseline",
      source: "recorder",
      track: "main",
      payload: {
        reason: "paused-state-changed",
        snapshot: nextState,
      },
    });
  };

  return {
    start() {
      if (stopped || disposed) return;
      active = true;
      paused = false;
      syncEditor();
      startRebindPolling();
    },
    pause() {
      if (stopped || disposed || paused) return;
      emitContent("pause");
      syncEditor();
      pausedState = currentEditor ? snapshotState(currentEditor) : null;
      paused = true;
      active = false;
      clearContentTimers();
      clearScrollTimer();
      disposeEditorListeners();
      stopRebindPolling();
    },
    resume() {
      if (stopped || disposed || !paused) return;
      active = true;
      paused = false;
      syncEditor();
      startRebindPolling();
      queueMicrotask(emitResumeBaselineIfNeeded);
    },
    stop() {
      if (stopped || disposed) return;
      emitContent("stop");
      stopped = true;
      active = false;
      paused = false;
      clearContentTimers();
      clearScrollTimer();
      disposeEditorListeners();
      stopRebindPolling();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopped = true;
      active = false;
      paused = false;
      clearContentTimers();
      clearScrollTimer();
      disposeEditorListeners();
      stopRebindPolling();
    },
    flushPending(reason = "run") {
      if (!isListening()) return;
      emitContent(reason);
      emitPendingScroll();
    },
    markNextChangeAsFormat() {
      return handleFormatSignal();
    },
    runWithoutCapturingChanges(callback) {
      clearScrollTimer();
      suppressEditorChangeDepth += 1;
      try {
        callback();
      } finally {
        suppressEditorChangeDepth -= 1;
        pasteSignalPending = false;
        formatSignalPending = false;
      }
    },
    async takeSnapshot(): Promise<RecordingSnapshot | null> {
      syncEditor();
      if (!currentEditor) return null;
      emitContent("snapshot");
      return {
        id: generateId("snap"),
        timestampMs: clock.now(),
        eventSeq: bus.lastSeq(),
        state: snapshotState(currentEditor),
      };
    },
    setLanguage(next) {
      syncEditor();
      if (!currentEditor || !isListening()) return;
      const from = readLanguage();
      if (from === next) return;
      emitContent("snapshot");
      emitPendingScroll();
      const model = currentEditor.getModel();
      if (model) {
        deps.setModelLanguage?.(model, next);
      }
      setStableLanguage(next);
      bus.emit({
        type: "language-change",
        source: "editor",
        track: "main",
        payload: { from, to: next },
      });
    },
  };
};

function classifyContentChange(event: ContentChangedEvent): DetectedContentChangeReason {
  if (event.isUndoing) return "undo";
  if (event.isRedoing) return "redo";
  const changes = event.changes ?? [];
  if (changes.length > 1) return "format";
  if (changes.some((change) => (change.text?.length ?? 0) > 1 && change.text?.includes("\n"))) {
    return "paste";
  }
  return "input";
}

function toSelection(selection: MonacoSelectionLike | null): SelectionChangePayload["selection"] {
  if (!selection) return null;
  return {
    startLineNumber: selection.startLineNumber,
    startColumn: selection.startColumn,
    endLineNumber: selection.endLineNumber,
    endColumn: selection.endColumn,
  };
}

function readFontSize(editor: MonacoEditor.IStandaloneCodeEditor): number {
  const options = readRawOptions(editor);
  return typeof options.fontSize === "number" ? options.fontSize : 14;
}

function readTheme(editor: MonacoEditor.IStandaloneCodeEditor): RecordingTheme {
  const options = readRawOptions(editor);
  const theme = typeof options.theme === "string" ? options.theme : "";
  return theme.includes("light") ? "light" : "dark";
}

function readRawOptions(editor: MonacoEditor.IStandaloneCodeEditor): Record<string, unknown> {
  const candidate = editor as MonacoEditor.IStandaloneCodeEditor & {
    getRawOptions?: () => unknown;
  };
  const options = candidate.getRawOptions?.();
  return typeof options === "object" && options !== null ? (options as Record<string, unknown>) : {};
}

function hashContent(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}`;
}

function stableStateKey(state: ReplayStableState): string {
  return JSON.stringify(state);
}
