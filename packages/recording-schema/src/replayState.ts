import type {
  RecordingEvent,
  RecordingPackageV1,
  RecordStartPayload,
  ReplayReducer,
  ReplayStableState,
} from "./types.js";

type InitialReplayStateInput = {
  initialLanguage: ReplayStableState["editor"]["language"];
  initialFontSize: number;
  initialTheme: ReplayStableState["editor"]["theme"];
};

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
    case "content-change":
      return {
        ...state,
        editor: {
          ...state.editor,
          code: event.payload.code,
          language: event.payload.language,
        },
      };
    case "language-change":
      return {
        ...state,
        editor: { ...state.editor, language: event.payload.to },
      };
    case "selection-change":
      return {
        ...state,
        editor: {
          ...state.editor,
          cursor: event.payload.cursor,
          selection: event.payload.selection,
        },
      };
    case "editor-scroll":
      return {
        ...state,
        editor: {
          ...state.editor,
          scrollTop: event.payload.scrollTop,
          scrollLeft: event.payload.scrollLeft,
        },
      };
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
  return {
    editor: {
      code: "",
      language: input.initialLanguage,
      cursor: null,
      selection: null,
      scrollTop: 0,
      scrollLeft: 0,
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
