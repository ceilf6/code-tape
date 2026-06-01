import JSZip from "jszip";
import {
  RECORDING_SCHEMA_VERSION,
  sha256Blob,
  verifyRecordingPackageIntegrity,
} from "@/shared/recording-schema";
import type {
  PackageLoadResult,
  RecordingEvent,
  RecordingIndexes,
  RecordingListItem,
  RecordingManifest,
  RecordingMedia,
  RecordingMeta,
  RecordingPackageV1,
  RecordingRepository,
  RecordingSnapshot,
  SaveDraftInput,
  SaveResult,
} from "@/shared/recording-schema";
import { generateId } from "@/shared/util/ids";
import { canonicalStringify, sha256Hex } from "@/shared/util/hash";
import { buildRecordingZip } from "./recordingArchive";
import { awaitTransaction, openDatabase, promisifyRequest } from "./idb";
import {
  createVideoThumbnail,
  DEFAULT_VIDEO_THUMBNAIL_OPTIONS,
  type VideoThumbnailOptions,
} from "./videoThumbnail";
import { createReplayThumbnail } from "./replayThumbnail";

export type RecordingStoreOptions = {
  databaseName?: string;
  /** Drafts older than this are removed by sweep(). Defaults to 24h. */
  draftMaxAgeMs?: number;
  /** Media-blob fallback used only when replay thumbnail rendering is unavailable. */
  thumbnailGenerator?: ThumbnailGenerator;
  /** Final replay-state renderer. Pass null to disable replay thumbnails in tests. */
  replayThumbnailGenerator?: ReplayThumbnailGenerator | null;
};

const DEFAULT_DB_NAME = "code-tape";
const DB_VERSION = 2;
const STORE_RECORDINGS = "recordings";
const STORE_BLOBS = "blobs";
const STORE_THUMBNAILS = "thumbnails";

type ThumbnailGenerator = (mediaBlob: Blob, options: VideoThumbnailOptions) => Promise<Blob | null>;
type ReplayThumbnailGenerator = (pkg: RecordingPackageV1, options: VideoThumbnailOptions) => Promise<Blob | null>;
type StoredBlob = { buffer?: ArrayBuffer; dataBase64?: string; mimeType: string };

type StoredRecording = {
  id: string;
  manifest: RecordingManifest;
  meta: RecordingMeta;
  events: RecordingEvent[];
  snapshots: RecordingSnapshot[];
  indexes: RecordingIndexes;
  media: RecordingMedia | null;
  blobId: string | null;
  thumbnailBlobId: string | null;
  createdAtMs: number;
};

/**
 * RecordingRepository backed by IndexedDB with explicit two-phase commit.
 *
 * Lifecycle:
 *   1. saveDraft(input) writes the recording with `manifest.status = "draft"`
 *      and stores the media blob in a sibling object store.
 *   2. commit(recordingId) flips `manifest.status` to `"complete"` in a fresh
 *      transaction.
 * If the page is killed between (1) and (2), the recording stays as draft and
 * sweep() will remove it after `draftMaxAgeMs`.
 *
 * The implementation never starts a long-running async operation inside a
 * single transaction (we collect inputs first, then perform the writes in one
 * tick) to avoid TransactionInactive errors in Chromium.
 */
export function createRecordingStore(options: RecordingStoreOptions = {}): RecordingRepository {
  const databaseName = options.databaseName ?? DEFAULT_DB_NAME;
  const draftMaxAgeMs = options.draftMaxAgeMs ?? 24 * 60 * 60 * 1000;
  const thumbnailGenerator = options.thumbnailGenerator ?? createVideoThumbnail;
  const replayThumbnailGenerator = options.replayThumbnailGenerator === undefined
    ? createReplayThumbnail
    : options.replayThumbnailGenerator;

  const getDb = (() => {
    let cached: Promise<IDBDatabase> | null = null;
    const clearCached = () => {
      cached = null;
    };
    return () => {
      if (!cached) {
        cached = openDatabase({
          name: databaseName,
          version: DB_VERSION,
          onUpgrade(db) {
            if (!db.objectStoreNames.contains(STORE_RECORDINGS)) {
              const recordings = db.createObjectStore(STORE_RECORDINGS, { keyPath: "id" });
              recordings.createIndex("status", "manifest.status", { unique: false });
              recordings.createIndex("createdAtMs", "createdAtMs", { unique: false });
            }
            if (!db.objectStoreNames.contains(STORE_BLOBS)) {
              db.createObjectStore(STORE_BLOBS);
            }
            if (!db.objectStoreNames.contains(STORE_THUMBNAILS)) {
              db.createObjectStore(STORE_THUMBNAILS);
            }
          },
          onVersionChange: clearCached,
        }).catch((err) => {
          clearCached();
          throw err;
        });
      }
      return cached;
    };
  })();

  const readRecording = async (id: string): Promise<StoredRecording | null> => {
    const db = await getDb();
    const tx = db.transaction(STORE_RECORDINGS, "readonly");
    const store = tx.objectStore(STORE_RECORDINGS);
    const value = (await promisifyRequest(store.get(id))) as StoredRecording | undefined;
    await awaitTransaction(tx);
    return value ?? null;
  };

  const readStoredBlob = async (storeName: string, blobId: string): Promise<Blob | null> => {
    const db = await getDb();
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const value = (await promisifyRequest(store.get(blobId))) as StoredBlob | undefined;
    await awaitTransaction(tx);
    if (!value) return null;
    const buffer = value.dataBase64 ? base64ToArrayBuffer(value.dataBase64) : value.buffer;
    return buffer ? new Blob([buffer], { type: value.mimeType }) : null;
  };

  const readBlob = async (blobId: string): Promise<Blob | null> => readStoredBlob(STORE_BLOBS, blobId);

  return {
    async saveDraft(input: SaveDraftInput): Promise<SaveResult> {
      const db = await getDb();
      const recordingId = input.meta.id;
      const blobId = input.mediaBlob ? generateId("blob") : null;
      const shouldGenerateThumbnail =
        replayThumbnailGenerator !== null || (input.mediaBlob !== null && isVideoBlob(input.mediaBlob));
      const eventsSha256 = await sha256Hex(canonicalStringify(input.events));
      const snapshotsSha256 = await sha256Hex(canonicalStringify(input.snapshots));
      // Materialize the blob to ArrayBuffer BEFORE opening the transaction so
      // IDB sees a structured-clone-safe value (some engines lose Blob prototype
      // through structured clone, breaking later .arrayBuffer() reads).
      let bufferToStore: ArrayBuffer | null = null;
      let mediaSha256: string | undefined;
      try {
        bufferToStore = input.mediaBlob ? await input.mediaBlob.arrayBuffer() : null;
        mediaSha256 = bufferToStore
          ? await sha256Blob(new Blob([bufferToStore], { type: input.mediaBlob?.type }))
          : undefined;
      } catch (err) {
        return {
          ok: false,
          reason: "media-write-failed",
          message: formatErrorMessage(err, "media blob could not be prepared for storage"),
        };
      }

      const stored: StoredRecording = {
        id: recordingId,
        manifest: {
          packageId: generateId("pkg"),
          schemaVersion: RECORDING_SCHEMA_VERSION,
          status: "draft",
          createdAt: input.meta.createdAt,
          completedAt: null,
          checksums: {
            eventsSha256,
            snapshotsSha256,
            ...(mediaSha256 ? { mediaSha256 } : {}),
          },
        },
        meta: input.meta,
        events: input.events,
        snapshots: input.snapshots,
        indexes: input.indexes,
        media: input.mediaBlob && blobId
          ? {
              blobId,
              mimeType: input.mediaBlob.type || "application/octet-stream",
              durationMs: input.meta.durationMs,
              sizeBytes: input.mediaBlob.size,
              timelineOffsetMs: 0,
              hasAudio: input.meta.mediaCapability.audio === "available",
              hasCamera: input.meta.mediaCapability.camera === "available",
            }
          : null,
        blobId,
        thumbnailBlobId: null,
        createdAtMs: Date.now(),
      };

      try {
        const tx = db.transaction([STORE_RECORDINGS, STORE_BLOBS], "readwrite");
        const recordings = tx.objectStore(STORE_RECORDINGS);
        const blobs = tx.objectStore(STORE_BLOBS);
        recordings.put(stored);
        if (bufferToStore && blobId && input.mediaBlob) {
          const payload: StoredBlob = {
            dataBase64: arrayBufferToBase64(bufferToStore),
            mimeType: input.mediaBlob.type,
          };
          blobs.put(payload, blobId);
        }
        await awaitTransaction(tx);
        if (shouldGenerateThumbnail) {
          const pkg: RecordingPackageV1 = {
            schemaVersion: RECORDING_SCHEMA_VERSION,
            manifest: stored.manifest,
            meta: stored.meta,
            events: stored.events,
            snapshots: stored.snapshots,
            media: stored.media,
            indexes: stored.indexes,
          };
          void generateAndPersistThumbnail(
            getDb,
            recordingId,
            generateId("thumbnail"),
            input.mediaBlob,
            pkg,
            thumbnailGenerator,
            replayThumbnailGenerator,
          );
        }
        return { ok: true, recordingId };
      } catch (err) {
        const error = err as Error;
        const message = error.message ?? "unknown";
        const isQuota = /QuotaExceededError/i.test(`${error.name}:${message}`);
        return {
          ok: false,
          reason: isQuota ? "quota-exceeded" : "media-write-failed",
          message,
        };
      }
    },

    async commit(recordingId: string): Promise<SaveResult> {
      const db = await getDb();
      try {
        return await new Promise<SaveResult>((resolve) => {
          const tx = db.transaction(STORE_RECORDINGS, "readwrite");
          const recordings = tx.objectStore(STORE_RECORDINGS);
          const request = recordings.get(recordingId);
          let result: SaveResult | null = null;
          request.onsuccess = () => {
            const existing = request.result as StoredRecording | undefined;
            if (!existing) {
              result = { ok: false, reason: "validation-failed", message: "draft not found" };
              return;
            }
            recordings.put({
              ...existing,
              manifest: { ...existing.manifest, status: "complete", completedAt: new Date().toISOString() },
            });
            result = { ok: true, recordingId };
          };
          tx.oncomplete = () => resolve(result ?? { ok: false, reason: "unknown", message: "commit did not complete" });
          tx.onerror = () => resolve({ ok: false, reason: "unknown", message: tx.error?.message ?? "unknown" });
          tx.onabort = () => resolve({ ok: false, reason: "unknown", message: tx.error?.message ?? "unknown" });
        });
      } catch (err) {
        return { ok: false, reason: "unknown", message: (err as Error).message };
      }
    },

    async list(): Promise<RecordingListItem[]> {
      const db = await getDb();
      const tx = db.transaction(STORE_RECORDINGS, "readonly");
      const items = (await promisifyRequest(tx.objectStore(STORE_RECORDINGS).getAll())) as StoredRecording[];
      await awaitTransaction(tx);
      return items
        .filter((item) => item.manifest.status === "complete")
        .sort((a, b) => b.createdAtMs - a.createdAtMs)
        .map((item) => ({
          id: item.id,
          title: item.meta.title,
          createdAt: item.meta.createdAt,
          durationMs: item.meta.durationMs,
          ownerId: item.meta.ownerId,
          creatorInfo: item.meta.creatorInfo,
          initialLanguage: item.meta.initialLanguage,
          hasAudio: item.media?.hasAudio ?? false,
          hasCamera: item.media?.hasCamera ?? false,
          thumbnailBlobId: item.thumbnailBlobId ?? null,
        }));
    },

    async load(recordingId: string): Promise<PackageLoadResult> {
      const stored = await readRecording(recordingId);
      if (!stored) {
        return { ok: false, error: { code: "incomplete-package", packageId: recordingId } };
      }
      if (stored.manifest.status !== "complete") {
        return { ok: false, error: { code: "incomplete-package", packageId: stored.manifest.packageId } };
      }
      const pkg: RecordingPackageV1 = {
        schemaVersion: RECORDING_SCHEMA_VERSION,
        manifest: stored.manifest,
        meta: stored.meta,
        events: stored.events,
        snapshots: stored.snapshots,
        media: stored.media,
        indexes: stored.indexes,
      };
      const mediaBlob = stored.blobId ? await readBlob(stored.blobId) : null;
      return verifyRecordingPackageIntegrity(pkg, mediaBlob);
    },

    async loadThumbnail(thumbnailBlobId: string): Promise<Blob | null> {
      return readStoredBlob(STORE_THUMBNAILS, thumbnailBlobId);
    },

    async rename(recordingId: string, title: string): Promise<void> {
      const db = await getDb();
      const existing = await readRecording(recordingId);
      if (!existing) return;
      const updated: StoredRecording = {
        ...existing,
        meta: { ...existing.meta, title },
      };
      const tx = db.transaction(STORE_RECORDINGS, "readwrite");
      tx.objectStore(STORE_RECORDINGS).put(updated);
      await awaitTransaction(tx);
    },

    async remove(recordingId: string): Promise<void> {
      const db = await getDb();
      const existing = await readRecording(recordingId);
      if (!existing) return;
      const tx = db.transaction([STORE_RECORDINGS, STORE_BLOBS, STORE_THUMBNAILS], "readwrite");
      tx.objectStore(STORE_RECORDINGS).delete(recordingId);
      if (existing.blobId) tx.objectStore(STORE_BLOBS).delete(existing.blobId);
      if (existing.thumbnailBlobId) tx.objectStore(STORE_THUMBNAILS).delete(existing.thumbnailBlobId);
      await awaitTransaction(tx);
    },

    async exportZip(recordingId: string): Promise<Blob> {
      const stored = await readRecording(recordingId);
      if (!stored) throw new Error(`recording ${recordingId} not found`);
      const mediaBlob = stored.blobId ? await readBlob(stored.blobId) : null;
      const thumbnailBlob = stored.thumbnailBlobId
        ? await readStoredBlob(STORE_THUMBNAILS, stored.thumbnailBlobId)
        : null;
      return buildRecordingZip(
        {
          schemaVersion: RECORDING_SCHEMA_VERSION,
          manifest: stored.manifest,
          meta: stored.meta,
          events: stored.events,
          snapshots: stored.snapshots,
          media: stored.media,
          indexes: stored.indexes,
        },
        mediaBlob,
        thumbnailBlob,
      );
    },

    async importZip(zip: Blob): Promise<SaveResult> {
      try {
        const archive = await JSZip.loadAsync(zip);
        const manifestFile = archive.file("manifest.json");
        const metaFile = archive.file("meta.json");
        const eventsFile = archive.file("events.json");
        const snapshotsFile = archive.file("snapshots.json");
        const indexesFile = archive.file("indexes.json");
        const mediaMetaFile = archive.file("media.json");
        if (!manifestFile || !metaFile || !eventsFile || !snapshotsFile) {
          return { ok: false, reason: "validation-failed", message: "incomplete zip" };
        }
        const [manifestRaw, metaRaw, eventsRaw, snapshotsRaw, indexesRaw, mediaMetaRaw] = await Promise.all([
          manifestFile.async("string"),
          metaFile.async("string"),
          eventsFile.async("string"),
          snapshotsFile.async("string"),
          indexesFile?.async("string") ?? Promise.resolve(""),
          mediaMetaFile?.async("string") ?? Promise.resolve(""),
        ]);
        const manifest = JSON.parse(manifestRaw) as RecordingManifest;
        const meta = JSON.parse(metaRaw) as RecordingMeta;
        const events = JSON.parse(eventsRaw) as RecordingEvent[];
        const snapshots = JSON.parse(snapshotsRaw) as RecordingSnapshot[];
        const indexes = indexesRaw ? (JSON.parse(indexesRaw) as RecordingIndexes) : emptyIndexes();
        const mediaFromJson = mediaMetaRaw ? (JSON.parse(mediaMetaRaw) as RecordingMedia) : null;
        const mediaEntry = Object.keys(archive.files).find((n) => n.startsWith("media.") && n !== "media.json");
        const mediaBuffer = mediaEntry ? await archive.file(mediaEntry)!.async("arraybuffer") : null;
        const mediaBlob = mediaBuffer
          ? new Blob([mediaBuffer], { type: mediaFromJson?.mimeType ?? "application/octet-stream" })
          : null;
        const thumbnailEntry = Object.keys(archive.files).find((n) => n.startsWith("thumbnail."));
        const thumbnailBuffer = thumbnailEntry ? await archive.file(thumbnailEntry)!.async("arraybuffer") : null;
        const media = mediaFromJson ?? (mediaBlob && manifest.checksums.mediaSha256
            ? {
                blobId: generateId("blob"),
                mimeType: mediaBlob.type || "application/octet-stream",
                durationMs: meta.durationMs,
                sizeBytes: mediaBlob.size,
                timelineOffsetMs: 0,
                hasAudio: meta.mediaCapability.audio === "available",
                hasCamera: meta.mediaCapability.camera === "available",
              }
            : null);
        const integrity = await verifyRecordingPackageIntegrity(
          {
            schemaVersion: RECORDING_SCHEMA_VERSION,
            manifest,
            meta,
            events,
            snapshots,
            indexes,
            media,
          } satisfies RecordingPackageV1,
          mediaBlob,
        );
        if (!integrity.ok) {
          return {
            ok: false,
            reason: "validation-failed",
            message: "target" in integrity.error
              ? `${integrity.error.code}:${integrity.error.target}`
              : integrity.error.code,
          };
        }
        const saved = await this.saveDraft({ meta, events, snapshots, indexes, mediaBlob });
        if (!saved.ok) return saved;
        const committed = await this.commit(saved.recordingId);
        if (!committed.ok) return committed;
        if (thumbnailBuffer) {
          const db = await getDb();
          await persistThumbnail(db, saved.recordingId, generateId("thumbnail"), {
            dataBase64: arrayBufferToBase64(thumbnailBuffer),
            mimeType: mimeTypeForArchiveEntry(thumbnailEntry),
          });
        }
        return committed;
      } catch (err) {
        return { ok: false, reason: "unknown", message: (err as Error).message };
      }
    },

    async sweep(): Promise<{ removedDrafts: number; removedBlobs: number }> {
      const db = await getDb();
      const tx = db.transaction([STORE_RECORDINGS, STORE_BLOBS, STORE_THUMBNAILS], "readwrite");
      const recordings = tx.objectStore(STORE_RECORDINGS);
      const blobs = tx.objectStore(STORE_BLOBS);
      const thumbnails = tx.objectStore(STORE_THUMBNAILS);
      const all = (await promisifyRequest(recordings.getAll())) as StoredRecording[];
      const allBlobKeys = (await promisifyRequest(blobs.getAllKeys())) as IDBValidKey[];
      const allThumbnailKeys = (await promisifyRequest(thumbnails.getAllKeys())) as IDBValidKey[];
      let removedDrafts = 0;
      let removedBlobs = 0;
      const referencedBlobIds = new Set<string>();
      const referencedThumbnailBlobIds = new Set<string>();
      const now = Date.now();
      for (const item of all) {
        if (item.manifest.status === "draft" && now - item.createdAtMs > draftMaxAgeMs) {
          recordings.delete(item.id);
          if (item.blobId) blobs.delete(item.blobId);
          if (item.thumbnailBlobId) thumbnails.delete(item.thumbnailBlobId);
          removedDrafts += 1;
        } else if (item.blobId) {
          referencedBlobIds.add(item.blobId);
          if (item.thumbnailBlobId) referencedThumbnailBlobIds.add(item.thumbnailBlobId);
        } else if (item.thumbnailBlobId) {
          referencedThumbnailBlobIds.add(item.thumbnailBlobId);
        }
      }
      for (const key of allBlobKeys) {
        if (typeof key === "string" && !referencedBlobIds.has(key)) {
          blobs.delete(key);
          removedBlobs += 1;
        }
      }
      for (const key of allThumbnailKeys) {
        if (typeof key === "string" && !referencedThumbnailBlobIds.has(key)) {
          thumbnails.delete(key);
          removedBlobs += 1;
        }
      }
      await awaitTransaction(tx);
      return { removedDrafts, removedBlobs };
    },

    async estimateQuota(): Promise<{ usageBytes: number; quotaBytes: number }> {
      if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        return { usageBytes: estimate.usage ?? 0, quotaBytes: estimate.quota ?? 0 };
      }
      return { usageBytes: 0, quotaBytes: 0 };
    },
  };
}

function persistThumbnail(
  db: IDBDatabase,
  recordingId: string,
  thumbnailBlobId: string,
  thumbnailPayload: StoredBlob,
): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction([STORE_RECORDINGS, STORE_THUMBNAILS], "readwrite");
      const recordings = tx.objectStore(STORE_RECORDINGS);
      const request = recordings.get(recordingId);
      request.onsuccess = () => {
        const existing = request.result as StoredRecording | undefined;
        if (!existing) return;
        tx.objectStore(STORE_THUMBNAILS).put(thumbnailPayload, thumbnailBlobId);
        recordings.put({ ...existing, thumbnailBlobId });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      // Thumbnail storage is best-effort; the recording and media are already durable.
      resolve();
    }
  });
}

async function generateAndPersistThumbnail(
  getDb: () => Promise<IDBDatabase>,
  recordingId: string,
  thumbnailBlobId: string,
  mediaBlob: Blob | null,
  pkg: RecordingPackageV1,
  thumbnailGenerator: ThumbnailGenerator,
  replayThumbnailGenerator: ReplayThumbnailGenerator | null,
): Promise<void> {
  const thumbnailPayload = await prepareThumbnailPayload(mediaBlob, pkg, thumbnailGenerator, replayThumbnailGenerator);
  if (!thumbnailPayload) return;
  try {
    const db = await getDb();
    await persistThumbnail(db, recordingId, thumbnailBlobId, thumbnailPayload);
  } catch {
    // Reopening the DB can fail after a blocked upgrade; thumbnails remain optional.
  }
}

async function prepareThumbnailPayload(
  mediaBlob: Blob | null,
  pkg: RecordingPackageV1,
  thumbnailGenerator: ThumbnailGenerator,
  replayThumbnailGenerator: ReplayThumbnailGenerator | null,
): Promise<StoredBlob | null> {
  try {
    const replayThumbnail = replayThumbnailGenerator
      ? await replayThumbnailGenerator(pkg, DEFAULT_VIDEO_THUMBNAIL_OPTIONS).catch(() => null)
      : null;
    const thumbnail = replayThumbnail ??
      (mediaBlob && isVideoBlob(mediaBlob)
        ? await thumbnailGenerator(mediaBlob, DEFAULT_VIDEO_THUMBNAIL_OPTIONS)
        : null);
    if (!thumbnail || thumbnail.size === 0) return null;
    const buffer = await thumbnail.arrayBuffer();
    return {
      dataBase64: arrayBufferToBase64(buffer),
      mimeType: thumbnail.type || DEFAULT_VIDEO_THUMBNAIL_OPTIONS.mimeType,
    };
  } catch {
    return null;
  }
}

function isVideoBlob(blob: Blob): boolean {
  return blob.type.toLowerCase().startsWith("video/");
}

function mimeTypeForArchiveEntry(entryName: string | undefined): string {
  const lower = entryName?.toLowerCase() ?? "";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return DEFAULT_VIDEO_THUMBNAIL_OPTIONS.mimeType;
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

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = typeof atob === "function"
    ? atob(base64)
    : Buffer.from(base64, "base64").toString("binary");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function formatErrorMessage(err: unknown, fallback: string): string {
  const error = err as { name?: unknown; message?: unknown };
  const name = typeof error.name === "string" ? error.name.trim() : "";
  const message = typeof error.message === "string" ? error.message.trim() : "";
  if (name && message) return `${name}: ${message}`;
  if (name) return `${name}: ${fallback}`;
  if (message) return message;
  const text = typeof err === "string" ? err.trim() : "";
  return text || fallback;
}

function emptyIndexes(): RecordingIndexes {
  return {
    generatedAt: new Date().toISOString(),
    eventsByType: {
      "record-start": [],
      "record-pause": [],
      "record-resume": [],
      "resume-baseline": [],
      "record-stop": [],
      "content-change": [],
      "language-change": [],
      "selection-change": [],
      "editor-scroll": [],
      "mouse-move": [],
      "mouse-click": [],
      "shortcut": [],
      "media-toggle": [],
      "media-warning": [],
      "camera-position": [],
      "run-start": [],
      "run-output": [],
      "run-error": [],
      "chapter-marker": [],
    },
    snapshotSeqsByTime: [],
    markers: [],
  };
}
