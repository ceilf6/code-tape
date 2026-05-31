import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../idb";

let dbCounter = 0;
function uniqueDbName() {
  dbCounter += 1;
  return `code-tape-idb-test-${dbCounter}`;
}

describe("openDatabase", () => {
  it("closes an existing connection when a future schema upgrade needs it", async () => {
    const db = await openDatabase({
      name: uniqueDbName(),
      version: 1,
      onUpgrade(upgradeDb) {
        upgradeDb.createObjectStore("items");
      },
    });
    const originalClose = db.close.bind(db);
    const closeSpy = vi.spyOn(db, "close").mockImplementation(() => {
      originalClose();
    });

    db.onversionchange?.(new Event("versionchange") as IDBVersionChangeEvent);

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("notifies callers when a versionchange closes the connection", async () => {
    const onVersionChange = vi.fn();
    const db = await openDatabase({
      name: uniqueDbName(),
      version: 1,
      onUpgrade(upgradeDb) {
        upgradeDb.createObjectStore("items");
      },
      onVersionChange,
    });

    db.onversionchange?.(new Event("versionchange") as IDBVersionChangeEvent);

    expect(onVersionChange).toHaveBeenCalledTimes(1);
  });

  it("rejects when an upgrade is blocked by an older open connection", async () => {
    const name = uniqueDbName();
    const oldDb = await openRawDatabase(name, 1);

    try {
      await expect(openDatabase({
        name,
        version: 2,
        onUpgrade(upgradeDb) {
          if (!upgradeDb.objectStoreNames.contains("items")) {
            upgradeDb.createObjectStore("items");
          }
          upgradeDb.createObjectStore("thumbnails");
        },
      })).rejects.toThrow("indexeddb open blocked");
    } finally {
      oldDb.close();
    }
  });
});

function openRawDatabase(name: string, version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("items");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
