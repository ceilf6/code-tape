import type {
  ActivityDensityBucket,
  RecordingEvent,
  RecordingEventType,
  RecordingPackageV1,
  RecordingSnapshot,
  ReplayIndex,
} from "@/shared/recording-schema";
import { buildActivityDensity } from "@/shared/recording-schema";
import { STABLE_EVENT_TYPES } from "./replayReducer";

/**
 * Build per-package lookup structures the scheduler uses to seek/replay fast.
 *
 * All collections are sorted ascending by either `seq` or `timestampMs`,
 * matching the type contract in shared/recording-schema/types.ts.
 */
export function buildReplayIndex(pkg: RecordingPackageV1): ReplayIndex {
  const eventsBySeq = pkg.events.slice().sort((a, b) => a.seq - b.seq);
  const eventsByType = new Map<RecordingEventType, RecordingEvent[]>();
  for (const event of eventsBySeq) {
    const list = eventsByType.get(event.type);
    if (list) list.push(event);
    else eventsByType.set(event.type, [event]);
  }
  const snapshotsByTime = pkg.snapshots.slice().sort((a, b) => a.timestampMs - b.timestampMs);
  const stableEventsByTime = eventsBySeq
    .filter((event) => STABLE_EVENT_TYPES.has(event.type))
    .sort((a, b) => a.timestampMs - b.timestampMs);
  const markersByTime = (eventsByType.get("chapter-marker") ?? []).slice();
  const activityDensity = buildReplayActivityDensity(pkg);
  return {
    eventsBySeq,
    eventsByType,
    snapshotsByTime,
    stableEventsByTime,
    markersByTime,
    activityDensity,
  };
}

export function buildReplayActivityDensity(pkg: RecordingPackageV1): ActivityDensityBucket[] {
  const packagedActivityDensity = pkg.indexes?.activityDensity as unknown;
  const activityDensity =
    isValidPackagedActivityDensity(packagedActivityDensity)
      ? packagedActivityDensity
      : buildActivityDensity(pkg.events, pkg.meta.durationMs);
  return normalizeActivityDensity(activityDensity);
}

const ACTIVITY_DENSITY_KINDS = new Set(["edit", "run", "error", "shortcut", "silence"]);

function isValidPackagedActivityDensity(value: unknown): value is ActivityDensityBucket[] {
  return Array.isArray(value) && value.length > 0 && value.every(isValidActivityDensityBucket);
}

function isValidActivityDensityBucket(value: unknown): value is ActivityDensityBucket {
  if (!value || typeof value !== "object") return false;
  const bucket = value as Partial<ActivityDensityBucket>;
  return (
    typeof bucket.kind === "string" &&
    ACTIVITY_DENSITY_KINDS.has(bucket.kind) &&
    isNonNegativeFiniteNumber(bucket.startMs) &&
    isNonNegativeFiniteNumber(bucket.endMs) &&
    bucket.endMs >= bucket.startMs &&
    isNonNegativeFiniteNumber(bucket.count) &&
    Array.isArray(bucket.eventSeqs) &&
    bucket.eventSeqs.every(Number.isFinite)
  );
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeActivityDensity(activityDensity: ActivityDensityBucket[]): ActivityDensityBucket[] {
  return activityDensity
    .slice()
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
}

/** Find the snapshot whose timestamp is the greatest one `<= targetMs`. */
export function findSnapshotAtMost(
  snapshots: RecordingSnapshot[],
  targetMs: number,
): RecordingSnapshot | null {
  let lo = 0;
  let hi = snapshots.length - 1;
  let best: RecordingSnapshot | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = snapshots[mid];
    if (candidate.timestampMs <= targetMs) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Find the index of the last stable event whose timestamp is `<= targetMs`. -1 if none. */
export function findStableEventIndexAtMost(stableEvents: RecordingEvent[], targetMs: number): number {
  let lo = 0;
  let hi = stableEvents.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = stableEvents[mid];
    if (candidate.timestampMs <= targetMs) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
