type StaleChunkRecoveryTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

type StaleChunkRecoveryStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

type StaleChunkRecoveryCacheStorage = {
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
};

type VitePreloadErrorEvent = Event & {
  payload?: unknown;
};

export type StaleChunkRecoveryOptions = {
  target?: StaleChunkRecoveryTarget;
  storage?: StaleChunkRecoveryStorage;
  reload?: () => void;
  getRecoveryToken?: () => string;
  cacheStorage?: StaleChunkRecoveryCacheStorage;
};

const STALE_CHUNK_RECOVERY_KEY = "code-tape:stale-chunk-recovery";
const RECOVERABLE_DYNAMIC_IMPORT_ERROR =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Load failed|NetworkError|Failed to fetch/iu;

let inMemoryRecoveryToken: string | null = null;

export function installStaleChunkRecovery(options: StaleChunkRecoveryOptions = {}): () => void {
  const target = options.target ?? globalThis;
  const reload = options.reload ?? (() => globalThis.location.reload());
  const getRecoveryToken = options.getRecoveryToken ?? readDefaultRecoveryToken;
  const storage = options.storage ?? readSessionStorage();

  const handlePreloadError = (event: Event) => {
    if (!isRecoverablePreloadError(event)) return;
    event.preventDefault();

    const recoveryToken = getRecoveryToken();
    if (readRecoveryToken(storage) === recoveryToken) return;

    writeRecoveryToken(storage, recoveryToken);
    const cacheStorage = options.cacheStorage ?? readCacheStorage();
    if (!cacheStorage) {
      reload();
      return;
    }
    void clearStaleChunkCaches(cacheStorage).finally(reload);
  };

  target.addEventListener("vite:preloadError", handlePreloadError);
  return () => target.removeEventListener("vite:preloadError", handlePreloadError);
}

function isRecoverablePreloadError(event: Event): boolean {
  const error = (event as VitePreloadErrorEvent).payload;
  const message = error instanceof Error ? error.message : String(error);
  return RECOVERABLE_DYNAMIC_IMPORT_ERROR.test(message);
}

function readDefaultRecoveryToken(): string {
  if (typeof document !== "undefined") {
    const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
    if (script?.src) return script.src;
  }
  return typeof location !== "undefined" ? location.href : "unknown-entry";
}

function readSessionStorage(): StaleChunkRecoveryStorage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

function readCacheStorage(): StaleChunkRecoveryCacheStorage | undefined {
  try {
    return globalThis.caches;
  } catch {
    return undefined;
  }
}

async function clearStaleChunkCaches(cacheStorage: StaleChunkRecoveryCacheStorage): Promise<void> {
  let cacheNames: string[];
  try {
    cacheNames = await cacheStorage.keys();
  } catch {
    return;
  }
  await Promise.all(
    cacheNames
      .filter(isCodeTapeAssetCache)
      .map(async (cacheName) => {
        try {
          await cacheStorage.delete(cacheName);
        } catch {
          // Cache cleanup is best-effort; reloading is still the recovery path.
        }
      }),
  );
}

function isCodeTapeAssetCache(cacheName: string): boolean {
  return /code-tape|vite|workbox|assets|precache/iu.test(cacheName);
}

function readRecoveryToken(storage: StaleChunkRecoveryStorage | undefined): string | null {
  if (!storage) return inMemoryRecoveryToken;
  try {
    return storage.getItem(STALE_CHUNK_RECOVERY_KEY) ?? inMemoryRecoveryToken;
  } catch {
    return inMemoryRecoveryToken;
  }
}

function writeRecoveryToken(
  storage: StaleChunkRecoveryStorage | undefined,
  recoveryToken: string,
): void {
  inMemoryRecoveryToken = recoveryToken;
  if (!storage) return;
  try {
    storage.setItem(STALE_CHUNK_RECOVERY_KEY, recoveryToken);
  } catch {
    // Session storage can be blocked; the in-memory token still prevents loops in this runtime.
  }
}
