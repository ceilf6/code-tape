import { afterEach, describe, expect, it, vi } from "vitest";
import { createExternalAsrSubtitleTranscriber } from "../externalAsrSubtitleTranscriber";
import { createFallbackSubtitleTranscriber } from "../fallbackSubtitleTranscriber";
import type { ExternalAsrConfig } from "../subtitleAsrConfig";
import type { SubtitleTrackDraft, SubtitleTranscriber } from "../types";

const externalResult: SubtitleTrackDraft = {
  model: "gpt-4o-mini-transcribe",
  source: "external-asr",
  segments: [{ id: "subtitle-1", startMs: 0, endMs: 1_000, text: "external" }],
};

const localResult: SubtitleTrackDraft = {
  model: "onnx-community/whisper-tiny",
  source: "huggingface-local",
  segments: [{ id: "subtitle-1", startMs: 0, endMs: 1_000, text: "local" }],
};

const externalConfig: ExternalAsrConfig = {
  provider: "openai-compatible",
  baseURL: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "gpt-4o-mini-transcribe",
  language: "zh",
};

function transcriber(partial: Partial<SubtitleTranscriber>): SubtitleTranscriber {
  return {
    transcribe: vi.fn(async () => localResult),
    ...partial,
  };
}

describe("createFallbackSubtitleTranscriber", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the external transcriber first and skips local transcription when it succeeds", async () => {
    const primary = transcriber({ transcribe: vi.fn(async () => externalResult) });
    const fallback = transcriber({ transcribe: vi.fn(async () => localResult) });
    const wrapped = createFallbackSubtitleTranscriber(primary, fallback);

    await expect(
      wrapped.transcribe({
        mediaBlob: new Blob(["webm"], { type: "video/webm" }),
        durationMs: 1_000,
      }),
    ).resolves.toBe(externalResult);
    expect(fallback.transcribe).not.toHaveBeenCalled();
  });

  it("always warms up the local ASR fallback even when an external transcriber exists", async () => {
    const primary = transcriber({ warmUp: vi.fn(async () => undefined) });
    const fallback = transcriber({ warmUp: vi.fn(async () => undefined) });
    const wrapped = createFallbackSubtitleTranscriber(primary, fallback);

    await wrapped.warmUp?.();

    expect(fallback.warmUp).toHaveBeenCalledTimes(1);
    expect(primary.warmUp).not.toHaveBeenCalled();
  });

  it("falls back to local ASR when external ASR fails", async () => {
    const onFallback = vi.fn();
    const primary = transcriber({
      transcribe: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    const fallback = transcriber({ transcribe: vi.fn(async () => localResult) });
    const wrapped = createFallbackSubtitleTranscriber(primary, fallback, { onFallback });

    await expect(
      wrapped.transcribe({
        mediaBlob: new Blob(["webm"], { type: "video/webm" }),
        durationMs: 1_000,
      }),
    ).resolves.toBe(localResult);
    expect(onFallback).toHaveBeenCalledWith(expect.any(Error));
  });

  it("does not fallback after a user cancellation", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const primary = transcriber({
      transcribe: vi.fn(async () => {
        throw new DOMException("字幕生成已取消", "AbortError");
      }),
    });
    const fallback = transcriber({ transcribe: vi.fn(async () => localResult) });
    const wrapped = createFallbackSubtitleTranscriber(primary, fallback);

    await expect(
      wrapped.transcribe({
        mediaBlob: new Blob(["webm"], { type: "video/webm" }),
        durationMs: 1_000,
        signal: abortController.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fallback.transcribe).not.toHaveBeenCalled();
  });

  it("falls back to local ASR when an external ASR request times out", async () => {
    vi.useFakeTimers();
    const fetchImpl: typeof fetch = vi.fn(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const primary = createExternalAsrSubtitleTranscriber({
      config: externalConfig,
      fetchImpl,
      requestTimeoutMs: 1_000,
    });
    const fallback = transcriber({ transcribe: vi.fn(async () => localResult) });
    const wrapped = createFallbackSubtitleTranscriber(primary, fallback);

    const result = wrapped.transcribe({
      mediaBlob: new Blob(["webm"], { type: "video/webm" }),
      durationMs: 1_000,
    });
    const assertion = expect(result).resolves.toBe(localResult);
    await vi.advanceTimersByTimeAsync(1_000);

    await assertion;
    expect(fallback.transcribe).toHaveBeenCalledTimes(1);
  });

  it("does not fallback when the user aborts a pending external ASR request", async () => {
    const abortController = new AbortController();
    const fetchImpl: typeof fetch = vi.fn(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const primary = createExternalAsrSubtitleTranscriber({
      config: externalConfig,
      fetchImpl,
      requestTimeoutMs: 1_000,
    });
    const fallback = transcriber({ transcribe: vi.fn(async () => localResult) });
    const wrapped = createFallbackSubtitleTranscriber(primary, fallback);

    const result = wrapped.transcribe({
      mediaBlob: new Blob(["webm"], { type: "video/webm" }),
      durationMs: 1_000,
      signal: abortController.signal,
    });
    abortController.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(fallback.transcribe).not.toHaveBeenCalled();
  });
});
