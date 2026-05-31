import { awaitTransaction, openDatabase, promisifyRequest } from "@/features/library/idb";
import type { SubtitleChapter, SubtitleStore, SubtitleTrack } from "./types";

export type SubtitleStoreOptions = {
  databaseName?: string;
};

const DEFAULT_DB_NAME = "code-tape-subtitles";
const DB_VERSION = 2;
const STORE_SUBTITLES = "subtitles";
const STORE_CHAPTERS = "chapters";

export function createSubtitleStore(options: SubtitleStoreOptions = {}): SubtitleStore {
  const databaseName = options.databaseName ?? DEFAULT_DB_NAME;
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
            if (!db.objectStoreNames.contains(STORE_SUBTITLES)) {
              db.createObjectStore(STORE_SUBTITLES, { keyPath: "recordingId" });
            }
            if (!db.objectStoreNames.contains(STORE_CHAPTERS)) {
              db.createObjectStore(STORE_CHAPTERS, { keyPath: "recordingId" });
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

  return {
    async load(recordingId: string): Promise<SubtitleTrack | null> {
      const db = await getDb();
      const tx = db.transaction(STORE_SUBTITLES, "readonly");
      const value = (await promisifyRequest(tx.objectStore(STORE_SUBTITLES).get(recordingId))) as
        | SubtitleTrack
        | undefined;
      await awaitTransaction(tx);
      return value ?? null;
    },

    async save(track: SubtitleTrack): Promise<void> {
      const db = await getDb();
      const tx = db.transaction(STORE_SUBTITLES, "readwrite");
      tx.objectStore(STORE_SUBTITLES).put(track);
      await awaitTransaction(tx);
    },

    async loadChapters(recordingId: string): Promise<SubtitleChapter[]> {
      const db = await getDb();
      const tx = db.transaction(STORE_CHAPTERS, "readonly");
      const value = (await promisifyRequest(tx.objectStore(STORE_CHAPTERS).get(recordingId))) as
        | { recordingId: string; chapters?: SubtitleChapter[] }
        | undefined;
      await awaitTransaction(tx);
      return Array.isArray(value?.chapters) ? value.chapters : [];
    },

    async saveChapters(recordingId: string, chapters: SubtitleChapter[]): Promise<void> {
      const db = await getDb();
      const tx = db.transaction(STORE_CHAPTERS, "readwrite");
      tx.objectStore(STORE_CHAPTERS).put({ recordingId, chapters });
      await awaitTransaction(tx);
    },

    async saveWithChapters(track: SubtitleTrack, chapters: SubtitleChapter[]): Promise<void> {
      const db = await getDb();
      const tx = db.transaction([STORE_SUBTITLES, STORE_CHAPTERS], "readwrite");
      try {
        tx.objectStore(STORE_SUBTITLES).put(track);
        tx.objectStore(STORE_CHAPTERS).put({ recordingId: track.recordingId, chapters });
      } catch (error) {
        tx.abort();
        throw error;
      }
      await awaitTransaction(tx);
    },

    async remove(recordingId: string): Promise<void> {
      const db = await getDb();
      const tx = db.transaction([STORE_SUBTITLES, STORE_CHAPTERS], "readwrite");
      tx.objectStore(STORE_SUBTITLES).delete(recordingId);
      tx.objectStore(STORE_CHAPTERS).delete(recordingId);
      await awaitTransaction(tx);
    },
  };
}
