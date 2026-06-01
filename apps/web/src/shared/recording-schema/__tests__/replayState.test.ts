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

function contentChangeEvent(seq: number, code: string): RecordingEvent {
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
      language: "javascript",
      changeReason: "input",
      changeCount: 1,
      flushedBy: "debounce",
    },
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
