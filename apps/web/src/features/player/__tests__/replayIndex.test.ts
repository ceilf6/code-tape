import { describe, expect, it } from "vitest";
import {
  buildReplayIndex,
  findSnapshotAtMost,
  findStableEventIndexAtMost,
} from "../replayIndex";
import type { RecordingPackageV1, RecordingSnapshot } from "@/shared/recording-schema";
import { RECORDING_SCHEMA_VERSION } from "@/shared/recording-schema";

function pkgFrom(
  events: RecordingPackageV1["events"],
  snapshots: RecordingSnapshot[],
  durationMs = 1000,
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
    media: null,
  };
}

describe("buildReplayIndex", () => {
  it("indexes events by type and separates stable vs transient", () => {
    const events: RecordingPackageV1["events"] = [
      {
        id: "1",
        seq: 1,
        timestampMs: 100,
        source: "editor",
        track: "main",
        type: "content-change",
        payload: {
          fileId: "main",
          version: 1,
          code: "a",
          contentHash: "a",
          language: "javascript",
          changeReason: "input",
          changeCount: 1,
          flushedBy: "debounce",
        },
      },
      {
        id: "2",
        seq: 2,
        timestampMs: 200,
        source: "pointer",
        track: "ui",
        type: "mouse-move",
        payload: { x: 1, y: 2, containerWidth: 1, containerHeight: 1 },
      },
    ];
    const index = buildReplayIndex(pkgFrom(events, [], 30_000));
    expect(index.eventsBySeq.length).toBe(2);
    expect(index.eventsByType.get("content-change")?.length).toBe(1);
    expect(index.stableEventsByTime.length).toBe(1);
  });

  it("rebuilds activity density from events when package indexes are absent", () => {
    const events: RecordingPackageV1["events"] = [
      {
        id: "1",
        seq: 1,
        timestampMs: 100,
        source: "editor",
        track: "main",
        type: "content-change",
        payload: {
          fileId: "main",
          version: 1,
          code: "a",
          contentHash: "a",
          language: "javascript",
          changeReason: "input",
          changeCount: 1,
          flushedBy: "debounce",
        },
      },
      {
        id: "2",
        seq: 2,
        timestampMs: 12_000,
        source: "runtime",
        track: "runtime",
        type: "run-error",
        payload: {
          runId: "run-1",
          phase: "runtime",
          message: "boom",
          stdout: [],
          stderr: ["boom"],
          previewHtml: null,
        },
      },
    ];

    const index = buildReplayIndex(pkgFrom(events, [], 30_000));

    expect(index.activityDensity).toEqual(
      expect.arrayContaining([
        { kind: "edit", startMs: 0, endMs: 10_000, count: 1, eventSeqs: [1] },
        { kind: "error", startMs: 10_000, endMs: 20_000, count: 1, eventSeqs: [2] },
      ]),
    );
  });

  it("rebuilds activity density when the packaged index is an empty placeholder", () => {
    const events: RecordingPackageV1["events"] = [
      {
        id: "1",
        seq: 1,
        timestampMs: 12_000,
        source: "editor",
        track: "main",
        type: "content-change",
        payload: {
          fileId: "main",
          version: 1,
          code: "a",
          contentHash: "a",
          language: "javascript",
          changeReason: "input",
          changeCount: 1,
          flushedBy: "debounce",
        },
      },
    ];
    const pkg = pkgFrom(events, [], 30_000);
    pkg.indexes = {
      generatedAt: "2026-05-24T00:00:00.000Z",
      eventsByType: {} as NonNullable<RecordingPackageV1["indexes"]>["eventsByType"],
      snapshotSeqsByTime: [],
      markers: [],
      activityDensity: [],
    };

    const index = buildReplayIndex(pkg);

    expect(index.activityDensity).toEqual(
      expect.arrayContaining([
        { kind: "edit", startMs: 10_000, endMs: 20_000, count: 1, eventSeqs: [1] },
      ]),
    );
  });

  it("rebuilds activity density when the packaged index has malformed buckets", () => {
    const events: RecordingPackageV1["events"] = [
      {
        id: "1",
        seq: 1,
        timestampMs: 12_000,
        source: "editor",
        track: "main",
        type: "content-change",
        payload: {
          fileId: "main",
          version: 1,
          code: "a",
          contentHash: "a",
          language: "javascript",
          changeReason: "input",
          changeCount: 1,
          flushedBy: "debounce",
        },
      },
    ];
    const pkg = pkgFrom(events, [], 30_000);
    pkg.indexes = {
      generatedAt: "2026-05-24T00:00:00.000Z",
      eventsByType: {} as NonNullable<RecordingPackageV1["indexes"]>["eventsByType"],
      snapshotSeqsByTime: [],
      markers: [],
      activityDensity: [{ kind: "bad", startMs: "0", eventSeqs: null } as never],
    };

    const index = buildReplayIndex(pkg);

    expect(index.activityDensity).toEqual(
      expect.arrayContaining([
        { kind: "edit", startMs: 10_000, endMs: 20_000, count: 1, eventSeqs: [1] },
      ]),
    );
  });
});

describe("findSnapshotAtMost", () => {
  const snapshots: RecordingSnapshot[] = [
    { id: "a", timestampMs: 100, eventSeq: 1, state: {} as never },
    { id: "b", timestampMs: 300, eventSeq: 5, state: {} as never },
    { id: "c", timestampMs: 500, eventSeq: 9, state: {} as never },
  ];
  it("returns null when target is before any snapshot", () => {
    expect(findSnapshotAtMost(snapshots, 50)).toBeNull();
  });
  it("returns the latest snapshot before target", () => {
    expect(findSnapshotAtMost(snapshots, 400)?.id).toBe("b");
    expect(findSnapshotAtMost(snapshots, 500)?.id).toBe("c");
    expect(findSnapshotAtMost(snapshots, 600)?.id).toBe("c");
  });
});

describe("findStableEventIndexAtMost", () => {
  const events = [
    { timestampMs: 0 },
    { timestampMs: 100 },
    { timestampMs: 200 },
    { timestampMs: 300 },
  ] as unknown as Parameters<typeof findStableEventIndexAtMost>[0];
  it("binary-searches the boundary", () => {
    expect(findStableEventIndexAtMost(events, -1)).toBe(-1);
    expect(findStableEventIndexAtMost(events, 0)).toBe(0);
    expect(findStableEventIndexAtMost(events, 150)).toBe(1);
    expect(findStableEventIndexAtMost(events, 250)).toBe(2);
    expect(findStableEventIndexAtMost(events, 9999)).toBe(3);
  });
});
