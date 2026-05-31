import { describe, expect, it } from "vitest";
import { createPackageBuilder } from "../packageBuilder";
import { validateRecordingPackageV1 } from "@/shared/recording-schema";
import type {
  RecordingEvent,
  RecordingMeta,
  RecordingSnapshot,
} from "@/shared/recording-schema";

function makeMeta(): RecordingMeta {
  return {
    id: "rec-1",
    title: "test",
    createdAt: "2026-05-24T00:00:00.000Z",
    durationMs: 1000,
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
  };
}

function makeContentEvent(seq: number, code: string): RecordingEvent {
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
      contentHash: code,
      language: "javascript",
      changeReason: "input",
      changeCount: 1,
      flushedBy: "debounce",
    },
  };
}

function makeMarker(seq: number, ts: number, title: string): RecordingEvent {
  return {
    id: `m-${seq}`,
    seq,
    timestampMs: ts,
    source: "annotation",
    track: "ui",
    type: "chapter-marker",
    payload: { title },
  };
}

function makeRunStart(seq: number, ts: number): RecordingEvent {
  return {
    id: `run-${seq}`,
    seq,
    timestampMs: ts,
    source: "runtime",
    track: "runtime",
    type: "run-start",
    payload: { language: "javascript", runtime: "iframe", runId: `run-${seq}` },
  };
}

function makeRunError(seq: number, ts: number): RecordingEvent {
  return {
    id: `error-${seq}`,
    seq,
    timestampMs: ts,
    source: "runtime",
    track: "runtime",
    type: "run-error",
    payload: {
      runId: `run-${seq}`,
      phase: "runtime",
      message: "boom",
      stdout: [],
      stderr: ["boom"],
      previewHtml: null,
    },
  };
}

function makeSnapshot(id: string, ts: number, eventSeq: number): RecordingSnapshot {
  return {
    id,
    timestampMs: ts,
    eventSeq,
    state: {
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
    },
  };
}

describe("createPackageBuilder", () => {
  it("produces a valid v1 package and stamps manifest checksums", async () => {
    const builder = createPackageBuilder();
    const events = [makeContentEvent(1, "a"), makeContentEvent(2, "ab")];
    const snapshots = [makeSnapshot("snap-1", 200, 2)];

    const { pkg, mediaBlob } = await builder.build({ meta: makeMeta(), events, snapshots, media: null });

    expect(mediaBlob).toBeNull();
    expect(pkg.manifest.status).toBe("complete");
    expect(pkg.manifest.checksums.eventsSha256).toMatch(/^[0-9a-f]+$/);
    expect(pkg.manifest.checksums.snapshotsSha256).toMatch(/^[0-9a-f]+$/);
    expect(validateRecordingPackageV1(pkg).ok).toBe(true);
  });

  it("dedupes events by seq and sorts ascending", async () => {
    const builder = createPackageBuilder();
    const events = [makeContentEvent(3, "c"), makeContentEvent(1, "a"), makeContentEvent(1, "duplicate"), makeContentEvent(2, "b")];
    const { pkg } = await builder.build({ meta: makeMeta(), events, snapshots: [], media: null });
    expect(pkg.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(pkg.events.length).toBe(3);
  });

  it("indexes events by type and aggregates markers", async () => {
    const builder = createPackageBuilder();
    const events: RecordingEvent[] = [
      makeContentEvent(1, "a"),
      makeMarker(2, 500, "intro"),
      makeContentEvent(3, "ab"),
      makeMarker(4, 1500, "wrap-up"),
    ];
    const { pkg } = await builder.build({ meta: makeMeta(), events, snapshots: [], media: null });
    expect(pkg.indexes?.eventsByType["chapter-marker"]).toEqual([2, 4]);
    expect(pkg.indexes?.eventsByType["content-change"]).toEqual([1, 3]);
    expect(pkg.indexes?.markers.map((m) => m.timestampMs)).toEqual([500, 1500]);
    expect(pkg.indexes?.markers.map((m) => m.eventSeq)).toEqual([2, 4]);
  });

  it("includes activity density buckets in generated indexes", async () => {
    const builder = createPackageBuilder();
    const events: RecordingEvent[] = [
      makeContentEvent(1, "a"),
      makeRunStart(2, 12_000),
      makeRunError(3, 13_000),
    ];

    const { pkg } = await builder.build({
      meta: { ...makeMeta(), durationMs: 30_000 },
      events,
      snapshots: [],
      media: null,
    });

    expect(pkg.indexes?.activityDensity).toEqual(
      expect.arrayContaining([
        { kind: "edit", startMs: 0, endMs: 10_000, count: 1, eventSeqs: [1] },
        { kind: "run", startMs: 10_000, endMs: 20_000, count: 1, eventSeqs: [2] },
        { kind: "error", startMs: 10_000, endMs: 20_000, count: 1, eventSeqs: [3] },
      ]),
    );
  });

  it("includes media metadata + media checksum when media is provided", async () => {
    const builder = createPackageBuilder();
    const blob = new Blob(["hello"], { type: "audio/webm" });
    const { pkg, mediaBlob } = await builder.build({
      meta: makeMeta(),
      events: [],
      snapshots: [],
      media: { blob, durationMs: 1000, mimeType: "audio/webm", hasAudio: true, hasCamera: false },
    });
    expect(mediaBlob).toBe(blob);
    expect(pkg.media?.mimeType).toBe("audio/webm");
    expect(pkg.media?.sizeBytes).toBe(blob.size);
    expect(pkg.manifest.checksums.mediaSha256).toMatch(/^[0-9a-f]+$/);
  });
});
