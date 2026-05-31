import { describe, expect, it } from "vitest";
import {
  SUBTITLE_LLM_CONFIG_STORAGE_KEY,
  clearExternalLlmConfig,
  isExternalLlmConfigured,
  loadExternalLlmConfig,
  saveExternalLlmConfig,
  type ExternalLlmConfig,
} from "../subtitleLlmConfig";

function createMemoryStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

const validConfig: ExternalLlmConfig = {
  provider: "openai",
  baseURL: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "gpt-4o-mini",
};

describe("subtitleLlmConfig", () => {
  it("round-trips a saved config", () => {
    const storage = createMemoryStorage();
    saveExternalLlmConfig(validConfig, storage);
    expect(loadExternalLlmConfig(storage)).toEqual(validConfig);
    expect(storage.map.has(SUBTITLE_LLM_CONFIG_STORAGE_KEY)).toBe(true);
  });

  it("returns null when nothing is stored", () => {
    expect(loadExternalLlmConfig(createMemoryStorage())).toBeNull();
  });

  it("returns null for corrupted JSON", () => {
    const storage = createMemoryStorage({ [SUBTITLE_LLM_CONFIG_STORAGE_KEY]: "{not json" });
    expect(loadExternalLlmConfig(storage)).toBeNull();
  });

  it("rejects an unknown provider on load", () => {
    const storage = createMemoryStorage({
      [SUBTITLE_LLM_CONFIG_STORAGE_KEY]: JSON.stringify({ ...validConfig, provider: "gemini" }),
    });
    expect(loadExternalLlmConfig(storage)).toBeNull();
  });

  it("trims fields on load", () => {
    const storage = createMemoryStorage({
      [SUBTITLE_LLM_CONFIG_STORAGE_KEY]: JSON.stringify({
        provider: "anthropic",
        baseURL: "  https://api.anthropic.com  ",
        apiKey: "  key  ",
        model: "  claude  ",
      }),
    });
    expect(loadExternalLlmConfig(storage)).toEqual({
      provider: "anthropic",
      baseURL: "https://api.anthropic.com",
      apiKey: "key",
      model: "claude",
    });
  });

  it("clears a stored config", () => {
    const storage = createMemoryStorage();
    saveExternalLlmConfig(validConfig, storage);
    clearExternalLlmConfig(storage);
    expect(loadExternalLlmConfig(storage)).toBeNull();
  });

  it("treats a fully populated config as configured", () => {
    expect(isExternalLlmConfigured(validConfig)).toBe(true);
  });

  it("treats null or partial configs as not configured", () => {
    expect(isExternalLlmConfigured(null)).toBe(false);
    expect(isExternalLlmConfigured({ ...validConfig, apiKey: "" })).toBe(false);
    expect(isExternalLlmConfigured({ ...validConfig, baseURL: "   " })).toBe(false);
    expect(isExternalLlmConfigured({ ...validConfig, model: "" })).toBe(false);
  });

  it("degrades gracefully when storage throws", () => {
    const throwingStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadExternalLlmConfig(throwingStorage)).toBeNull();
    expect(() => saveExternalLlmConfig(validConfig, throwingStorage)).not.toThrow();
    expect(() => clearExternalLlmConfig(throwingStorage)).not.toThrow();
  });
});
