export type TransformersEnvironment = {
  useBrowserCache?: boolean;
  useCustomCache?: boolean;
  customCache?: QuietBrowserCache | null;
  cacheKey?: string;
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

export async function loadTransformersModule(
  options: TransformersModuleLoaderOptions = {},
): Promise<TransformersModule> {
  const importer = options.importer ?? defaultTransformersImporter;
  const attempts = Math.max(1, Math.floor(options.attempts ?? DEFAULT_IMPORT_ATTEMPTS));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await importer();
    } catch (error) {
      if (attempt >= attempts || !isRecoverableTransformersImportError(error)) {
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

function isRecoverableTransformersImportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Load failed|NetworkError|Failed to fetch/iu.test(
    message,
  );
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
