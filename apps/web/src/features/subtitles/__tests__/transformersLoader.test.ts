import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureQuietBrowserCache,
  loadTransformersModule,
  loadTransformersPipeline,
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

    await expect(loadTransformersModule({ importer, retryDelayMs: 0 })).rejects.toThrow(
      "Unexpected token",
    );

    expect(importer).toHaveBeenCalledTimes(1);
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
