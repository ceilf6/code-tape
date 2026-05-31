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

  it("closes a blocked request connection if it later opens after rejecting", async () => {
    const name = uniqueDbName();
    const oldDb = await openRawDatabase(name, 1);
    const originalClose = IDBDatabase.prototype.close;
    const closeSpy = vi.spyOn(IDBDatabase.prototype, "close").mockImplementation(function close(this: IDBDatabase) {
      originalClose.call(this);
    });
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

      oldDb.close();

      await waitForCloseCalls(closeSpy, 2);
      expect(closeSpy).toHaveBeenCalledTimes(2);
    } finally {
      closeSpy.mockRestore();
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

async function waitForCloseCalls(closeSpy: { mock: { calls: unknown[] } }, expectedCalls: number) {
  const deadline = Date.now() + 250;
  while (Date.now() < deadline) {
    if (closeSpy.mock.calls.length >= expectedCalls) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
