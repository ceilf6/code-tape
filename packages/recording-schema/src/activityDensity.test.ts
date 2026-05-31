import assert from "node:assert/strict";
import test from "node:test";
import { buildActivityDensity } from "./activityDensity.js";
import type { RecordingEvent } from "./types.js";

test("buildActivityDensity groups edit, shortcut, run, and error activity into timeline buckets", () => {
  const density = buildActivityDensity(
    [
      contentEvent(1, 1_000),
      shortcutEvent(2, 2_000),
      runStartEvent(3, 12_000),
      runErrorEvent(4, 13_000),
    ],
    30_000,
    { bucketSizeMs: 10_000, silenceGapMs: 10_000 },
  );

  assert.deepEqual(
    density.filter((bucket) => bucket.kind !== "silence"),
    [
      { kind: "edit", startMs: 0, endMs: 10_000, count: 1, eventSeqs: [1] },
      { kind: "shortcut", startMs: 0, endMs: 10_000, count: 1, eventSeqs: [2] },
      { kind: "run", startMs: 10_000, endMs: 20_000, count: 1, eventSeqs: [3] },
      { kind: "error", startMs: 10_000, endMs: 20_000, count: 1, eventSeqs: [4] },
    ],
  );
});

test("buildActivityDensity emits silence buckets for long gaps and trailing quiet time", () => {
  const density = buildActivityDensity(
    [contentEvent(1, 1_000), runStartEvent(2, 28_000)],
    45_000,
    { bucketSizeMs: 10_000, silenceGapMs: 10_000 },
  );

  assert.deepEqual(
    density.filter((bucket) => bucket.kind === "silence"),
    [
      { kind: "silence", startMs: 10_000, endMs: 20_000, count: 0, eventSeqs: [] },
      { kind: "silence", startMs: 30_000, endMs: 45_000, count: 0, eventSeqs: [] },
    ],
  );
});

test("buildActivityDensity emits non-overlapping leading silence before the first activity", () => {
  const density = buildActivityDensity([contentEvent(1, 18_000)], 30_000, {
    bucketSizeMs: 10_000,
    silenceGapMs: 10_000,
  });

  assert.deepEqual(
    density.filter((bucket) => bucket.kind === "silence"),
    [
      { kind: "silence", startMs: 0, endMs: 10_000, count: 0, eventSeqs: [] },
      { kind: "silence", startMs: 20_000, endMs: 30_000, count: 0, eventSeqs: [] },
    ],
  );
});

test("buildActivityDensity emits full-duration silence when no activity is present", () => {
  const density = buildActivityDensity([], 30_000, {
    bucketSizeMs: 10_000,
    silenceGapMs: 10_000,
  });

  assert.deepEqual(density, [
    { kind: "silence", startMs: 0, endMs: 30_000, count: 0, eventSeqs: [] },
  ]);
});

test("buildActivityDensity emits full-duration silence for short recordings with no activity", () => {
  const density = buildActivityDensity([], 5_000, {
    bucketSizeMs: 10_000,
    silenceGapMs: 10_000,
  });

  assert.deepEqual(density, [
    { kind: "silence", startMs: 0, endMs: 5_000, count: 0, eventSeqs: [] },
  ]);
});

test("buildActivityDensity keeps late activity buckets inside the replay duration", () => {
  const density = buildActivityDensity([runStartEvent(1, 35_000)], 30_000, {
    bucketSizeMs: 10_000,
    silenceGapMs: 10_000,
  });

  assert.deepEqual(
    density.filter((bucket) => bucket.kind === "run"),
    [{ kind: "run", startMs: 20_000, endMs: 30_000, count: 1, eventSeqs: [1] }],
  );
});

test("buildActivityDensity orders same-range activity so higher-priority markers render last", () => {
  const density = buildActivityDensity([runErrorEvent(1, 1_000), contentEvent(2, 2_000)], 10_000, {
    bucketSizeMs: 10_000,
    silenceGapMs: 10_000,
  });

  assert.deepEqual(
    density.filter((bucket) => bucket.kind !== "silence").map((bucket) => bucket.kind),
    ["edit", "error"],
  );
});

function contentEvent(seq: number, timestampMs: number): RecordingEvent {
  return {
    id: `content-${seq}`,
    seq,
    timestampMs,
    source: "editor",
    track: "main",
    type: "content-change",
    payload: {
      fileId: "main",
      version: seq,
      code: "console.log('activity')",
      contentHash: `hash-${seq}`,
      language: "javascript",
      changeReason: "input",
      changeCount: 1,
      flushedBy: "debounce",
    },
  };
}

function shortcutEvent(seq: number, timestampMs: number): RecordingEvent {
  return {
    id: `shortcut-${seq}`,
    seq,
    timestampMs,
    source: "shortcut",
    track: "ui",
    type: "shortcut",
    payload: { keys: ["Mod", "Enter"], label: "Cmd Enter", command: "run" },
  };
}

function runStartEvent(seq: number, timestampMs: number): RecordingEvent {
  return {
    id: `run-${seq}`,
    seq,
    timestampMs,
    source: "runtime",
    track: "runtime",
    type: "run-start",
    payload: { language: "javascript", runtime: "iframe", runId: `run-${seq}` },
  };
}

function runErrorEvent(seq: number, timestampMs: number): RecordingEvent {
  return {
    id: `error-${seq}`,
    seq,
    timestampMs,
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
