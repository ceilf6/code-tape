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
});
