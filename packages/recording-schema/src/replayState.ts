import type {
  RecordingEvent,
  RecordingPackageV1,
  RecordStartPayload,
  RecordingDocumentState,
  RecordingEditorDocuments,
  RecordingLanguage,
  RecordingScriptLanguage,
  ReplayReducer,
  ReplayStableState,
} from "./types.js";

type InitialReplayStateInput = {
  initialLanguage: ReplayStableState["editor"]["language"];
  initialActiveScriptLanguage?: RecordingScriptLanguage;
  initialDocuments?: RecordingEditorDocuments;
  initialFontSize: number;
  initialTheme: ReplayStableState["editor"]["theme"];
};

const RECORDING_LANGUAGES: readonly RecordingLanguage[] = [
  "javascript",
  "typescript",
  "python",
  "html",
  "css",
];

function isScriptLanguage(language: RecordingLanguage): language is RecordingScriptLanguage {
  return language === "javascript" || language === "typescript";
}

function emptyDocumentState(): RecordingDocumentState {
  return {
    code: "",
    cursor: null,
    selection: null,
    scrollTop: 0,
    scrollLeft: 0,
  };
}

function buildEmptyDocuments(): RecordingEditorDocuments {
  return RECORDING_LANGUAGES.reduce((documents, language) => {
    documents[language] = emptyDocumentState();
    return documents;
  }, {} as RecordingEditorDocuments);
}

function cloneDocumentState(document: RecordingDocumentState): RecordingDocumentState {
  return {
    code: document.code,
    cursor: document.cursor ? { ...document.cursor } : null,
    selection: document.selection ? { ...document.selection } : null,
    scrollTop: document.scrollTop,
    scrollLeft: document.scrollLeft,
  };
}

function buildInitialDocuments(documents?: RecordingEditorDocuments): RecordingEditorDocuments {
  const empty = buildEmptyDocuments();
  if (!documents) return empty;
  return RECORDING_LANGUAGES.reduce((nextDocuments, language) => {
    nextDocuments[language] = documents[language]
      ? cloneDocumentState(documents[language])
      : emptyDocumentState();
    return nextDocuments;
  }, {} as RecordingEditorDocuments);
}

function ensureDocuments(editor: ReplayStableState["editor"]): RecordingEditorDocuments {
  if (editor.documents) return editor.documents;
  return {
    ...buildEmptyDocuments(),
    [editor.language]: {
      code: editor.code,
      cursor: editor.cursor,
      selection: editor.selection,
      scrollTop: editor.scrollTop,
      scrollLeft: editor.scrollLeft,
    },
  };
}

function activeScriptLanguageFor(language: RecordingLanguage): RecordingScriptLanguage {
  return isScriptLanguage(language) ? language : "javascript";
}

export function buildInitialReplayStateFromPackage(pkg: RecordingPackageV1): ReplayStableState {
  return buildInitialReplayState(pkg.meta);
}

export function buildFinalReplayStateFromPackage(pkg: RecordingPackageV1): ReplayStableState {
  return pkg.events
    .filter((event) => STABLE_EVENT_TYPES.has(event.type))
    .slice()
    .sort((left, right) => left.timestampMs - right.timestampMs || left.seq - right.seq)
    .reduce(replayReducer, buildInitialReplayStateFromPackage(pkg));
}

export function buildInitialReplayStateFromRecordStart(
  payload: RecordStartPayload,
): ReplayStableState {
  return buildInitialReplayState(payload);
}

/** Deep clone (structuredClone if available; JSON fallback otherwise). */
export function cloneReplayStableState(state: ReplayStableState): ReplayStableState {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(state);
  }
  return JSON.parse(JSON.stringify(state)) as ReplayStableState;
}

/**
 * Pure reducer that folds a single event into the replay's stable state.
 *
 * Stable state only includes things persisted in snapshots and rebuilt during
 * seeking: code, cursor, language, scroll, media toggles, and runtime output.
 * Transient effects are layered on top by replay rendering.
 */
export const replayReducer: ReplayReducer = (
  state: ReplayStableState,
  event: RecordingEvent,
): ReplayStableState => {
  switch (event.type) {
    case "content-change": {
      const documents = ensureDocuments(state.editor);
      const language = event.payload.language;
      const currentDocument = documents[language] ?? emptyDocumentState();
      const nextDocuments = {
        ...documents,
        [language]: {
          ...currentDocument,
          code: event.payload.code,
        },
      };
      return {
        ...state,
        editor: {
          ...state.editor,
          documents: nextDocuments,
          code: event.payload.code,
          language,
          activeScriptLanguage: isScriptLanguage(language)
            ? language
            : state.editor.activeScriptLanguage ?? activeScriptLanguageFor(state.editor.language),
        },
      };
    }
    case "language-change": {
      const documents = ensureDocuments(state.editor);
      const nextLanguage = event.payload.to;
      const nextDocument = documents[nextLanguage] ?? emptyDocumentState();
      return {
        ...state,
        editor: {
          ...state.editor,
          documents,
          language: nextLanguage,
          code: nextDocument.code,
          cursor: nextDocument.cursor,
          selection: nextDocument.selection,
          scrollTop: nextDocument.scrollTop,
          scrollLeft: nextDocument.scrollLeft,
          activeScriptLanguage: isScriptLanguage(nextLanguage)
            ? nextLanguage
            : state.editor.activeScriptLanguage ?? activeScriptLanguageFor(state.editor.language),
        },
      };
    }
    case "selection-change": {
      const documents = ensureDocuments(state.editor);
      const currentDocument = documents[state.editor.language] ?? emptyDocumentState();
      const nextDocuments = {
        ...documents,
        [state.editor.language]: {
          ...currentDocument,
          cursor: event.payload.cursor,
          selection: event.payload.selection,
        },
      };
      return {
        ...state,
        editor: {
          ...state.editor,
          documents: nextDocuments,
          cursor: event.payload.cursor,
          selection: event.payload.selection,
        },
      };
    }
    case "editor-scroll": {
      const documents = ensureDocuments(state.editor);
      const currentDocument = documents[state.editor.language] ?? emptyDocumentState();
      const nextDocuments = {
        ...documents,
        [state.editor.language]: {
          ...currentDocument,
          scrollTop: event.payload.scrollTop,
          scrollLeft: event.payload.scrollLeft,
        },
      };
      return {
        ...state,
        editor: {
          ...state.editor,
          documents: nextDocuments,
          scrollTop: event.payload.scrollTop,
          scrollLeft: event.payload.scrollLeft,
        },
      };
    }
    case "media-toggle":
      return {
        ...state,
        media: {
          ...state.media,
          microphoneEnabled: event.payload.microphoneEnabled,
          cameraEnabled: event.payload.cameraEnabled,
        },
      };
    case "camera-position":
      return {
        ...state,
        media: { ...state.media, cameraPosition: { x: event.payload.x, y: event.payload.y } },
      };
    case "run-start":
      return {
        ...state,
        runtime: { status: "running", stdout: [], stderr: [], previewHtml: null, errorMessage: null },
      };
    case "run-output":
      return {
        ...state,
        runtime: {
          status: "success",
          stdout: event.payload.stdout,
          stderr: event.payload.stderr,
          previewHtml: event.payload.previewHtml,
          errorMessage: null,
        },
      };
    case "run-error":
      return {
        ...state,
        runtime: {
          status: "error",
          stdout: event.payload.stdout,
          stderr: event.payload.stderr,
          previewHtml: event.payload.previewHtml,
          errorMessage: event.payload.message,
        },
      };
    case "resume-baseline":
      return event.payload.snapshot;
    case "record-start":
    case "record-pause":
    case "record-resume":
    case "record-stop":
    case "mouse-move":
    case "mouse-click":
    case "shortcut":
    case "media-warning":
    case "chapter-marker":
      return state;
    default: {
      const _unhandled: never = event;
      void _unhandled;
      return state;
    }
  }
};

/** Affected event types — stable events only. */
export const STABLE_EVENT_TYPES = new Set<RecordingEvent["type"]>([
  "content-change",
  "language-change",
  "selection-change",
  "editor-scroll",
  "media-toggle",
  "camera-position",
  "run-start",
  "run-output",
  "run-error",
  "resume-baseline",
]);

function buildInitialReplayState(input: InitialReplayStateInput): ReplayStableState {
  const documents = buildInitialDocuments(input.initialDocuments);
  const initialDocument = documents[input.initialLanguage] ?? emptyDocumentState();
  return {
    editor: {
      code: initialDocument.code,
      language: input.initialLanguage,
      activeScriptLanguage: input.initialActiveScriptLanguage ?? activeScriptLanguageFor(input.initialLanguage),
      documents,
      cursor: initialDocument.cursor,
      selection: initialDocument.selection,
      scrollTop: initialDocument.scrollTop,
      scrollLeft: initialDocument.scrollLeft,
      fontSize: input.initialFontSize,
      theme: input.initialTheme,
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
  };
}
