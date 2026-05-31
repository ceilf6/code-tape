import { afterEach, describe, expect, it, vi } from "vitest";
import { createHuggingFaceSubtitleTranscriber, normalizeTranscriptionResult } from "../subtitleTranscriber";

const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: originalCreateObjectUrl,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: originalRevokeObjectUrl,
  });
});

describe("normalizeTranscriptionResult", () => {
  it("turns Hugging Face ASR chunks into millisecond subtitle segments", () => {
    const segments = normalizeTranscriptionResult(
      {
        text: "We start with state, then render the loop.",
        chunks: [
          { text: " We start with state", timestamp: [0.32, 2.1] },
          { text: " then render the loop.", timestamp: [2.1, 4.75] },
        ],
      },
      5_000,
    );

    expect(segments).toEqual([
      { id: "subtitle-1", startMs: 320, endMs: 2_100, text: "We start with state" },
      { id: "subtitle-2", startMs: 2_100, endMs: 4_750, text: "then render the loop." },
    ]);
  });

  it("falls back to one full-duration segment when the model returns plain text", () => {
    const segments = normalizeTranscriptionResult({ text: "No chunk metadata." }, 7_500);

    expect(segments).toEqual([
      { id: "subtitle-1", startMs: 0, endMs: 7_500, text: "No chunk metadata." },
    ]);
  });

  it("drops empty chunks and clamps out-of-range timestamps", () => {
    const segments = normalizeTranscriptionResult(
      {
        chunks: [
          { text: "   ", timestamp: [0, 1] },
          { text: " valid ", timestamp: [-2, 12] },
        ],
      },
      3_000,
    );

    expect(segments).toEqual([
      { id: "subtitle-1", startMs: 0, endMs: 3_000, text: "valid" },
    ]);
  });

  it("keeps chunks with an open ended timestamp by ending them at the recording duration", () => {
    const segments = normalizeTranscriptionResult(
      {
        chunks: [{ text: " final thought ", timestamp: [2.1, null] }],
      },
      5_000,
    );

    expect(segments).toEqual([
      { id: "subtitle-1", startMs: 2_100, endMs: 5_000, text: "final thought" },
    ]);
  });

  it("retries pipeline initialization after a failed model load", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:subtitle-source"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const pipeline = vi.fn(async () => ({ chunks: [] }));
    const pipelineFactory = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary model load failure"))
      .mockResolvedValueOnce(pipeline);
    const transcriber = createHuggingFaceSubtitleTranscriber({ pipelineFactory });

    await expect(
      transcriber.transcribe({
        mediaBlob: new Blob(["audio"], { type: "audio/webm" }),
        durationMs: 1_000,
      }),
    ).rejects.toThrow("temporary model load failure");

    await expect(
      transcriber.transcribe({
        mediaBlob: new Blob(["audio"], { type: "audio/webm" }),
        durationMs: 1_000,
      }),
    ).resolves.toEqual({
      model: "onnx-community/whisper-tiny",
      source: "huggingface-local",
      language: "zh",
      segments: [],
    });
    expect(pipelineFactory).toHaveBeenCalledTimes(2);
  });

  it("loads the browser ASR pipeline with vendored q8 WASM weights", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:subtitle-source"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const pipeline = vi.fn(async () => ({ chunks: [] }));
    const pipelineFactory = vi.fn(async () => pipeline);
    const transcriber = createHuggingFaceSubtitleTranscriber({ pipelineFactory });

    await transcriber.transcribe({
      mediaBlob: new Blob(["audio"], { type: "audio/webm" }),
      durationMs: 1_000,
    });

    expect(pipelineFactory).toHaveBeenCalledWith(
      "automatic-speech-recognition",
      "onnx-community/whisper-tiny",
      { device: "wasm", dtype: "q8" },
    );
  });

  it("sets Whisper to transcribe Chinese for the primary product scenario", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:subtitle-source"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const pipeline = vi.fn(async () => ({ chunks: [] }));
    const transcriber = createHuggingFaceSubtitleTranscriber({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await transcriber.transcribe({
      mediaBlob: new Blob(["audio"], { type: "audio/webm" }),
      durationMs: 1_000,
    });

    expect(pipeline).toHaveBeenCalledWith(
      "blob:subtitle-source",
      expect.objectContaining({ language: "chinese", task: "transcribe" }),
    );
  });

  it("uses the ASR reported language when available", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:subtitle-source"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const pipeline = vi.fn(async () => ({ chunks: [], language: "en" }));
    const transcriber = createHuggingFaceSubtitleTranscriber({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await expect(
      transcriber.transcribe({
        mediaBlob: new Blob(["audio"], { type: "audio/webm" }),
        durationMs: 1_000,
      }),
    ).resolves.toMatchObject({ language: "en" });
  });

  it("warms up the ASR model before the first transcription", async () => {
    const pipeline = vi.fn(async () => ({ chunks: [] }));
    const pipelineFactory = vi.fn(async () => pipeline);
    const transcriber = createHuggingFaceSubtitleTranscriber({ pipelineFactory });

    await transcriber.warmUp?.();

    expect(pipelineFactory).toHaveBeenCalledTimes(1);
  });

  it("retries transcription after a failed warm-up model load", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:subtitle-source"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const pipeline = vi.fn(async () => ({ chunks: [] }));
    const pipelineFactory = vi
      .fn()
      .mockRejectedValueOnce(new Error("warm-up model load failure"))
      .mockResolvedValueOnce(pipeline);
    const transcriber = createHuggingFaceSubtitleTranscriber({ pipelineFactory });

    await expect(transcriber.warmUp?.()).rejects.toThrow("warm-up model load failure");

    await expect(
      transcriber.transcribe({
        mediaBlob: new Blob(["audio"], { type: "audio/webm" }),
        durationMs: 1_000,
      }),
    ).resolves.toEqual({
      model: "onnx-community/whisper-tiny",
      source: "huggingface-local",
      language: "zh",
      segments: [],
    });
    expect(pipelineFactory).toHaveBeenCalledTimes(2);
  });
});
