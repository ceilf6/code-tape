/**
 * Thin Promise wrappers around IndexedDB. We intentionally avoid `idb`/`dexie`
 * to keep the dependency surface minimal (ADR-003: P0 storage uses IndexedDB
 * directly).
 */

export function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function awaitTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("transaction errored"));
  });
}

export type OpenDatabaseOptions = {
  name: string;
  version: number;
  onUpgrade(db: IDBDatabase, oldVersion: number, newVersion: number, transaction: IDBTransaction): void;
  onVersionChange?: () => void;
};

export function openDatabase(options: OpenDatabaseOptions): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let rejectedAfterBlocked = false;
    const request = indexedDB.open(options.name, options.version);
    request.onupgradeneeded = (event) => {
      const target = event.target as IDBOpenDBRequest;
      options.onUpgrade(target.result, event.oldVersion, event.newVersion ?? options.version, target.transaction!);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (rejectedAfterBlocked) {
        db.close();
        return;
      }
      db.onversionchange = () => {
        db.close();
        options.onVersionChange?.();
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      rejectedAfterBlocked = true;
      reject(new Error("indexeddb open blocked by another open tab; close other Code Tape tabs and retry"));
    };
  });
}
