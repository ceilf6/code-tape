export type ExternalLlmProvider = "openai" | "anthropic";

export type ExternalLlmConfig = {
  provider: ExternalLlmProvider;
  baseURL: string;
  apiKey: string;
  model: string;
};

export const SUBTITLE_LLM_CONFIG_STORAGE_KEY = "code-tape:subtitle-llm";

const VALID_PROVIDERS: ReadonlySet<string> = new Set<ExternalLlmProvider>(["openai", "anthropic"]);

// Persisted in localStorage only. The API key never leaves the user's browser
// except in the direct request to their configured endpoint; it is not bundled,
// logged, or sent to any code-tape backend.
export function loadExternalLlmConfig(
  storage: Pick<Storage, "getItem"> | undefined = safeStorage(),
): ExternalLlmConfig | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(SUBTITLE_LLM_CONFIG_STORAGE_KEY);
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

export function saveExternalLlmConfig(
  config: ExternalLlmConfig,
  storage: Pick<Storage, "setItem"> | undefined = safeStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(SUBTITLE_LLM_CONFIG_STORAGE_KEY, JSON.stringify(normalizeConfigStrict(config)));
  } catch {
    // localStorage can be unavailable (private mode / disabled). Config simply
    // does not persist; the app falls back to the local model.
  }
}

export function clearExternalLlmConfig(
  storage: Pick<Storage, "removeItem"> | undefined = safeStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(SUBTITLE_LLM_CONFIG_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function isExternalLlmConfigured(config: ExternalLlmConfig | null): config is ExternalLlmConfig {
  if (!config) return false;
  return (
    VALID_PROVIDERS.has(config.provider) &&
    config.baseURL.trim().length > 0 &&
    config.apiKey.trim().length > 0 &&
    config.model.trim().length > 0
  );
}

function normalizeConfig(value: unknown): ExternalLlmConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const provider = record.provider;
  if (typeof provider !== "string" || !VALID_PROVIDERS.has(provider)) return null;
  return {
    provider: provider as ExternalLlmProvider,
    baseURL: typeof record.baseURL === "string" ? record.baseURL.trim() : "",
    apiKey: typeof record.apiKey === "string" ? record.apiKey.trim() : "",
    model: typeof record.model === "string" ? record.model.trim() : "",
  };
}

function normalizeConfigStrict(config: ExternalLlmConfig): ExternalLlmConfig {
  return {
    provider: config.provider,
    baseURL: config.baseURL.trim(),
    apiKey: config.apiKey.trim(),
    model: config.model.trim(),
  };
}

function safeStorage(): Storage | undefined {
  try {
    return typeof globalThis !== "undefined" ? globalThis.localStorage : undefined;
  } catch {
    return undefined;
  }
}
