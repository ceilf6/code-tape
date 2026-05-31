import type {
  ActivityDensityBucket,
  ActivityDensityKind,
  RecordingEvent,
  RecordingEventType,
} from "./types.js";

const DEFAULT_BUCKET_SIZE_MS = 10_000;
const DEFAULT_SILENCE_GAP_MS = 10_000;

const EVENT_KIND_BY_TYPE: Partial<Record<RecordingEventType, ActivityDensityKind>> = {
  "content-change": "edit",
  "language-change": "edit",
  "selection-change": "edit",
  "editor-scroll": "edit",
  "run-start": "run",
  "run-output": "run",
  "run-error": "error",
  shortcut: "shortcut",
};

export type BuildActivityDensityOptions = {
  bucketSizeMs?: number;
  silenceGapMs?: number;
};

export function buildActivityDensity(
  events: RecordingEvent[],
  durationMs: number,
  options: BuildActivityDensityOptions = {},
): ActivityDensityBucket[] {
  const bucketSizeMs = positiveOrDefault(options.bucketSizeMs, DEFAULT_BUCKET_SIZE_MS);
  const silenceGapMs = positiveOrDefault(options.silenceGapMs, DEFAULT_SILENCE_GAP_MS);
  const safeDurationMs = Math.max(0, durationMs);
  const sortedActivities = events
    .flatMap((event) => {
      const kind = EVENT_KIND_BY_TYPE[event.type];
      return kind ? [{ event, kind }] : [];
    })
    .sort(
      (left, right) =>
        left.event.timestampMs - right.event.timestampMs || left.event.seq - right.event.seq,
    );

  const buckets = new Map<string, ActivityDensityBucket>();
  for (const activity of sortedActivities) {
    const { startMs, endMs } = activityBucketRange(
      activity.event.timestampMs,
      bucketSizeMs,
      safeDurationMs,
    );
    const key = `${activity.kind}:${startMs}:${endMs}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
      existing.eventSeqs.push(activity.event.seq);
    } else {
      buckets.set(key, {
        kind: activity.kind,
        startMs,
        endMs,
        count: 1,
        eventSeqs: [activity.event.seq],
      });
    }
  }

  const silenceBuckets: ActivityDensityBucket[] = [];
  const firstActivity = sortedActivities[0];
  if (!firstActivity) {
    if (safeDurationMs > 0) {
      silenceBuckets.push(silenceBucket(0, safeDurationMs));
    }
  } else {
    const firstRange = activityBucketRange(firstActivity.event.timestampMs, bucketSizeMs, safeDurationMs);
    if (safeDurationMs > 0 && firstRange.startMs >= silenceGapMs) {
      silenceBuckets.push(silenceBucket(0, firstRange.startMs));
    }
  }
  for (let index = 1; index < sortedActivities.length; index += 1) {
    const previous = activityBucketRange(
      sortedActivities[index - 1].event.timestampMs,
      bucketSizeMs,
      safeDurationMs,
    );
    const next = activityBucketRange(
      sortedActivities[index].event.timestampMs,
      bucketSizeMs,
      safeDurationMs,
    );
    if (next.startMs - previous.endMs >= silenceGapMs) {
      silenceBuckets.push(silenceBucket(previous.endMs, next.startMs));
    }
  }
  const lastActivity = sortedActivities.at(-1);
  if (lastActivity) {
    const lastRange = activityBucketRange(lastActivity.event.timestampMs, bucketSizeMs, safeDurationMs);
    if (safeDurationMs > 0 && safeDurationMs - lastRange.endMs >= silenceGapMs) {
      silenceBuckets.push(silenceBucket(lastRange.endMs, safeDurationMs));
    }
  }

  return [...buckets.values(), ...silenceBuckets].sort(
    (left, right) =>
      left.startMs - right.startMs ||
      left.endMs - right.endMs ||
      kindPriority(right.kind) - kindPriority(left.kind) ||
      firstEventSeq(left) - firstEventSeq(right),
  );
}

function activityBucketRange(
  timestampMs: number,
  bucketSizeMs: number,
  safeDurationMs: number,
): { startMs: number; endMs: number } {
  if (safeDurationMs <= 0) return { startMs: 0, endMs: 0 };
  const clampedTimestampMs = Math.min(Math.max(0, timestampMs), safeDurationMs - 1);
  const startMs = Math.floor(clampedTimestampMs / bucketSizeMs) * bucketSizeMs;
  const endMs = Math.min(safeDurationMs, startMs + bucketSizeMs);
  return { startMs, endMs };
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function silenceBucket(startMs: number, endMs: number): ActivityDensityBucket {
  return {
    kind: "silence",
    startMs: Math.max(0, startMs),
    endMs: Math.max(0, endMs),
    count: 0,
    eventSeqs: [],
  };
}

function firstEventSeq(bucket: ActivityDensityBucket): number {
  return bucket.eventSeqs[0] ?? Number.MAX_SAFE_INTEGER;
}

function kindPriority(kind: ActivityDensityKind): number {
  switch (kind) {
    case "error":
      return 0;
    case "run":
      return 1;
    case "shortcut":
      return 2;
    case "edit":
      return 3;
    case "silence":
      return 4;
  }
}
