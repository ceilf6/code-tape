import { describe, expect, it, vi } from "vitest";
import { createFallbackSubtitlePostProcessor } from "../fallbackSubtitlePostProcessor";
import { ExternalLlmTimeoutError } from "../externalLlmSubtitlePostProcessor";
import type { SubtitleCorrectionResult, SubtitlePostProcessor, SubtitlePostProcessorInput } from "../types";

const input: SubtitlePostProcessorInput = {
  track: {
    recordingId: "rec-1",
    generatedAt: "2026-05-31T00:00:00.000Z",
    model: "whisper-tiny",
    source: "huggingface-local",
    segments: [{ id: "subtitle-1", startMs: 0, endMs: 1000, text: "hi" }],
  },
};

const primaryResult: SubtitleCorrectionResult = { segments: [{ id: "subtitle-1", text: "primary" }], chapters: [] };
const fallbackResult: SubtitleCorrectionResult = { segments: [{ id: "subtitle-1", text: "fallback" }], chapters: [] };

function processor(overrides: Partial<SubtitlePostProcessor>): SubtitlePostProcessor {
  return { process: vi.fn(async () => primaryResult), ...overrides };
}

describe("createFallbackSubtitlePostProcessor", () => {
  it("uses the primary result when the primary succeeds", async () => {
    const primary = processor({ process: vi.fn(async () => primaryResult) });
    const fallback = processor({ process: vi.fn(async () => fallbackResult) });
    const wrapped = createFallbackSubtitlePostProcessor(primary, fallback);

    expect(await wrapped.process(input)).toEqual(primaryResult);
    expect(fallback.process).not.toHaveBeenCalled();
  });

  it("falls back when the primary fails for a non-abort reason", async () => {
    const primary = processor({
      process: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    const fallback = processor({ process: vi.fn(async () => fallbackResult) });
    const onFallback = vi.fn();
    const wrapped = createFallbackSubtitlePostProcessor(primary, fallback, { onFallback });

    expect(await wrapped.process(input)).toEqual(fallbackResult);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("falls back when the external request times out (not a user cancel)", async () => {
    const timeoutError = new ExternalLlmTimeoutError(45_000);
    const primary = processor({
      process: vi.fn(async () => {
        throw timeoutError;
      }),
    });
    const fallback = processor({ process: vi.fn(async () => fallbackResult) });
    const onFallback = vi.fn();
    const wrapped = createFallbackSubtitlePostProcessor(primary, fallback, { onFallback });

    expect(await wrapped.process(input)).toEqual(fallbackResult);
    expect(onFallback).toHaveBeenCalledWith(timeoutError);
  });

  it("does not fall back when the primary aborts", async () => {
    const primary = processor({
      process: vi.fn(async () => {
        throw new DOMException("cancelled", "AbortError");
      }),
    });
    const fallback = processor({ process: vi.fn(async () => fallbackResult) });
    const wrapped = createFallbackSubtitlePostProcessor(primary, fallback);

    await expect(wrapped.process(input)).rejects.toMatchObject({ name: "AbortError" });
    expect(fallback.process).not.toHaveBeenCalled();
  });

  it("does not fall back when the input signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const primary = processor({
      process: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const fallback = processor({ process: vi.fn(async () => fallbackResult) });
    const wrapped = createFallbackSubtitlePostProcessor(primary, fallback);

    await expect(wrapped.process({ ...input, signal: controller.signal })).rejects.toThrow("boom");
    expect(fallback.process).not.toHaveBeenCalled();
  });

  it("warms up only the fallback", async () => {
    const primary = processor({ warmUp: vi.fn(async () => undefined) });
    const fallback = processor({ warmUp: vi.fn(async () => undefined) });
    const wrapped = createFallbackSubtitlePostProcessor(primary, fallback);

    await wrapped.warmUp?.();
    expect(fallback.warmUp).toHaveBeenCalledTimes(1);
    expect(primary.warmUp).not.toHaveBeenCalled();
  });

  it("disposes both processors", () => {
    const primary = processor({ dispose: vi.fn() });
    const fallback = processor({ dispose: vi.fn() });
    const wrapped = createFallbackSubtitlePostProcessor(primary, fallback);

    wrapped.dispose?.();
    expect(primary.dispose).toHaveBeenCalledTimes(1);
    expect(fallback.dispose).toHaveBeenCalledTimes(1);
  });
});
