import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubtitlePanel } from "../SubtitlePanel";
import { saveExternalAsrConfig } from "../subtitleAsrConfig";
import { saveExternalLlmConfig } from "../subtitleLlmConfig";
import type {
  SubtitleChapter,
  SubtitleCorrectionResult,
  SubtitlePostProcessor,
  SubtitleStore,
  SubtitleTrack,
  SubtitleTrackDraft,
  SubtitleTranscriber,
} from "../types";

const subtitleModelMocks = vi.hoisted(() => {
  const externalTranscriber = {
    transcribe: vi.fn<SubtitleTranscriber["transcribe"]>(),
  };
  const externalPostProcessor = {
    process: vi.fn<SubtitlePostProcessor["process"]>(),
  };
  return {
    createHuggingFaceSubtitleTranscriber: vi.fn(() => ({
      transcribe: vi.fn(),
      warmUp: vi.fn(),
    })),
    createWorkerBackedHuggingFaceSubtitlePostProcessor: vi.fn(() => ({
      process: vi.fn(),
      warmUp: vi.fn(),
      dispose: vi.fn(),
    })),
    createExternalAsrSubtitleTranscriber: vi.fn(() => externalTranscriber),
    createExternalLlmSubtitlePostProcessor: vi.fn(() => externalPostProcessor),
    externalTranscriber,
    externalPostProcessor,
  };
});

vi.mock("../subtitleTranscriber", () => ({
  createHuggingFaceSubtitleTranscriber: subtitleModelMocks.createHuggingFaceSubtitleTranscriber,
}));

vi.mock("../subtitlePostProcessorWorkerClient", () => ({
  createWorkerBackedHuggingFaceSubtitlePostProcessor:
    subtitleModelMocks.createWorkerBackedHuggingFaceSubtitlePostProcessor,
}));

vi.mock("../externalAsrSubtitleTranscriber", () => ({
  createExternalAsrSubtitleTranscriber: subtitleModelMocks.createExternalAsrSubtitleTranscriber,
}));

vi.mock("../externalLlmSubtitlePostProcessor", () => ({
  createExternalLlmSubtitlePostProcessor:
    subtitleModelMocks.createExternalLlmSubtitlePostProcessor,
}));

function createMemorySubtitleStore(): SubtitleStore {
  const tracks = new Map<string, SubtitleTrack>();
  const chaptersByRecordingId = new Map<string, SubtitleChapter[]>();
  return {
    async load(recordingId) {
      return tracks.get(recordingId) ?? null;
    },
    async save(track) {
      tracks.set(track.recordingId, track);
    },
    async loadChapters(recordingId) {
      return chaptersByRecordingId.get(recordingId) ?? [];
    },
    async saveChapters(recordingId, chapters) {
      chaptersByRecordingId.set(recordingId, chapters);
    },
    async saveWithChapters(track, chapters) {
      tracks.set(track.recordingId, track);
      chaptersByRecordingId.set(track.recordingId, chapters);
    },
    async remove(recordingId) {
      tracks.delete(recordingId);
      chaptersByRecordingId.delete(recordingId);
    },
  };
}

describe("SubtitlePanel external subtitle models", () => {
  afterEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("uses only external ASR and LLM when both are configured", async () => {
    const asrConfig = {
      provider: "openai-compatible" as const,
      baseURL: "https://asr.example.test/v1",
      apiKey: "asr-key",
      model: "whisper-large-v3",
      language: "zh",
    };
    const llmConfig = {
      provider: "openai" as const,
      baseURL: "https://llm.example.test/v1",
      apiKey: "llm-key",
      model: "gpt-4o-mini",
    };
    const draft: SubtitleTrackDraft = {
      model: asrConfig.model,
      source: "external-asr",
      language: "zh",
      segments: [{ id: "subtitle-1", startMs: 0, endMs: 1_000, text: "external subtitle" }],
    };
    const correction: SubtitleCorrectionResult = {
      segments: [],
      chapters: [],
    };
    subtitleModelMocks.externalTranscriber.transcribe.mockResolvedValue(draft);
    subtitleModelMocks.externalPostProcessor.process.mockResolvedValue(correction);
    saveExternalAsrConfig(asrConfig);
    saveExternalLlmConfig(llmConfig);

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={new Blob(["webm"], { type: "video/webm" })}
        hasAudio
        durationMs={1_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={createMemorySubtitleStore()}
      />,
    );

    expect(subtitleModelMocks.createExternalAsrSubtitleTranscriber).toHaveBeenCalledWith({
      config: asrConfig,
    });
    expect(subtitleModelMocks.createExternalLlmSubtitlePostProcessor).toHaveBeenCalledWith({
      config: llmConfig,
    });
    expect(subtitleModelMocks.createHuggingFaceSubtitleTranscriber).not.toHaveBeenCalled();
    expect(
      subtitleModelMocks.createWorkerBackedHuggingFaceSubtitlePostProcessor,
    ).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "生成字幕并优化" })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "生成字幕并优化" }));

    await waitFor(() => expect(screen.getByText("external subtitle")).toBeInTheDocument());
    expect(subtitleModelMocks.externalTranscriber.transcribe).toHaveBeenCalledTimes(1);
    expect(subtitleModelMocks.externalPostProcessor.process).toHaveBeenCalledTimes(1);
    expect(subtitleModelMocks.createHuggingFaceSubtitleTranscriber).not.toHaveBeenCalled();
    expect(
      subtitleModelMocks.createWorkerBackedHuggingFaceSubtitlePostProcessor,
    ).not.toHaveBeenCalled();
  });
});
