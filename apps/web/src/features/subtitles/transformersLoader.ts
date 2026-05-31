export type TransformersWasmPaths = string | { mjs?: string; wasm?: string };

export type TransformersEnvironment = {
  useBrowserCache?: boolean;
  useCustomCache?: boolean;
  customCache?: QuietBrowserCache | null;
  cacheKey?: string;
  allowLocalModels?: boolean;
  allowRemoteModels?: boolean;
  remoteHost?: string;
  localModelPath?: string;
  backends?: {
    onnx?: {
      wasm?: {
        wasmPaths?: TransformersWasmPaths;
      };
    };
  };
};

export type ModelSourceConfig = {
  baseUrl?: string;
  remoteHost?: string;
};

type ModelSourceEnv = {
  BASE_URL?: unknown;
  VITE_HF_REMOTE_HOST?: unknown;
};

type QuietBrowserCache = {
  __codeTapeQuietCache: true;
  match(cacheKey: string): Promise<Response | undefined>;
  put(cacheKey: string, response: Response): Promise<void>;
};

export type TransformersModule = {
  env?: TransformersEnvironment;
  pipeline(task: string, model: string, options: unknown): Promise<unknown>;
};

export type TransformersModuleLoaderOptions = {
  importer?: () => Promise<TransformersModule>;
  attempts?: number;
  retryDelayMs?: number;
  onRetry?: (error: unknown, attempt: number) => void;
};

const DEFAULT_IMPORT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;
const VITE_PRELOAD_ERROR_EVENT = "vite:preloadError";

export async function loadTransformersModule(
  options: TransformersModuleLoaderOptions = {},
): Promise<TransformersModule> {
  const importer = options.importer ?? defaultTransformersImporter;
  const attempts = Math.max(1, Math.floor(options.attempts ?? DEFAULT_IMPORT_ATTEMPTS));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await importer();
    } catch (error) {
      const recoverable = isRecoverableTransformersImportError(error);
      if (attempt >= attempts || !recoverable) {
        if (recoverable) requestStaleTransformersImportRecovery(error);
        throw error;
      }
      options.onRetry?.(error, attempt);
      await waitBeforeRetry((options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS) * attempt);
    }
  }
}

export async function loadTransformersPipeline<TPipeline>(
  task: string,
  model: string,
  options: unknown,
  loaderOptions: TransformersModuleLoaderOptions = {},
): Promise<TPipeline> {
  const module = await loadTransformersModule(loaderOptions);
  configureQuietBrowserCache(module.env);
  configureModelSource(module.env);
  const pipe = await module.pipeline(task, model, options);
  return pipe as TPipeline;
}

export function configureQuietBrowserCache(env: TransformersEnvironment | undefined): void {
  if (!env?.useBrowserCache || typeof globalThis.caches === "undefined") return;
  if (env.useCustomCache && env.customCache) return;

  const cacheKey = env.cacheKey ?? "transformers-cache";
  env.useCustomCache = true;
  env.customCache = {
    __codeTapeQuietCache: true,
    async match(resourceKey) {
      try {
        const cache = await globalThis.caches.open(cacheKey);
        return (await cache.match(resourceKey)) ?? undefined;
      } catch {
        return undefined;
      }
    },
    async put(resourceKey, response) {
      try {
        const cache = await globalThis.caches.open(cacheKey);
        await cache.put(resourceKey, response.clone());
      } catch {
        // Cache API writes can fail for large model files or browser storage issues.
        // Model loading has already succeeded, so keep inference available and avoid noisy warnings.
      }
    },
  };
}

export function configureModelSource(
  env: TransformersEnvironment | undefined,
  config: ModelSourceConfig = readModelSourceConfig(),
): void {
  if (!env) return;
  // ORT WASM runtime is always self-hosted from public/ort, independent of
  // whether model weights come from the same-origin copy or a remote mirror —
  // otherwise mirror mode would still fetch the runtime from jsdelivr.
  if (hasSameOriginAssetHost()) {
    configureSelfHostedWasmPaths(env, config.baseUrl);
  }
  const remoteHost = config.remoteHost?.trim();
  if (remoteHost) {
    // Mirror fallback: fetch model weights from a configured Hugging Face mirror
    // instead of the bundled same-origin copy. Used when assets are not vendored.
    env.allowRemoteModels = true;
    env.allowLocalModels = false;
    env.remoteHost = remoteHost.endsWith("/") ? remoteHost : `${remoteHost}/`;
    return;
  }
  if (!hasSameOriginAssetHost()) {
    // No HTTP origin to serve vendored assets from (e.g. Node SSR in the manual
    // real-model smoke tool). Leave transformers.js defaults so it can still
    // reach the Hub on networks that allow it; same-origin hosting is browser-only.
    return;
  }
  // Default: serve vendored weights from the same origin as the app
  // (apps/web/public/models). Disable remote so missing files fail loudly
  // instead of silently timing out against huggingface.co.
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = joinBaseUrl(config.baseUrl, "models/");
}

function hasSameOriginAssetHost(): boolean {
  // True in a browser window and a Web Worker (both expose an http(s) origin);
  // false under Node SSR, where there is no origin to fetch public/ assets from.
  const origin = (globalThis as { location?: { protocol?: string } }).location?.protocol;
  return origin === "http:" || origin === "https:";
}

function configureSelfHostedWasmPaths(
  env: TransformersEnvironment,
  baseUrl: string | undefined,
): void {
  const wasm = env.backends?.onnx?.wasm;
  if (!wasm) return;
  const ortBase = joinBaseUrl(baseUrl, "ort/");
  // Preserve the per-browser file names transformers.js already selected
  // (Safari uses the non-asyncify build); only redirect the host to our copy.
  const current = wasm.wasmPaths;
  if (typeof current === "object" && current) {
    wasm.wasmPaths = {
      ...(current.mjs ? { mjs: rebaseOrtFile(current.mjs, ortBase) } : {}),
      ...(current.wasm ? { wasm: rebaseOrtFile(current.wasm, ortBase) } : {}),
    };
    return;
  }
  // No object form yet (paths not initialized): use a prefix so onnxruntime-web
  // appends its own file names under our directory.
  wasm.wasmPaths = ortBase;
}

function rebaseOrtFile(originalPath: string, ortBase: string): string {
  const fileName = originalPath.split("/").pop() ?? originalPath;
  return `${ortBase}${fileName}`;
}

function joinBaseUrl(baseUrl: string | undefined, suffix: string): string {
  const base = baseUrl && baseUrl.length > 0 ? baseUrl : "/";
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  return `${normalizedBase}${suffix}`;
}

function readModelSourceConfig(): ModelSourceConfig {
  const env: ModelSourceEnv =
    typeof import.meta !== "undefined" && import.meta.env
      ? (import.meta.env as ModelSourceEnv)
      : {};
  const baseUrl = typeof env.BASE_URL === "string" ? env.BASE_URL : "/";
  const remoteHost =
    typeof env.VITE_HF_REMOTE_HOST === "string" ? env.VITE_HF_REMOTE_HOST : undefined;
  return { baseUrl, remoteHost };
}

export function requestStaleTransformersImportRecovery(error: unknown): boolean {
  if (!isStaleTransformersChunkImportError(error)) return false;
  return dispatchStaleChunkRecoveryEvent(error);
}

export function isRecoverableTransformersImportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Load failed|NetworkError|Failed to fetch/iu.test(
    message,
  );
}

export function isStaleTransformersChunkImportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading chunk [\w-]+ failed/iu.test(
    message,
  );
}

function dispatchStaleChunkRecoveryEvent(error: unknown): boolean {
  if (typeof Event === "undefined" || typeof globalThis.dispatchEvent !== "function") {
    return false;
  }
  const event = new Event(VITE_PRELOAD_ERROR_EVENT, { cancelable: true });
  Object.defineProperty(event, "payload", { value: error });
  globalThis.dispatchEvent(event);
  return event.defaultPrevented;
}

async function defaultTransformersImporter(): Promise<TransformersModule> {
  const module = await import("@huggingface/transformers");
  return module as unknown as TransformersModule;
}

function waitBeforeRetry(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, delayMs);
  });
}
