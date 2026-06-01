import { describe, expect, it } from "vitest";
import {
  SUBTITLE_ASR_CONFIG_STORAGE_KEY,
  clearExternalAsrConfig,
  isExternalAsrConfigured,
  loadExternalAsrConfig,
  saveExternalAsrConfig,
  type ExternalAsrConfig,
} from "../subtitleAsrConfig";

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

const validConfig: ExternalAsrConfig = {
  provider: "openai-compatible",
  baseURL: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "gpt-4o-mini-transcribe",
  language: "zh",
};

describe("subtitleAsrConfig", () => {
  it("round-trips a saved OpenAI-compatible ASR config", () => {
    const storage = createMemoryStorage();
    saveExternalAsrConfig(validConfig, storage);

    expect(loadExternalAsrConfig(storage)).toEqual(validConfig);
    expect(storage.map.has(SUBTITLE_ASR_CONFIG_STORAGE_KEY)).toBe(true);
  });

  it("trims fields and keeps language optional", () => {
    const storage = createMemoryStorage({
      [SUBTITLE_ASR_CONFIG_STORAGE_KEY]: JSON.stringify({
        provider: "openai-compatible",
        baseURL: "  https://api.example.com/v1  ",
        apiKey: "  sk-test  ",
        model: "  whisper-1  ",
        language: "   ",
      }),
    });

    expect(loadExternalAsrConfig(storage)).toEqual({
      provider: "openai-compatible",
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-test",
      model: "whisper-1",
      language: "",
    });
  });

  it("rejects corrupted or unknown persisted providers", () => {
    expect(loadExternalAsrConfig(createMemoryStorage())).toBeNull();
    expect(
      loadExternalAsrConfig(
        createMemoryStorage({ [SUBTITLE_ASR_CONFIG_STORAGE_KEY]: "{not json" }),
      ),
    ).toBeNull();
    expect(
      loadExternalAsrConfig(
        createMemoryStorage({
          [SUBTITLE_ASR_CONFIG_STORAGE_KEY]: JSON.stringify({ ...validConfig, provider: "other" }),
        }),
      ),
    ).toBeNull();
  });

  it("treats only complete configs as configured", () => {
    expect(isExternalAsrConfigured(validConfig)).toBe(true);
    expect(isExternalAsrConfigured({ ...validConfig, language: "" })).toBe(true);
    expect(isExternalAsrConfigured(null)).toBe(false);
    expect(isExternalAsrConfigured({ ...validConfig, baseURL: "" })).toBe(false);
    expect(isExternalAsrConfigured({ ...validConfig, apiKey: "   " })).toBe(false);
    expect(isExternalAsrConfigured({ ...validConfig, model: "" })).toBe(false);
  });

  it("clears a stored config and degrades when storage throws", () => {
    const storage = createMemoryStorage();
    saveExternalAsrConfig(validConfig, storage);
    clearExternalAsrConfig(storage);
    expect(loadExternalAsrConfig(storage)).toBeNull();

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
    expect(loadExternalAsrConfig(throwingStorage)).toBeNull();
    expect(() => saveExternalAsrConfig(validConfig, throwingStorage)).not.toThrow();
    expect(() => clearExternalAsrConfig(throwingStorage)).not.toThrow();
  });
});
