import "fake-indexeddb/auto";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRecordingStore } from "../recordingStore";
import type {
  RecordingEvent,
  RecordingIndexes,
  RecordingListItem,
  RecordingMeta,
  RecordingSnapshot,
  RecordingRepository,
  SaveDraftInput,
} from "@/shared/recording-schema";

function makeMeta(id = "rec-1"): RecordingMeta {
  return {
    id,
    title: "demo",
    createdAt: "2026-05-24T00:00:00.000Z",
    durationMs: 5_000,
    appVersion: "0.0.0",
    ownerId: null,
    creatorInfo: { displayName: "ceilf6", source: "local" },
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

function makeEvent(seq: number): RecordingEvent {
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
      code: `v${seq}`,
      contentHash: `h${seq}`,
      language: "javascript",
      changeReason: "input",
      changeCount: 1,
      flushedBy: "debounce",
    },
  };
}

function makeUnsupportedMediaWarning(seq: number): RecordingEvent {
  return {
    id: `e-${seq}`,
    seq,
    timestampMs: seq * 100,
    source: "media",
    track: "media",
    type: "media-warning",
    payload: {
      target: "camera",
      code: "unsupported",
      message: "Camera is unsupported",
    },
  };
}

function emptyIndexes(): RecordingIndexes {
  return {
    generatedAt: "2026-05-24T00:00:00.000Z",
    eventsByType: {} as Record<string, number[]>,
    snapshotSeqsByTime: [],
    markers: [],
  } as RecordingIndexes;
}

function makeSnapshot(eventSeq: number): RecordingSnapshot {
  return {
    id: `snap-${eventSeq}`,
    timestampMs: eventSeq * 100,
    eventSeq,
    state: {
      editor: {
        code: `v${eventSeq}`,
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

function makeInput(metaId = "rec-1"): SaveDraftInput {
  return {
    meta: makeMeta(metaId),
    events: [makeEvent(1), makeEvent(2)],
    snapshots: [makeSnapshot(2)],
    indexes: emptyIndexes(),
    mediaBlob: new Blob(["binary"], { type: "audio/webm" }),
  };
}

let dbCounter = 0;
function uniqueDbName() {
  dbCounter += 1;
  return `code-tape-test-${dbCounter}`;
}

beforeEach(() => {
  /* fake-indexeddb auto-wipes; nothing to do, each test uses a unique db name */
});

afterEach(async () => {
  /* fake-indexeddb already gives us isolated databases through name uniqueness */
});

describe("createRecordingStore — two-phase commit", () => {
  it("saveDraft stores recording with manifest.status=draft and list excludes it", async () => {
    const store = createRecordingStore({ databaseName: uniqueDbName() });
    const result = await store.saveDraft(makeInput("rec-draft"));
    expect(result.ok).toBe(true);
    const list = await store.list();
    expect(list.length).toBe(0); // drafts are invisible to list
  });

  it("commit transitions the draft to complete and list surfaces it", async () => {
    const store = createRecordingStore({ databaseName: uniqueDbName() });
    await store.saveDraft(makeInput("rec-1"));
    await store.commit("rec-1");
    const list = await store.list();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe("rec-1");
  });

  it("load round-trips the package and validates it", async () => {
    const store = createRecordingStore({ databaseName: uniqueDbName() });
    await store.saveDraft(makeInput("rec-1"));
    await store.commit("rec-1");
    const result = await store.load("rec-1");
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.package.meta.id).toBe("rec-1");
      expect(result.package.events.length).toBe(2);
      expect(result.package.manifest.status).toBe("complete");
    }
  });

  it("load returns the verified media blob for replay", async () => {
    const store = createRecordingStore({ databaseName: uniqueDbName() });
    await store.saveDraft(makeInput("rec-media"));
    await store.commit("rec-media");

    const result = await store.load("rec-media");

    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.mediaBlob).toBeInstanceOf(Blob);
    const buffer = await result.mediaBlob!.arrayBuffer();
    expect(new TextDecoder().decode(buffer)).toBe("binary");
  });

  it("generates and lists a thumbnail for saved video media", async () => {
    const thumbnailBlob = new Blob(["thumbnail"], { type: "image/webp" });
    const thumbnailGenerator = vi.fn(async () => thumbnailBlob);
    const store = createRecordingStore({
      databaseName: uniqueDbName(),
      thumbnailGenerator,
    });
    const input = makeInput("rec-thumbnail");
    input.mediaBlob = new Blob(["video"], { type: "video/webm" });

    await store.saveDraft(input);
    await store.commit("rec-thumbnail");

    expect(thumbnailGenerator).toHaveBeenCalledWith(
      input.mediaBlob,
      expect.objectContaining({ width: 320, height: 180, mimeType: "image/webp" }),
    );
    const item = await waitForListedRecordingWithThumbnail(store, "rec-thumbnail");
    expect(item?.thumbnailBlobId).toMatch(/^thumbnail-/);
    const thumbnail = await store.loadThumbnail(item!.thumbnailBlobId!);
    expect(thumbnail).toBeInstanceOf(Blob);
    expect(thumbnail?.type).toBe("image/webp");
    expect(new TextDecoder().decode(await thumbnail!.arrayBuffer())).toBe("thumbnail");
  });

  it("returns after writing the draft before optional video thumbnail generation settles", async () => {
    let resolveThumbnail!: (thumbnail: Blob | null) => void;
    const thumbnailPromise = new Promise<Blob | null>((resolve) => {
      resolveThumbnail = resolve;
    });
    const dbName = uniqueDbName();
    const store = createRecordingStore({
      databaseName: dbName,
      thumbnailGenerator: vi.fn(() => thumbnailPromise),
    });
    const input = makeInput("rec-thumbnail-background");
    input.mediaBlob = new Blob(["video"], { type: "video/webm" });

    const saving = store.saveDraft(input);

    const draft = await waitForRawRecording(dbName, "rec-thumbnail-background");
    expect(draft?.manifest.status).toBe("draft");
    expect(draft?.thumbnailBlobId).toBeNull();

    const earlySaveResult = await Promise.race([
      saving.then((result) => result),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 10)),
    ]);
    if (earlySaveResult === "pending") {
      resolveThumbnail(null);
      await saving;
    }
    expect(earlySaveResult).not.toBe("pending");
    if (earlySaveResult !== "pending" && !earlySaveResult.ok) {
      throw new Error(earlySaveResult.message);
    }
    await store.commit("rec-thumbnail-background");

    resolveThumbnail(new Blob(["thumbnail"], { type: "image/webp" }));

    const item = await waitForListedRecordingWithThumbnail(store, "rec-thumbnail-background");
    expect(item?.thumbnailBlobId).toMatch(/^thumbnail-/);
  });

  it("continues saving video media when thumbnail generation fails", async () => {
    const store = createRecordingStore({
      databaseName: uniqueDbName(),
      thumbnailGenerator: vi.fn(async () => {
        throw new Error("decode failed");
      }),
    });
    const input = makeInput("rec-thumbnail-failure");
    input.mediaBlob = new Blob(["video"], { type: "video/webm" });

    await store.saveDraft(input);
    await store.commit("rec-thumbnail-failure");

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].thumbnailBlobId).toBeNull();
  });

  it("continues saving video media when thumbnail storage fails", async () => {
    const originalPut = IDBObjectStore.prototype.put;
    const putSpy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function put(
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === "thumbnails") {
        throw new DOMException("thumbnail quota exceeded", "QuotaExceededError");
      }
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    });
    const store = createRecordingStore({
      databaseName: uniqueDbName(),
      thumbnailGenerator: vi.fn(async () => new Blob(["thumbnail"], { type: "image/webp" })),
    });
    try {
      const input = makeInput("rec-thumbnail-storage-failure");
      input.mediaBlob = new Blob(["video"], { type: "video/webm" });

      const saved = await store.saveDraft(input);
      if (!saved.ok) throw new Error(saved.message);
      await store.commit("rec-thumbnail-storage-failure");

      const list = await store.list();
      expect(list).toHaveLength(1);
      expect(list[0].thumbnailBlobId).toBeNull();
      expect(putSpy).toHaveBeenCalled();
    } finally {
      putSpy.mockRestore();
    }
  });

  it("returns media-write-failed when media blob cannot be prepared", async () => {
    const store = createRecordingStore({ databaseName: uniqueDbName() });
    const input = makeInput("rec-media-fail");
    vi.spyOn(input.mediaBlob!, "arrayBuffer").mockRejectedValueOnce(new Error("blob read failed"));

    const result = await store.saveDraft(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("media-write-failed");
      expect(result.message).toContain("blob read failed");
    }
    expect(await store.list()).toEqual([]);
  });

  it("returns a useful media-write-failed message when blob preparation throws an empty message", async () => {
    const store = createRecordingStore({ databaseName: uniqueDbName() });
    const input = makeInput("rec-media-empty-error");
    vi.spyOn(input.mediaBlob!, "arrayBuffer").mockRejectedValueOnce({
      name: "NotReadableError",
      message: "",
    });

    const result = await store.saveDraft(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("media-write-failed");
      expect(result.message).toContain("NotReadableError");
      expect(result.message).toContain("media blob could not be prepared");
    }
  });

  it("load on a draft returns incomplete-package", async () => {
    const store = createRecordingStore({ databaseName: uniqueDbName() });
    await store.saveDraft(makeInput("rec-1"));
    const result = await store.load("rec-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("incomplete-package");
  });

  it("rename updates the meta.title", async () => {
    const store = createRecordingStore({ databaseName: uniqueDbName() });
    await store.saveDraft(makeInput("rec-1"));
    await store.commit("rec-1");
    await store.rename("rec-1", "renamed!");
    const list = await store.list();
    expect(list[0].title).toBe("renamed!");
  });

  it("remove deletes the recording and its media blob", async () => {
    const store = createRecordingStore({ databaseName: uniqueDbName() });
    await store.saveDraft(makeInput("rec-1"));
    await store.commit("rec-1");
    await store.remove("rec-1");
    const list = await store.list();
    expect(list.length).toBe(0);
  });

  it("remove deletes the generated thumbnail blob", async () => {
    const store = createRecordingStore({
      databaseName: uniqueDbName(),
      thumbnailGenerator: vi.fn(async () => new Blob(["thumbnail"], { type: "image/webp" })),
    });
    const input = makeInput("rec-remove-thumbnail");
    input.mediaBlob = new Blob(["video"], { type: "video/webm" });
    await store.saveDraft(input);
    await store.commit("rec-remove-thumbnail");
    const thumbnailBlobId = (await waitForListedRecordingWithThumbnail(store, "rec-remove-thumbnail"))!.thumbnailBlobId!;

    await store.remove("rec-remove-thumbnail");

    expect(await store.loadThumbnail(thumbnailBlobId)).toBeNull();
  });

  it("sweep removes drafts older than max age and frees their blobs", async () => {
    const store = createRecordingStore({ databaseName: uniqueDbName(), draftMaxAgeMs: 1 });
    await store.saveDraft(makeInput("rec-old"));
    await new Promise((r) => setTimeout(r, 5));
    const result = await store.sweep();
    expect(result.removedDrafts).toBeGreaterThanOrEqual(1);
  });

  it("retries opening after a blocked version upgrade is unblocked", async () => {
    const dbName = uniqueDbName();
    const oldDb = await openRecordingDatabaseV1(dbName);
    const store = createRecordingStore({ databaseName: dbName });

    await expect(store.list()).rejects.toThrow("indexeddb open blocked");
    oldDb.close();

    await expect(store.list()).resolves.toEqual([]);
  });

  it("exportZip then importZip survives the round-trip", async () => {
    const store = createRecordingStore({ databaseName: uniqueDbName() });
    await store.saveDraft(makeInput("rec-export"));
    await store.commit("rec-export");
    const zipBlob = await store.exportZip("rec-export");
    expect(zipBlob.size).toBeGreaterThan(0);

    const sink = createRecordingStore({ databaseName: uniqueDbName() });
    const imported = await sink.importZip(zipBlob);
    if (!imported.ok) throw new Error(imported.message);
    expect(imported.ok).toBe(true);
    const list = await sink.list();
    expect(list[0].id).toBe("rec-export");
  });

  it("importZip generates a thumbnail for imported video media", async () => {
    const source = createRecordingStore({ databaseName: uniqueDbName() });
    const input = makeInput("rec-import-thumbnail");
    input.mediaBlob = new Blob(["video"], { type: "video/webm" });
    await source.saveDraft(input);
    await source.commit("rec-import-thumbnail");
    const zipBlob = await source.exportZip("rec-import-thumbnail");
    const thumbnailGenerator = vi.fn(async () => new Blob(["thumbnail"], { type: "image/webp" }));
    const sink = createRecordingStore({
      databaseName: uniqueDbName(),
      thumbnailGenerator,
    });

    const imported = await sink.importZip(zipBlob);

    if (!imported.ok) throw new Error(imported.message);
    expect(thumbnailGenerator).toHaveBeenCalled();
    const item = await waitForListedRecordingWithThumbnail(sink, "rec-import-thumbnail");
    expect(item?.thumbnailBlobId).toMatch(/^thumbnail-/);
  });

  it("importZip accepts packages with unsupported media-warning events", async () => {
    const store = createRecordingStore({ databaseName: uniqueDbName() });
    const input = makeInput("rec-unsupported-warning");
    input.events = [makeUnsupportedMediaWarning(1)];
    input.snapshots = [makeSnapshot(1)];
    await store.saveDraft(input);
    await store.commit("rec-unsupported-warning");
    const zipBlob = await store.exportZip("rec-unsupported-warning");

    const sink = createRecordingStore({ databaseName: uniqueDbName() });
    const imported = await sink.importZip(zipBlob);
    if (!imported.ok) throw new Error(imported.message);
    const loaded = await sink.load("rec-unsupported-warning");

    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.package.events[0]).toMatchObject({
        type: "media-warning",
        payload: { code: "unsupported" },
      });
    }
  });

  it("importZip rejects packages whose original manifest checksum no longer matches", async () => {
    const store = createRecordingStore({ databaseName: uniqueDbName() });
    await store.saveDraft(makeInput("rec-corrupt"));
    await store.commit("rec-corrupt");
    const zipBlob = await store.exportZip("rec-corrupt");
    const archive = await JSZip.loadAsync(zipBlob);
    archive.file("events.json", JSON.stringify([makeEvent(99)]));
    const corrupted = await archive.generateAsync({ type: "blob" });

    const sink = createRecordingStore({ databaseName: uniqueDbName() });
    const imported = await sink.importZip(corrupted);

    expect(imported.ok).toBe(false);
    if (!imported.ok) {
      expect(imported.reason).toBe("validation-failed");
      expect(imported.message).toMatch(/checksum-mismatch/);
    }
  });
});

async function waitForRawRecording(dbName: string, id: string): Promise<{ manifest: { status: string }; thumbnailBlobId: string | null } | undefined> {
  const deadline = Date.now() + 250;
  let lastValue: { manifest: { status: string }; thumbnailBlobId: string | null } | undefined;
  while (Date.now() < deadline) {
    lastValue = await readRawRecording(dbName, id);
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return lastValue;
}

async function waitForListedRecordingWithThumbnail(
  store: RecordingRepository,
  id: string,
): Promise<RecordingListItem | undefined> {
  const deadline = Date.now() + 250;
  let lastValue: RecordingListItem | undefined;
  while (Date.now() < deadline) {
    lastValue = (await store.list()).find((item) => item.id === id);
    if (lastValue?.thumbnailBlobId) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return lastValue;
}

async function readRawRecording(dbName: string, id: string): Promise<{ manifest: { status: string }; thumbnailBlobId: string | null } | undefined> {
  const db = await openExistingDatabase(dbName, 2);
  try {
    const tx = db.transaction("recordings", "readonly");
    const value = await requestToPromise(tx.objectStore("recordings").get(id));
    await transactionDone(tx);
    return value as { manifest: { status: string }; thumbnailBlobId: string | null } | undefined;
  } finally {
    db.close();
  }
}

function openExistingDatabase(name: string, version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("blocked"));
  });
}

function openRecordingDatabaseV1(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const recordings = request.result.createObjectStore("recordings", { keyPath: "id" });
      recordings.createIndex("status", "manifest.status", { unique: false });
      recordings.createIndex("createdAtMs", "createdAtMs", { unique: false });
      request.result.createObjectStore("blobs");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}
