import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureModelSource,
  configureQuietBrowserCache,
  loadTransformersModule,
  loadTransformersPipeline,
  requestStaleTransformersImportRecovery,
  type TransformersEnvironment,
  type TransformersModule,
} from "../transformersLoader";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("transformersLoader", () => {
  it("retries transient dynamic import failures before loading Transformers.js", async () => {
    const module = makeTransformersModule();
    const importer = vi
      .fn<() => Promise<TransformersModule>>()
      .mockRejectedValueOnce(
        new TypeError(
          "Failed to fetch dynamically imported module: https://ceilf6.github.io/code-tape/assets/transformers.web-Ddnr203B.js",
        ),
      )
      .mockResolvedValueOnce(module);
    const onRetry = vi.fn();

    await expect(loadTransformersModule({ importer, retryDelayMs: 0, onRetry })).resolves.toBe(
      module,
    );

    expect(importer).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("does not retry non-network module errors", async () => {
    const importer = vi
      .fn<() => Promise<TransformersModule>>()
      .mockRejectedValue(new SyntaxError("Unexpected token"));
    const dispatchEvent = vi.spyOn(globalThis, "dispatchEvent");

    await expect(loadTransformersModule({ importer, retryDelayMs: 0 })).rejects.toThrow(
      "Unexpected token",
    );

    expect(importer).toHaveBeenCalledTimes(1);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it("stops retrying after the configured import attempts", async () => {
    const error = new TypeError("Failed to fetch dynamically imported module");
    const importer = vi.fn<() => Promise<TransformersModule>>().mockRejectedValue(error);
    const onRetry = vi.fn();

    await expect(
      loadTransformersModule({ importer, attempts: 2, retryDelayMs: 0, onRetry }),
    ).rejects.toBe(error);

    expect(importer).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("dispatches a Vite preload error when stale Transformers chunk loading is exhausted", async () => {
    const error = new TypeError(
      "Failed to fetch dynamically imported module: https://ceilf6.github.io/code-tape/assets/transformers.web-Ddnr203B.js",
    );
    const importer = vi.fn<() => Promise<TransformersModule>>().mockRejectedValue(error);
    const dispatchEvent = vi.spyOn(globalThis, "dispatchEvent");

    await expect(
      loadTransformersModule({ importer, attempts: 2, retryDelayMs: 0 }),
    ).rejects.toBe(error);

    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const event = dispatchEvent.mock.calls[0]?.[0];
    expect(event?.type).toBe("vite:preloadError");
    expect(event?.cancelable).toBe(true);
    expect((event as Event & { payload?: unknown }).payload).toBe(error);
  });

  it("does not request stale chunk recovery for a plain fetch failure", () => {
    const dispatchEvent = vi.spyOn(globalThis, "dispatchEvent");

    const requested = requestStaleTransformersImportRecovery(new TypeError("Failed to fetch"));

    expect(requested).toBe(false);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it("reports whether a stale chunk recovery request was handled", () => {
    const error = new TypeError("Failed to fetch dynamically imported module");
    expect(requestStaleTransformersImportRecovery(error)).toBe(false);

    const handlePreloadError = (event: Event) => event.preventDefault();
    globalThis.addEventListener("vite:preloadError", handlePreloadError);
    try {
      expect(requestStaleTransformersImportRecovery(error)).toBe(true);
    } finally {
      globalThis.removeEventListener("vite:preloadError", handlePreloadError);
    }
  });

  it("loads a pipeline after a recovered import and applies the quiet browser cache", async () => {
    const loadedPipeline = vi.fn();
    const pipelineFactory = vi.fn(async () => loadedPipeline);
    const module = makeTransformersModule({ pipeline: pipelineFactory });
    const cache = {
      match: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
    };
    const open = vi.fn(async () => cache);
    vi.stubGlobal("caches", { open });

    await expect(
      loadTransformersPipeline<typeof loadedPipeline>(
        "automatic-speech-recognition",
        "onnx-community/whisper-tiny",
        {
          device: "wasm",
          dtype: "fp32",
        },
        { importer: async () => module },
      ),
    ).resolves.toBe(loadedPipeline);

    expect(pipelineFactory).toHaveBeenCalledWith(
      "automatic-speech-recognition",
      "onnx-community/whisper-tiny",
      {
        device: "wasm",
        dtype: "fp32",
      },
    );
    expect(module.env?.useCustomCache).toBe(true);
  });

  it("keeps inference available when CacheStorage writes reject", async () => {
    const env: TransformersEnvironment = {
      useBrowserCache: true,
      useCustomCache: false,
      customCache: null,
      cacheKey: "transformers-cache",
    };
    const cache = {
      match: vi.fn(async () => undefined),
      put: vi.fn(async () => {
        throw new DOMException("Unexpected internal error.", "UnknownError");
      }),
    };
    const open = vi.fn(async () => cache);
    vi.stubGlobal("caches", { open });

    configureQuietBrowserCache(env);

    await expect(
      env.customCache?.put("model-cache-key", new Response("weights")),
    ).resolves.toBeUndefined();
    expect(open).toHaveBeenCalledWith("transformers-cache");
  });
});

describe("configureModelSource", () => {
  it("serves vendored same-origin assets and disables remote by default", () => {
    const env: TransformersEnvironment = {};

    configureModelSource(env, { baseUrl: "/code-tape/" });

    expect(env.allowLocalModels).toBe(true);
    expect(env.allowRemoteModels).toBe(false);
    expect(env.localModelPath).toBe("/code-tape/models/");
    expect(env.remoteHost).toBeUndefined();
  });

  it("defaults the base path to root when baseUrl is empty", () => {
    const env: TransformersEnvironment = {};

    configureModelSource(env, { baseUrl: "" });

    expect(env.localModelPath).toBe("/models/");
  });

  it("switches to a remote mirror when VITE_HF_REMOTE_HOST is configured", () => {
    const env: TransformersEnvironment = {
      backends: { onnx: { wasm: { wasmPaths: { mjs: "https://cdn/x.mjs", wasm: "https://cdn/x.wasm" } } } },
    };

    configureModelSource(env, { baseUrl: "/", remoteHost: "https://hf-mirror.com" });

    expect(env.allowRemoteModels).toBe(true);
    expect(env.allowLocalModels).toBe(false);
    expect(env.remoteHost).toBe("https://hf-mirror.com/");
    expect(env.localModelPath).toBeUndefined();
    // ORT runtime stays self-hosted even in mirror mode.
    expect(env.backends?.onnx?.wasm?.wasmPaths).toEqual({
      mjs: "/ort/x.mjs",
      wasm: "/ort/x.wasm",
    });
  });

  it("rebases existing per-browser wasm paths onto the self-hosted ort directory", () => {
    const env: TransformersEnvironment = {
      backends: {
        onnx: {
          wasm: {
            wasmPaths: {
              mjs: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.0/dist/ort-wasm-simd-threaded.asyncify.mjs",
              wasm: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.0/dist/ort-wasm-simd-threaded.asyncify.wasm",
            },
          },
        },
      },
    };

    configureModelSource(env, { baseUrl: "/code-tape/" });

    expect(env.backends?.onnx?.wasm?.wasmPaths).toEqual({
      mjs: "/code-tape/ort/ort-wasm-simd-threaded.asyncify.mjs",
      wasm: "/code-tape/ort/ort-wasm-simd-threaded.asyncify.wasm",
    });
  });

  it("uses an ort directory prefix when wasm paths are not yet initialized", () => {
    const env: TransformersEnvironment = {
      backends: { onnx: { wasm: {} } },
    };

    configureModelSource(env, { baseUrl: "/" });

    expect(env.backends?.onnx?.wasm?.wasmPaths).toBe("/ort/");
  });

  it("ignores a missing environment", () => {
    expect(() => configureModelSource(undefined, { baseUrl: "/" })).not.toThrow();
  });

  it("leaves transformers defaults untouched when there is no http origin (Node SSR)", () => {
    const env: TransformersEnvironment = {};
    const originalLocation = globalThis.location;
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { protocol: "file:" },
    });
    try {
      configureModelSource(env, { baseUrl: "/" });
    } finally {
      Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: originalLocation,
      });
    }

    expect(env.allowLocalModels).toBeUndefined();
    expect(env.allowRemoteModels).toBeUndefined();
    expect(env.localModelPath).toBeUndefined();
  });
});

function makeTransformersModule(overrides: Partial<TransformersModule> = {}): TransformersModule {
  const pipeline = overrides.pipeline ?? vi.fn(async () => vi.fn());
  return {
    env: {
      useBrowserCache: true,
      useCustomCache: false,
      customCache: null,
      cacheKey: "transformers-cache",
    },
    pipeline,
    ...overrides,
  };
}
