export type ExternalAsrProvider = "openai-compatible";

export type ExternalAsrConfig = {
  provider: ExternalAsrProvider;
  baseURL: string;
  apiKey: string;
  model: string;
  language: string;
};

export const SUBTITLE_ASR_CONFIG_STORAGE_KEY = "code-tape:subtitle-asr";

const VALID_PROVIDERS: ReadonlySet<string> = new Set<ExternalAsrProvider>(["openai-compatible"]);

export function loadExternalAsrConfig(
  storage: Pick<Storage, "getItem"> | undefined = safeStorage(),
): ExternalAsrConfig | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(SUBTITLE_ASR_CONFIG_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveExternalAsrConfig(
  config: ExternalAsrConfig,
  storage: Pick<Storage, "setItem"> | undefined = safeStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(SUBTITLE_ASR_CONFIG_STORAGE_KEY, JSON.stringify(normalizeConfigStrict(config)));
  } catch {
    // localStorage can be unavailable; the app simply keeps using local ASR.
  }
}

export function clearExternalAsrConfig(
  storage: Pick<Storage, "removeItem"> | undefined = safeStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(SUBTITLE_ASR_CONFIG_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function isExternalAsrConfigured(
  config: ExternalAsrConfig | null,
): config is ExternalAsrConfig {
  if (!config) return false;
  return (
    VALID_PROVIDERS.has(config.provider) &&
    config.baseURL.trim().length > 0 &&
    config.apiKey.trim().length > 0 &&
    config.model.trim().length > 0
  );
}

function normalizeConfig(value: unknown): ExternalAsrConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const provider = record.provider;
  if (typeof provider !== "string" || !VALID_PROVIDERS.has(provider)) return null;
  return {
    provider: provider as ExternalAsrProvider,
    baseURL: typeof record.baseURL === "string" ? record.baseURL.trim() : "",
    apiKey: typeof record.apiKey === "string" ? record.apiKey.trim() : "",
    model: typeof record.model === "string" ? record.model.trim() : "",
    language: typeof record.language === "string" ? record.language.trim() : "",
  };
}

function normalizeConfigStrict(config: ExternalAsrConfig): ExternalAsrConfig {
  return {
    provider: config.provider,
    baseURL: config.baseURL.trim(),
    apiKey: config.apiKey.trim(),
    model: config.model.trim(),
    language: config.language.trim(),
  };
}

function safeStorage(): Storage | undefined {
  try {
    return typeof globalThis !== "undefined" ? globalThis.localStorage : undefined;
  } catch {
    return undefined;
  }
}
