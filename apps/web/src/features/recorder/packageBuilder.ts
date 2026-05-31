import { canonicalStringify, sha256Hex } from "@/shared/util/hash";
import { generateId } from "@/shared/util/ids";
import {
  buildActivityDensity,
  RECORDING_SCHEMA_VERSION,
  type PackageBuildInput,
  type PackageBuilder,
  type RecordingEvent,
  type RecordingEventType,
  type RecordingIndexes,
  type RecordingMedia,
  type RecordingPackageV1,
  type RecordingSnapshot,
} from "@/shared/recording-schema";

const ALL_EVENT_TYPES: RecordingEventType[] = [
  "record-start",
  "record-pause",
  "record-resume",
  "resume-baseline",
  "record-stop",
  "content-change",
  "language-change",
  "selection-change",
  "editor-scroll",
  "mouse-move",
  "mouse-click",
  "shortcut",
  "media-toggle",
  "media-warning",
  "camera-position",
  "run-start",
  "run-output",
  "run-error",
  "chapter-marker",
];

function dedupeBySeqAndSort(events: RecordingEvent[]): RecordingEvent[] {
  const seen = new Map<number, RecordingEvent>();
  for (const event of events) {
    if (!seen.has(event.seq)) seen.set(event.seq, event);
  }
  return Array.from(seen.values()).sort((a, b) => a.seq - b.seq);
}

function dedupeSnapshots(snapshots: RecordingSnapshot[]): RecordingSnapshot[] {
  const seen = new Map<string, RecordingSnapshot>();
  for (const snapshot of snapshots) {
    if (!seen.has(snapshot.id)) seen.set(snapshot.id, snapshot);
  }
  return Array.from(seen.values()).sort((a, b) => a.timestampMs - b.timestampMs);
}

function buildIndexes(
  events: RecordingEvent[],
  snapshots: RecordingSnapshot[],
  durationMs: number,
): RecordingIndexes {
  const eventsByType: Record<RecordingEventType, number[]> = Object.fromEntries(
    ALL_EVENT_TYPES.map((t) => [t, [] as number[]]),
  ) as Record<RecordingEventType, number[]>;

  for (const event of events) {
    eventsByType[event.type].push(event.seq);
  }
  const snapshotSeqsByTime = snapshots
    .slice()
    .sort((a, b) => a.timestampMs - b.timestampMs)
    .map((s) => s.eventSeq);
  const markers = events
    .filter((event) => event.type === "chapter-marker")
    .map((event) => ({ timestampMs: event.timestampMs, eventSeq: event.seq, type: event.type }));
  return {
    generatedAt: new Date().toISOString(),
    eventsByType,
    snapshotSeqsByTime,
    markers,
    activityDensity: buildActivityDensity(events, durationMs),
  };
}

/**
 * Build a complete RecordingPackageV1 from in-memory recording state.
 *
 * - Dedupes events by `seq` and snapshots by `id` (Producers may double-emit on
 *   subscription bursts; we silently absorb that).
 * - Computes SHA-256 checksums over canonical-JSON of events/snapshots/media so
 *   downstream loaders can detect corruption (ADR-021).
 * - Stamps `manifest.status = "complete"` once build succeeds. Drafts use
 *   `RecordingRepository.saveDraft` directly without invoking the builder.
 */
export function createPackageBuilder(): PackageBuilder {
  return {
    async build(input: PackageBuildInput) {
      const events = dedupeBySeqAndSort(input.events);
      const snapshots = dedupeSnapshots(input.snapshots);

      const eventsSha256 = await sha256Hex(canonicalStringify(events));
      const snapshotsSha256 = await sha256Hex(canonicalStringify(snapshots));

      let mediaBlob: Blob | null = null;
      let media: RecordingMedia | null = null;
      let mediaSha256: string | undefined;
      if (input.media) {
        mediaBlob = input.media.blob;
        const buf = await mediaBlob.arrayBuffer();
        mediaSha256 = await sha256Hex(arrayBufferToBase64(buf));
        media = {
          blobId: generateId("blob"),
          mimeType: input.media.mimeType,
          durationMs: input.media.durationMs,
          sizeBytes: mediaBlob.size,
          timelineOffsetMs: 0,
          hasAudio: input.media.hasAudio,
          hasCamera: input.media.hasCamera,
        };
      }

      const completedAt = new Date().toISOString();
      const indexes = buildIndexes(events, snapshots, input.meta.durationMs);

      const pkg: RecordingPackageV1 = {
        schemaVersion: RECORDING_SCHEMA_VERSION,
        manifest: {
          packageId: generateId("pkg"),
          schemaVersion: RECORDING_SCHEMA_VERSION,
          status: "complete",
          createdAt: input.meta.createdAt,
          completedAt,
          checksums: {
            eventsSha256,
            snapshotsSha256,
            ...(mediaSha256 ? { mediaSha256 } : {}),
          },
        },
        meta: input.meta,
        events,
        snapshots,
        media,
        indexes,
      };
      return { pkg, mediaBlob };
    },
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
  }
  if (typeof btoa === "function") return btoa(binary);
  return Buffer.from(binary, "binary").toString("base64");
}
