import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SubtitlePanel } from "../SubtitlePanel";
import type {
  SubtitleChapter,
  SubtitlePostProcessor,
  SubtitleStore,
  SubtitleTrack,
  SubtitleTranscriber,
} from "../types";

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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function roundDuration(value: number): number {
  return Math.round(Math.max(0, value) * 1_000) / 1_000;
}

describe("subtitle postprocessor runtime benchmark", () => {
  it("measures click-to-ready timing without blocking subtitle and chapter seeking", async () => {
    const originalTrack: SubtitleTrack = {
      recordingId: "recording-1",
      generatedAt: "2026-05-28T00:00:00.000Z",
      model: "onnx-community/whisper-tiny",
      source: "huggingface-local",
      segments: [
        { id: "subtitle-1", startMs: 0, endMs: 1_000, text: "use state hook" },
        { id: "subtitle-2", startMs: 1_000, endMs: 3_000, text: "render result" },
      ],
    };
    const store = createMemorySubtitleStore();
    await store.saveWithChapters(originalTrack, [
      { id: "chapter-1", title: "已有章节", startMs: 0, endMs: 3_000 },
    ]);
    const postProcessing = createDeferred<{
      segments: Array<{ id: string; text: string }>;
      chapters: Array<{ title: string; startMs: number; endMs?: number }>;
    }>();
    let warmUpStartedAt = 0;
    let warmUpEndedAt = 0;
    let clickStartedAt = 0;
    let processCalledAt = 0;
    let processResolvedAt = 0;
    const postProcessor: SubtitlePostProcessor = {
      warmUp: vi.fn(async () => {
        warmUpStartedAt = performance.now();
        await Promise.resolve();
        warmUpEndedAt = performance.now();
      }),
      process: vi.fn(async () => {
        processCalledAt = performance.now();
        const result = await postProcessing.promise;
        processResolvedAt = performance.now();
        return result;
      }),
    };
    const transcriber: SubtitleTranscriber = {
      transcribe: vi.fn(async () => ({
        model: "onnx-community/whisper-tiny",
        source: "huggingface-local" as const,
        segments: [],
      })),
    };
    const onSeek = vi.fn();

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={new Blob(["webm"], { type: "video/webm" })}
        hasAudio
        durationMs={3_000}
        currentTimeMs={500}
        onSeek={onSeek}
        store={store}
        transcriber={transcriber}
        postProcessor={postProcessor}
      />,
    );

    await waitFor(() => expect(screen.getByText("use state hook")).toBeInTheDocument());
    await waitFor(() => expect(postProcessor.warmUp).toHaveBeenCalled());
    await waitFor(() => expect(warmUpEndedAt).toBeGreaterThanOrEqual(warmUpStartedAt));

    clickStartedAt = performance.now();
    fireEvent.click(screen.getByRole("button", { name: "纠错并生成章节" }));
    await waitFor(() => expect(postProcessor.process).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "render result" }));
    fireEvent.click(screen.getByRole("button", { name: /已有章节/ }));

    const playbackProbeResponsiveDuringPostprocess =
      onSeek.mock.calls.some(([timeMs]) => timeMs === 1_000) &&
      onSeek.mock.calls.some(([timeMs]) => timeMs === 0);

    await act(async () => {
      postProcessing.resolve({
        segments: [{ id: "subtitle-1", text: "useState hook" }],
        chapters: [{ title: "代码实现", startMs: 1_000, endMs: 3_000 }],
      });
      await flushPromises();
    });

    await waitFor(() => expect(screen.getByText("useState hook")).toBeInTheDocument());
    const resultReadyAt = performance.now();
    const metrics = {
      benchmarkName: "subtitle-panel-jsdom-mock-postprocessor",
      modelWorkerWarmUpDurationMs: roundDuration(warmUpEndedAt - warmUpStartedAt),
      warmUpCompletedBeforeClick: warmUpEndedAt > 0 && warmUpEndedAt <= clickStartedAt,
      clickToPostProcessorCallDurationMs: roundDuration(processCalledAt - clickStartedAt),
      mockWorkerInferenceDurationMs: roundDuration(processResolvedAt - processCalledAt),
      resultToUiCommitDurationMs: roundDuration(resultReadyAt - processResolvedAt),
      postprocessClickToResultReadyDurationMs: roundDuration(resultReadyAt - clickStartedAt),
      playbackProbeResponsiveDuringPostprocess,
    };

    if (process.env.SUBTITLE_RUNTIME_BENCHMARK === "1") {
      console.log(JSON.stringify({ subtitlePostprocessRuntimeBenchmark: metrics }, null, 2));
    }

    expect(metrics.warmUpCompletedBeforeClick).toBe(true);
    expect(metrics.postprocessClickToResultReadyDurationMs).toBeGreaterThanOrEqual(0);
    expect(metrics.clickToPostProcessorCallDurationMs).toBeGreaterThanOrEqual(0);
    expect(metrics.mockWorkerInferenceDurationMs).toBeGreaterThanOrEqual(0);
    expect(metrics.resultToUiCommitDurationMs).toBeGreaterThanOrEqual(0);
    expect(metrics.playbackProbeResponsiveDuringPostprocess).toBe(true);
    expect(screen.getByRole("button", { name: /代码实现/ })).toBeInTheDocument();
  });
});
