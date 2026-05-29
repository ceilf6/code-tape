import { afterEach, describe, expect, it, vi } from "vitest";
import { installStaleChunkRecovery } from "../staleChunkRecovery";

function createPreloadError(message: string): Event {
  const event = new Event("vite:preloadError", { cancelable: true });
  Object.defineProperty(event, "payload", {
    value: new Error(message),
  });
  return event;
}

describe("installStaleChunkRecovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reloads once when Vite reports a stale dynamic chunk", () => {
    const reload = vi.fn();
    const storage = new Map<string, string>();
    const target = new EventTarget();
    const getRecoveryToken = () => "entry-index-A.js";
    installStaleChunkRecovery({
      target,
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      reload,
      getRecoveryToken,
    });

    const firstError = createPreloadError(
      "Failed to fetch dynamically imported module: https://ceilf6.github.io/code-tape/assets/transformers.web-Ddnr203B.js",
    );
    const secondError = createPreloadError(
      "Failed to fetch dynamically imported module: https://ceilf6.github.io/code-tape/assets/transformers.web-Ddnr203B.js",
    );

    target.dispatchEvent(firstError);
    target.dispatchEvent(secondError);

    expect(firstError.defaultPrevented).toBe(true);
    expect(secondError.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload for unrelated preload errors", () => {
    const reload = vi.fn();
    const target = new EventTarget();
    installStaleChunkRecovery({
      target,
      storage: {
        getItem: () => null,
        setItem: vi.fn(),
      },
      reload,
      getRecoveryToken: () => "entry-index-A.js",
    });

    const event = createPreloadError("Cannot read properties of undefined");

    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("still reloads once when session storage writes fail", () => {
    const reload = vi.fn();
    const target = new EventTarget();
    installStaleChunkRecovery({
      target,
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("storage blocked");
        },
      },
      reload,
      getRecoveryToken: () => "entry-index-storage-blocked.js",
    });

    target.dispatchEvent(createPreloadError("Importing a module script failed."));
    target.dispatchEvent(createPreloadError("Importing a module script failed."));

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("clears code-tape asset caches before reloading", async () => {
    const reload = vi.fn();
    const deletedCaches: string[] = [];
    const target = new EventTarget();
    installStaleChunkRecovery({
      target,
      storage: {
        getItem: () => null,
        setItem: vi.fn(),
      },
      reload,
      getRecoveryToken: () => "entry-index-C.js",
      cacheStorage: {
        keys: async () => ["code-tape-assets-v1", "transformers-cache", "unrelated-cache"],
        delete: async (name) => {
          deletedCaches.push(name);
          return true;
        },
      },
    });

    target.dispatchEvent(createPreloadError("Failed to fetch dynamically imported module"));

    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(deletedCaches).toEqual(["code-tape-assets-v1"]);
  });
});
