import { describe, expect, it } from "vitest";
import {
  buildFinalReplayStateFromPackage,
  buildInitialReplayStateFromPackage,
  buildInitialReplayStateFromRecordStart,
  cloneReplayStableState,
  RECORDING_SCHEMA_VERSION,
  replayReducer,
  STABLE_EVENT_TYPES,
  type RecordingEvent,
  type RecordingEditorDocuments,
  type RecordingLanguage,
  type RecordingPackageV1,
} from "@/shared/recording-schema";

describe("replay stable state contract", () => {
  it("builds the same initial state from package metadata and record-start payload", () => {
    const pkg = makePackage();
    const fromPackage = buildInitialReplayStateFromPackage(pkg);
    const fromRecordStart = buildInitialReplayStateFromRecordStart({
      initialLanguage: pkg.meta.initialLanguage,
      initialTheme: pkg.meta.initialTheme,
      initialFontSize: pkg.meta.initialFontSize,
      selectedAudioDeviceId: pkg.meta.mediaCapability.selectedAudioDeviceId,
      selectedCameraDeviceId: pkg.meta.mediaCapability.selectedCameraDeviceId,
      mediaCapability: pkg.meta.mediaCapability,
    });

    expect(fromRecordStart).toEqual(fromPackage);
    expect(fromPackage.editor).toMatchObject({
      code: "",
      language: "javascript",
      fontSize: 14,
      theme: "dark",
    });
    expect(fromPackage.media).toEqual({
      microphoneEnabled: false,
      cameraEnabled: false,
      cameraPosition: { x: 0, y: 0 },
    });
    expect(fromPackage.runtime.status).toBe("idle");
  });

  it("hydrates initial editor documents from package metadata and record-start payload", () => {
    const initialDocuments = makeDocuments({
      javascript: { code: "console.log('js');" },
      typescript: { code: "const value: number = 1;" },
      html: {
        code: "<div>ready</div>",
        cursor: { lineNumber: 1, column: 6 },
        scrollTop: 32,
      },
      css: { code: "div { color: red; }" },
    });
    const pkg = makePackage();
    pkg.meta = {
      ...pkg.meta,
      initialLanguage: "html",
      initialDocuments,
      initialActiveScriptLanguage: "typescript",
    } as typeof pkg.meta;

    const fromPackage = buildInitialReplayStateFromPackage(pkg);
    const fromRecordStart = buildInitialReplayStateFromRecordStart({
      initialLanguage: "html",
      initialTheme: pkg.meta.initialTheme,
      initialFontSize: pkg.meta.initialFontSize,
      selectedAudioDeviceId: null,
      selectedCameraDeviceId: null,
      mediaCapability: pkg.meta.mediaCapability,
      initialDocuments,
      initialActiveScriptLanguage: "typescript",
    } as Parameters<typeof buildInitialReplayStateFromRecordStart>[0]);

    expect(fromRecordStart.editor).toEqual(fromPackage.editor);
    expect(fromPackage.editor).toMatchObject({
      code: "<div>ready</div>",
      language: "html",
      activeScriptLanguage: "typescript",
      cursor: { lineNumber: 1, column: 6 },
      scrollTop: 32,
    });
    expect(fromPackage.editor.documents?.javascript.code).toBe("console.log('js');");
    expect(fromPackage.editor.documents?.typescript.code).toBe("const value: number = 1;");
    expect(fromPackage.editor.documents?.css.code).toBe("div { color: red; }");
  });

  it("folds stable events while leaving transient events out of the stable contract", () => {
    const initial = buildInitialReplayStateFromPackage(makePackage());
    const withContent = replayReducer(initial, contentChangeEvent(1, "console.log('p0')"));
    const withMedia = replayReducer(withContent, mediaToggleEvent(2));
    const withRuntime = replayReducer(withMedia, runOutputEvent(3));
    const afterShortcut = replayReducer(withRuntime, shortcutEvent(4));

    expect(afterShortcut.editor.code).toBe("console.log('p0')");
    expect(afterShortcut.media).toMatchObject({ microphoneEnabled: true, cameraEnabled: true });
    expect(afterShortcut.runtime).toMatchObject({
      status: "success",
      stdout: ["ok"],
      previewHtml: "<main>P0</main>",
    });
    expect(STABLE_EVENT_TYPES.has("content-change")).toBe(true);
    expect(STABLE_EVENT_TYPES.has("shortcut")).toBe(false);
    expect(afterShortcut).toBe(withRuntime);
  });

  it("deep-clones stable state snapshots", () => {
    const state = replayReducer(
      buildInitialReplayStateFromPackage(makePackage()),
      contentChangeEvent(1, "let answer = 42;"),
    );
    const cloned = cloneReplayStableState(state);

    cloned.editor.code = "mutated";
    cloned.runtime.stdout.push("mutated");

    expect(state.editor.code).toBe("let answer = 42;");
    expect(state.runtime.stdout).toEqual([]);
  });

  it("builds the final stable state from package events", () => {
    const pkg = makePackage();
    pkg.events = [
      contentChangeEvent(1, "console.log('final frame');"),
      runOutputEvent(2),
    ];

    const state = buildFinalReplayStateFromPackage(pkg);

    expect(state.editor.code).toBe("console.log('final frame');");
    expect(state.runtime.previewHtml).toBe("<main>P0</main>");
  });

  it("preserves independent document contents when switching languages", () => {
    const initial = buildInitialReplayStateFromPackage(makePackage());
    const withJs = replayReducer(
      initial,
      contentChangeEvent(1, "console.log(1);", "javascript"),
    );
    const viewingHtml = replayReducer(withJs, languageChangeEvent(2, "javascript", "html"));
    const withHtml = replayReducer(viewingHtml, contentChangeEvent(3, "<div>hi</div>", "html"));
    const backToJs = replayReducer(withHtml, languageChangeEvent(4, "html", "javascript"));

    expect(backToJs.editor.language).toBe("javascript");
    expect(backToJs.editor.code).toBe("console.log(1);");
    expect(backToJs.editor.activeScriptLanguage).toBe("javascript");
    expect(backToJs.editor.documents?.javascript.code).toBe("console.log(1);");
    expect(backToJs.editor.documents?.html.code).toBe("<div>hi</div>");
  });

  it("folds selection and scroll state into the active language document", () => {
    const initial = buildInitialReplayStateFromPackage(makePackage());
    const jsSelected = replayReducer(
      initial,
      selectionChangeEvent(
        1,
        { lineNumber: 2, column: 4 },
        { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 12 },
      ),
    );
    const jsScrolled = replayReducer(jsSelected, editorScrollEvent(2, 120, 8));
    const viewingHtml = replayReducer(jsScrolled, languageChangeEvent(3, "javascript", "html"));
    const htmlSelected = replayReducer(
      viewingHtml,
      selectionChangeEvent(
        4,
        { lineNumber: 1, column: 6 },
        { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 15 },
      ),
    );
    const htmlScrolled = replayReducer(htmlSelected, editorScrollEvent(5, 42, 0));
    const backToJs = replayReducer(htmlScrolled, languageChangeEvent(6, "html", "javascript"));

    expect(backToJs.editor).toMatchObject({
      language: "javascript",
      cursor: { lineNumber: 2, column: 4 },
      selection: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 12 },
      scrollTop: 120,
      scrollLeft: 8,
    });
    expect(backToJs.editor.documents?.javascript).toMatchObject({
      cursor: { lineNumber: 2, column: 4 },
      selection: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 12 },
      scrollTop: 120,
      scrollLeft: 8,
    });
    expect(backToJs.editor.documents?.html).toMatchObject({
      cursor: { lineNumber: 1, column: 6 },
      selection: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 15 },
      scrollTop: 42,
      scrollLeft: 0,
    });
  });
});

function makePackage(): RecordingPackageV1 {
  return {
    schemaVersion: RECORDING_SCHEMA_VERSION,
    manifest: {
      packageId: "pkg-1",
      schemaVersion: RECORDING_SCHEMA_VERSION,
      status: "complete",
      createdAt: "2026-05-24T00:00:00.000Z",
      completedAt: "2026-05-24T00:01:00.000Z",
      checksums: { eventsSha256: "events", snapshotsSha256: "snapshots" },
    },
    meta: {
      id: "rec-1",
      title: "P0 demo",
      createdAt: "2026-05-24T00:00:00.000Z",
      durationMs: 60_000,
      appVersion: "0.0.0",
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
    events: [],
    snapshots: [],
    media: null,
  };
}

function makeDocuments(
  overrides: Partial<Record<RecordingLanguage, Partial<RecordingEditorDocuments[RecordingLanguage]>>> = {},
): RecordingEditorDocuments {
  const languages: RecordingLanguage[] = ["javascript", "typescript", "python", "html", "css"];
  return languages.reduce((documents, language) => {
    documents[language] = {
      code: "",
      cursor: null,
      selection: null,
      scrollTop: 0,
      scrollLeft: 0,
      ...overrides[language],
    };
    return documents;
  }, {} as RecordingEditorDocuments);
}

function contentChangeEvent(
  seq: number,
  code: string,
  language: RecordingLanguage = "javascript",
): RecordingEvent {
  return {
    id: `e-${seq}`,
    seq,
    timestampMs: seq * 100,
    source: "editor",
    track: "main",
    type: "content-change",
    payload: {
      fileId: "main",
      version: seq,
      code,
      contentHash: `hash-${seq}`,
      language,
      changeReason: "input",
      changeCount: 1,
      flushedBy: "debounce",
    },
  };
}

function languageChangeEvent(
  seq: number,
  from: RecordingLanguage,
  to: RecordingLanguage,
): RecordingEvent {
  return {
    id: `e-${seq}`,
    seq,
    timestampMs: seq * 100,
    source: "editor",
    track: "main",
    type: "language-change",
    payload: { from, to },
  };
}

function selectionChangeEvent(
  seq: number,
  cursor: { lineNumber: number; column: number },
  selection: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  },
): RecordingEvent {
  return {
    id: `e-${seq}`,
    seq,
    timestampMs: seq * 100,
    source: "editor",
    track: "main",
    type: "selection-change",
    payload: { cursor, selection },
  };
}

function editorScrollEvent(seq: number, scrollTop: number, scrollLeft: number): RecordingEvent {
  return {
    id: `e-${seq}`,
    seq,
    timestampMs: seq * 100,
    source: "editor",
    track: "main",
    type: "editor-scroll",
    payload: { scrollTop, scrollLeft },
  };
}

function mediaToggleEvent(seq: number): RecordingEvent {
  return {
    id: `e-${seq}`,
    seq,
    timestampMs: seq * 100,
    source: "media",
    track: "media",
    type: "media-toggle",
    payload: { microphoneEnabled: true, cameraEnabled: true },
  };
}

function runOutputEvent(seq: number): RecordingEvent {
  return {
    id: `e-${seq}`,
    seq,
    timestampMs: seq * 100,
    source: "runtime",
    track: "runtime",
    type: "run-output",
    payload: {
      runId: "run-1",
      stdout: ["ok"],
      stderr: [],
      previewHtml: "<main>P0</main>",
      status: "success",
    },
  };
}

function shortcutEvent(seq: number): RecordingEvent {
  return {
    id: `e-${seq}`,
    seq,
    timestampMs: seq * 100,
    source: "shortcut",
    track: "ui",
    type: "shortcut",
    payload: { keys: ["Meta", "S"], label: "Save", command: "save" },
  };
}
