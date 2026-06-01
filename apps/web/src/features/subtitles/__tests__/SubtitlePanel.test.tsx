import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installStaleChunkRecovery } from "../../../app/staleChunkRecovery";
import { SubtitlePanel } from "../SubtitlePanel";
import type {
  SubtitleChapter,
  SubtitleCorrectionResult,
  SubtitlePostProcessor,
  SubtitleStore,
  SubtitleTrack,
  SubtitleTrackDraft,
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

const GENERATE_SUBTITLES_LABEL = "生成字幕";
const GENERATE_AND_OPTIMIZE_LABEL = "生成字幕并优化";
const OPTIMIZE_SUBTITLES_LABEL = "优化字幕和章节";

describe("SubtitlePanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("generates subtitles from the media blob, highlights the active segment, and seeks on click", async () => {
    const store = createMemorySubtitleStore();
    const transcriber: SubtitleTranscriber = {
      transcribe: vi.fn(async () => ({
        model: "onnx-community/whisper-tiny",
        source: "huggingface-local" as const,
        segments: [
          { id: "subtitle-1", startMs: 0, endMs: 1_000, text: "Set up state." },
          { id: "subtitle-2", startMs: 1_000, endMs: 3_000, text: "Render the result." },
        ],
      })),
    };
    const onSeek = vi.fn();

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={new Blob(["webm"], { type: "video/webm" })}
        hasAudio
        durationMs={3_000}
        currentTimeMs={1_500}
        onSeek={onSeek}
        store={store}
        transcriber={transcriber}
        postProcessor={null}
      />,
    );

    const generateButton = screen.getByRole("button", { name: GENERATE_SUBTITLES_LABEL });

    await waitFor(() => expect(generateButton).not.toBeDisabled());

    fireEvent.click(generateButton);

    await waitFor(() => expect(screen.getByText("Render the result.")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Render the result." })).toHaveAttribute(
      "aria-current",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Set up state." }));

    expect(onSeek).toHaveBeenCalledWith(0);
    await expect(store.load("recording-1")).resolves.toEqual(
      expect.objectContaining({
        recordingId: "recording-1",
        model: "onnx-community/whisper-tiny",
        source: "huggingface-local",
      }),
    );
  });

  it("uses one click to show ASR subtitles before applying local LLM corrections and chapters", async () => {
    const store = createMemorySubtitleStore();
    const transcription = createDeferred<SubtitleTrackDraft>();
    const postProcessing = createDeferred<SubtitleCorrectionResult>();
    const transcriber: SubtitleTranscriber = {
      transcribe: vi.fn(() => transcription.promise),
    };
    const postProcessor: SubtitlePostProcessor = {
      process: vi.fn(() => postProcessing.promise),
    };

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={new Blob(["webm"], { type: "video/webm" })}
        hasAudio
        durationMs={3_000}
        currentTimeMs={1_500}
        onSeek={vi.fn()}
        store={store}
        transcriber={transcriber}
        postProcessor={postProcessor}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: GENERATE_AND_OPTIMIZE_LABEL })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: GENERATE_AND_OPTIMIZE_LABEL }));

    await act(async () => {
      transcription.resolve({
        model: "onnx-community/whisper-tiny",
        source: "huggingface-local",
        segments: [
          { id: "subtitle-1", startMs: 0, endMs: 1_000, text: "use state hook" },
          { id: "subtitle-2", startMs: 1_000, endMs: 3_000, text: "render result" },
        ],
      });
      await flushPromises();
    });

    expect(screen.getByText("use state hook")).toBeInTheDocument();
    expect(screen.getByText("render result")).toBeInTheDocument();
    expect(screen.getByText("ASR 完成，正在纠错并生成章节...")).toBeInTheDocument();
    expect(postProcessor.process).toHaveBeenCalledWith(
      expect.objectContaining({
        track: expect.objectContaining({
          recordingId: "recording-1",
          segments: expect.arrayContaining([
            expect.objectContaining({ id: "subtitle-1", text: "use state hook" }),
          ]),
        }),
      }),
    );
    await expect(store.load("recording-1")).resolves.toEqual(
      expect.objectContaining({
        segments: expect.arrayContaining([
          expect.objectContaining({ id: "subtitle-2", text: "render result" }),
        ]),
      }),
    );

    await act(async () => {
      postProcessing.resolve({
        segments: [{ id: "subtitle-1", text: "useState hook" }],
        chapters: [{ title: "代码实现", startMs: 1_000, endMs: 3_000 }],
      });
      await flushPromises();
    });

    await waitFor(() => expect(screen.getByText("useState hook")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /代码实现/ })).toBeInTheDocument();
    await expect(store.loadChapters("recording-1")).resolves.toEqual([
      { id: "chapter-1", title: "代码实现", startMs: 1_000, endMs: 3_000 },
    ]);
  });

  it("recovers from stale Transformers chunks during subtitle generation without showing the raw import error", async () => {
    const store = createMemorySubtitleStore();
    const reload = vi.fn();
    const cleanupRecovery = installStaleChunkRecovery({
      reload,
      storage: {
        getItem: () => null,
        setItem: vi.fn(),
      },
      getRecoveryToken: () => "entry-index-C.js",
    });
    const staleChunkError = new TypeError(
      "Failed to fetch dynamically imported module: https://ceilf6.github.io/code-tape/assets/transformers.web-Ddnr203B.js",
    );
    const transcriber: SubtitleTranscriber = {
      transcribe: vi.fn(async () => {
        throw staleChunkError;
      }),
    };

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={new Blob(["webm"], { type: "video/webm" })}
        hasAudio
        durationMs={3_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={store}
        transcriber={transcriber}
        postProcessor={null}
      />,
    );

    const generateButton = screen.getByRole("button", { name: GENERATE_SUBTITLES_LABEL });
    await waitFor(() => expect(generateButton).not.toBeDisabled());

    fireEvent.click(generateButton);

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    cleanupRecovery();
  });

  it("runs local LLM post-processing to correct subtitles and render seekable chapters", async () => {
    const store = createMemorySubtitleStore();
    const transcriber: SubtitleTranscriber = {
      transcribe: vi.fn(async () => ({
        model: "onnx-community/whisper-tiny",
        source: "huggingface-local" as const,
        segments: [
          { id: "subtitle-1", startMs: 0, endMs: 1_000, text: "use state hook" },
          { id: "subtitle-2", startMs: 1_000, endMs: 3_000, text: "render result" },
        ],
      })),
    };
    const postProcessor: SubtitlePostProcessor = {
      process: vi.fn(async () => ({
        segments: [
          { id: "subtitle-1", text: "useState hook" },
          { id: "subtitle-2", text: "渲染 result" },
        ],
        chapters: [{ title: "代码实现", startMs: 1_000, endMs: 3_000 }],
      })),
    };
    const onSeek = vi.fn();

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={new Blob(["webm"], { type: "video/webm" })}
        hasAudio
        durationMs={3_000}
        currentTimeMs={1_500}
        onSeek={onSeek}
        store={store}
        transcriber={transcriber}
        postProcessor={postProcessor}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: GENERATE_AND_OPTIMIZE_LABEL })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: GENERATE_AND_OPTIMIZE_LABEL }));
    await waitFor(() => expect(screen.getByText("use state hook")).toBeInTheDocument());

    await waitFor(() => expect(screen.getByText("useState hook")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /代码实现/ })).toHaveAttribute(
      "aria-current",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: /代码实现/ }));

    expect(postProcessor.process).toHaveBeenCalled();
    expect(onSeek).toHaveBeenCalledWith(1_000);
    await expect(store.loadChapters("recording-1")).resolves.toEqual([
      { id: "chapter-1", title: "代码实现", startMs: 1_000, endMs: 3_000 },
    ]);
  });

  it("keeps subtitle seeking available while local LLM post-processing is pending", async () => {
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
    const postProcessor: SubtitlePostProcessor = {
      process: vi.fn(() => postProcessing.promise),
    };
    const onSeek = vi.fn();

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={null}
        hasAudio
        durationMs={3_000}
        currentTimeMs={500}
        onSeek={onSeek}
        store={store}
        transcriber={{
          transcribe: vi.fn(async () => ({
            model: "onnx-community/whisper-tiny",
            source: "huggingface-local" as const,
            segments: [],
          })),
        }}
        postProcessor={postProcessor}
      />,
    );

    await waitFor(() => expect(screen.getByText("use state hook")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: OPTIMIZE_SUBTITLES_LABEL }));
    fireEvent.click(screen.getByRole("button", { name: "render result" }));
    fireEvent.click(screen.getByRole("button", { name: /已有章节/ }));

    expect(onSeek).toHaveBeenCalledWith(1_000);
    expect(onSeek).toHaveBeenCalledWith(0);

    await act(async () => {
      postProcessing.resolve({
        segments: [{ id: "subtitle-1", text: "useState hook" }],
        chapters: [{ title: "代码实现", startMs: 1_000, endMs: 3_000 }],
      });
      await flushPromises();
    });

    await waitFor(() => expect(screen.getByText("useState hook")).toBeInTheDocument());
  });

  it("keeps ASR subtitles when local LLM post-processing fails", async () => {
    const transcriber: SubtitleTranscriber = {
      transcribe: vi.fn(async () => ({
        model: "onnx-community/whisper-tiny",
        source: "huggingface-local" as const,
        segments: [{ id: "subtitle-1", startMs: 0, endMs: 1_000, text: "use state hook" }],
      })),
    };
    const postProcessor: SubtitlePostProcessor = {
      process: vi
        .fn()
        .mockRejectedValueOnce(new Error("LLM JSON parse failed"))
        .mockResolvedValueOnce({
          segments: [{ id: "subtitle-1", text: "useState hook" }],
          chapters: [{ title: "失败后重试", startMs: 0, endMs: 1_000 }],
        }),
    };

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={new Blob(["webm"], { type: "video/webm" })}
        hasAudio
        durationMs={1_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={createMemorySubtitleStore()}
        transcriber={transcriber}
        postProcessor={postProcessor}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: GENERATE_AND_OPTIMIZE_LABEL })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: GENERATE_AND_OPTIMIZE_LABEL }));
    await waitFor(() => expect(screen.getByText("use state hook")).toBeInTheDocument());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("LLM JSON parse failed"),
    );
    expect(screen.getByText("use state hook")).toBeInTheDocument();

    const retryButton = screen.getByRole("button", { name: GENERATE_AND_OPTIMIZE_LABEL });
    await waitFor(() => expect(retryButton).not.toBeDisabled());
    fireEvent.click(retryButton);

    await waitFor(() => expect(screen.getByText("useState hook")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /失败后重试/ })).toBeInTheDocument();
    expect(transcriber.transcribe).toHaveBeenCalledTimes(2);
    expect(postProcessor.process).toHaveBeenCalledTimes(2);
  });

  it("clears persisted chapters after regenerating ASR subtitles when local LLM post-processing fails", async () => {
    const previousTrack: SubtitleTrack = {
      recordingId: "recording-1",
      generatedAt: "2026-05-28T00:00:00.000Z",
      model: "onnx-community/whisper-tiny",
      source: "huggingface-local",
      segments: [{ id: "subtitle-1", startMs: 0, endMs: 1_000, text: "old subtitle" }],
    };
    const store = createMemorySubtitleStore();
    await store.saveWithChapters(previousTrack, [
      { id: "chapter-1", title: "旧章节", startMs: 0, endMs: 1_000 },
    ]);
    const transcriber: SubtitleTranscriber = {
      transcribe: vi.fn(async () => ({
        model: "onnx-community/whisper-tiny",
        source: "huggingface-local" as const,
        segments: [{ id: "subtitle-1", startMs: 0, endMs: 1_000, text: "new ASR subtitle" }],
      })),
    };
    const postProcessor: SubtitlePostProcessor = {
      process: vi.fn(async () => {
        throw new Error("LLM JSON parse failed");
      }),
    };
    const panelProps = {
      recordingId: "recording-1",
      mediaBlob: new Blob(["webm"], { type: "video/webm" }),
      hasAudio: true,
      durationMs: 1_000,
      currentTimeMs: 0,
      onSeek: vi.fn(),
      store,
      transcriber,
      postProcessor,
    } satisfies Parameters<typeof SubtitlePanel>[0];

    const { unmount } = render(<SubtitlePanel {...panelProps} />);

    await waitFor(() => expect(screen.getByText("old subtitle")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /旧章节/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: GENERATE_AND_OPTIMIZE_LABEL }));

    await waitFor(() => expect(screen.getByText("new ASR subtitle")).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("LLM JSON parse failed"),
    );
    expect(screen.queryByRole("button", { name: /旧章节/ })).not.toBeInTheDocument();
    await expect(store.loadChapters("recording-1")).resolves.toEqual([]);
    await expect(store.load("recording-1")).resolves.toEqual(
      expect.objectContaining({
        segments: [expect.objectContaining({ text: "new ASR subtitle" })],
      }),
    );

    unmount();
    render(<SubtitlePanel {...panelProps} mediaBlob={null} />);

    await waitFor(() => expect(screen.getByText("new ASR subtitle")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /旧章节/ })).not.toBeInTheDocument();
  });

  it("recovers from stale Transformers chunks during local LLM post-processing without showing the raw import error", async () => {
    const originalTrack: SubtitleTrack = {
      recordingId: "recording-1",
      generatedAt: "2026-05-28T00:00:00.000Z",
      model: "onnx-community/whisper-tiny",
      source: "huggingface-local",
      segments: [{ id: "subtitle-1", startMs: 0, endMs: 1_000, text: "use state hook" }],
    };
    const store = createMemorySubtitleStore();
    await store.saveWithChapters(originalTrack, []);
    const reload = vi.fn();
    const cleanupRecovery = installStaleChunkRecovery({
      reload,
      storage: {
        getItem: () => null,
        setItem: vi.fn(),
      },
      getRecoveryToken: () => "entry-index-B.js",
    });
    const staleChunkError = new TypeError(
      "Failed to fetch dynamically imported module: https://ceilf6.github.io/code-tape/assets/transformers.web-Ddnr203B.js",
    );
    const postProcessor: SubtitlePostProcessor = {
      process: vi.fn(async () => {
        throw staleChunkError;
      }),
    };

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={null}
        hasAudio
        durationMs={1_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={store}
        transcriber={{
          transcribe: vi.fn(async () => ({
            model: "onnx-community/whisper-tiny",
            source: "huggingface-local" as const,
            segments: [],
          })),
        }}
        postProcessor={postProcessor}
      />,
    );

    await waitFor(() => expect(screen.getByText("use state hook")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: OPTIMIZE_SUBTITLES_LABEL }));

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("use state hook")).toBeInTheDocument();
    cleanupRecovery();
  });

  it("does not persist corrected subtitles when processed subtitle and chapter save fails", async () => {
    const originalTrack: SubtitleTrack = {
      recordingId: "recording-1",
      generatedAt: "2026-05-28T00:00:00.000Z",
      model: "onnx-community/whisper-tiny",
      source: "huggingface-local",
      segments: [{ id: "subtitle-1", startMs: 0, endMs: 1_000, text: "use state hook" }],
    };
    const store = createMemorySubtitleStore();
    const writeError = new Error("atomic write failed");
    store.saveWithChapters = vi.fn(async () => {
      throw writeError;
    });
    store.saveChapters = vi.fn(async () => {
      throw writeError;
    });
    await store.save(originalTrack);
    const postProcessor: SubtitlePostProcessor = {
      process: vi.fn(async () => ({
        segments: [{ id: "subtitle-1", text: "useState hook" }],
        chapters: [{ title: "问题分析", startMs: 0, endMs: 1_000 }],
      })),
    };

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={null}
        hasAudio
        durationMs={1_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={store}
        transcriber={{
          transcribe: vi.fn(async () => ({
            model: "onnx-community/whisper-tiny",
            source: "huggingface-local" as const,
            segments: [],
          })),
        }}
        postProcessor={postProcessor}
      />,
    );

    await waitFor(() => expect(screen.getByText("use state hook")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: OPTIMIZE_SUBTITLES_LABEL }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("atomic write failed"));
    expect(screen.getByText("use state hook")).toBeInTheDocument();
    await expect(store.load("recording-1")).resolves.toEqual(originalTrack);
    expect(store.saveWithChapters).toHaveBeenCalled();
  });

  it("keeps existing chapters when the local LLM returns an invalid correction", async () => {
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
    const existingChapters: SubtitleChapter[] = [
      { id: "chapter-1", title: "已有章节", startMs: 0, endMs: 3_000 },
    ];
    const store = createMemorySubtitleStore();
    await store.saveWithChapters(originalTrack, existingChapters);
    const postProcessor: SubtitlePostProcessor = {
      process: vi.fn(async () => ({
        segments: [{ id: "missing-subtitle", text: "useState hook" }],
        chapters: [],
      })),
    };

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={null}
        hasAudio
        durationMs={3_000}
        currentTimeMs={500}
        onSeek={vi.fn()}
        store={store}
        transcriber={{
          transcribe: vi.fn(async () => ({
            model: "onnx-community/whisper-tiny",
            source: "huggingface-local" as const,
            segments: [],
          })),
        }}
        postProcessor={postProcessor}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /已有章节/ })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: OPTIMIZE_SUBTITLES_LABEL }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "correction references unknown segment: missing-subtitle",
      ),
    );
    expect(screen.getByRole("button", { name: /已有章节/ })).toBeInTheDocument();
    await expect(store.load("recording-1")).resolves.toEqual(originalTrack);
    await expect(store.loadChapters("recording-1")).resolves.toEqual(existingChapters);
  });

  it("times out stalled local LLM post-processing without clearing subtitles or chapters", async () => {
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
    const existingChapters: SubtitleChapter[] = [
      { id: "chapter-1", title: "已有章节", startMs: 0, endMs: 3_000 },
    ];
    const store = createMemorySubtitleStore();
    await store.saveWithChapters(originalTrack, existingChapters);
    const onSeek = vi.fn();
    let processSignal: AbortSignal | undefined;
    const postProcessor: SubtitlePostProcessor = {
      process: vi.fn(
        ({ signal }) =>
          new Promise<SubtitleCorrectionResult>((_, reject) => {
            processSignal = signal;
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("字幕纠错已取消", "AbortError")),
              { once: true },
            );
          }),
      ),
    };

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={null}
        hasAudio
        durationMs={3_000}
        currentTimeMs={500}
        onSeek={onSeek}
        store={store}
        transcriber={{
          transcribe: vi.fn(async () => ({
            model: "onnx-community/whisper-tiny",
            source: "huggingface-local" as const,
            segments: [],
          })),
        }}
        postProcessor={postProcessor}
        postProcessTimeoutMs={25}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /已有章节/ })).toBeInTheDocument(),
    );

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: OPTIMIZE_SUBTITLES_LABEL }));
      await act(async () => {
        await flushPromises();
      });
      expect(postProcessor.process).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: "render result" }));
      fireEvent.click(screen.getByRole("button", { name: /已有章节/ }));

      await act(async () => {
        vi.advanceTimersByTime(25);
        await flushPromises();
      });
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("字幕纠错超时"));
    expect(processSignal?.aborted).toBe(true);
    expect(screen.getByText("use state hook")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /已有章节/ })).toBeInTheDocument();
    expect(onSeek).toHaveBeenCalledWith(1_000);
    expect(onSeek).toHaveBeenCalledWith(0);
    await expect(store.load("recording-1")).resolves.toEqual(originalTrack);
    await expect(store.loadChapters("recording-1")).resolves.toEqual(existingChapters);
    expect(screen.getByRole("button", { name: OPTIMIZE_SUBTITLES_LABEL })).not.toBeDisabled();
  });

  it("ignores stale local LLM timeout after switching recordings", async () => {
    const firstTrack: SubtitleTrack = {
      recordingId: "recording-1",
      generatedAt: "2026-05-28T00:00:00.000Z",
      model: "onnx-community/whisper-tiny",
      source: "huggingface-local",
      segments: [{ id: "subtitle-1", startMs: 0, endMs: 1_000, text: "old recording subtitle" }],
    };
    const secondTrack: SubtitleTrack = {
      recordingId: "recording-2",
      generatedAt: "2026-05-28T00:00:01.000Z",
      model: "onnx-community/whisper-tiny",
      source: "huggingface-local",
      segments: [
        { id: "subtitle-2", startMs: 0, endMs: 1_000, text: "current recording subtitle" },
      ],
    };
    const store = createMemorySubtitleStore();
    await store.saveWithChapters(firstTrack, [
      { id: "chapter-1", title: "旧章节", startMs: 0, endMs: 1_000 },
    ]);
    await store.saveWithChapters(secondTrack, [
      { id: "chapter-2", title: "当前章节", startMs: 0, endMs: 1_000 },
    ]);
    let processSignal: AbortSignal | undefined;
    const postProcessor: SubtitlePostProcessor = {
      process: vi.fn(
        ({ signal }) =>
          new Promise<SubtitleCorrectionResult>(() => {
            processSignal = signal;
          }),
      ),
    };
    const props = {
      mediaBlob: null,
      hasAudio: true,
      durationMs: 1_000,
      currentTimeMs: 0,
      onSeek: vi.fn(),
      store,
      transcriber: {
        transcribe: vi.fn(async () => ({
          model: "onnx-community/whisper-tiny",
          source: "huggingface-local" as const,
          segments: [],
        })),
      },
      postProcessor,
      postProcessTimeoutMs: 25,
    };

    const { rerender } = render(<SubtitlePanel recordingId="recording-1" {...props} />);

    await waitFor(() => expect(screen.getByText("old recording subtitle")).toBeInTheDocument());

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: OPTIMIZE_SUBTITLES_LABEL }));
      await act(async () => {
        await flushPromises();
      });

      rerender(<SubtitlePanel recordingId="recording-2" {...props} />);
      await act(async () => {
        await flushPromises();
      });
      expect(screen.getByText("current recording subtitle")).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(25);
        await flushPromises();
      });
    } finally {
      vi.useRealTimers();
    }

    expect(processSignal?.aborted).toBe(true);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("current recording subtitle")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /当前章节/ })).toBeInTheDocument();
  });

  it("surfaces generation failure without blocking replay controls", async () => {
    const transcriber: SubtitleTranscriber = {
      transcribe: vi.fn(async () => {
        throw new Error("model unavailable");
      }),
    };

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={new Blob(["webm"], { type: "video/webm" })}
        hasAudio
        durationMs={3_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={createMemorySubtitleStore()}
        transcriber={transcriber}
        postProcessor={null}
      />,
    );

    const generateButton = screen.getByRole("button", { name: GENERATE_SUBTITLES_LABEL });

    await waitFor(() => expect(generateButton).not.toBeDisabled());

    fireEvent.click(generateButton);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("model unavailable"));
  });

  it("keeps generation disabled until saved subtitles finish loading", async () => {
    const loadedTrack = createDeferred<SubtitleTrack | null>();
    const store: SubtitleStore = {
      load: vi.fn(() => loadedTrack.promise),
      save: vi.fn(),
      loadChapters: vi.fn(async () => []),
      saveChapters: vi.fn(),
      saveWithChapters: vi.fn(),
      remove: vi.fn(),
    };

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={new Blob(["webm"], { type: "video/webm" })}
        hasAudio
        durationMs={3_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={store}
        transcriber={{
          transcribe: vi.fn(async () => ({
            model: "onnx-community/whisper-tiny",
            source: "huggingface-local" as const,
            segments: [],
          })),
        }}
        postProcessor={null}
      />,
    );

    const generateButton = screen.getByRole("button", { name: GENERATE_SUBTITLES_LABEL });

    await waitFor(() => expect(generateButton).toBeDisabled());

    await act(async () => {
      loadedTrack.resolve(null);
      await flushPromises();
    });

    expect(generateButton).not.toBeDisabled();
  });

  it("keeps saved subtitles visible when saved chapters fail to load", async () => {
    const store: SubtitleStore = {
      load: vi.fn(async () => ({
        recordingId: "recording-1",
        generatedAt: "2026-05-28T00:00:00.000Z",
        model: "onnx-community/whisper-tiny",
        source: "huggingface-local" as const,
        segments: [{ id: "subtitle-1", startMs: 0, endMs: 1_000, text: "useState hook" }],
      })),
      save: vi.fn(),
      loadChapters: vi.fn(async () => {
        throw new Error("chapter store unavailable");
      }),
      saveChapters: vi.fn(),
      saveWithChapters: vi.fn(),
      remove: vi.fn(),
    };

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={new Blob(["webm"], { type: "video/webm" })}
        hasAudio
        durationMs={1_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={store}
        transcriber={{
          transcribe: vi.fn(async () => ({
            model: "onnx-community/whisper-tiny",
            source: "huggingface-local" as const,
            segments: [],
          })),
        }}
      />,
    );

    await waitFor(() => expect(screen.getByText("useState hook")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores a generated track after switching to another recording", async () => {
    const generatedTrack = createDeferred<SubtitleTrackDraft>();
    const store: SubtitleStore = {
      load: vi.fn(async () => null),
      save: vi.fn(async () => undefined),
      loadChapters: vi.fn(async () => []),
      saveChapters: vi.fn(),
      saveWithChapters: vi.fn(),
      remove: vi.fn(),
    };
    const transcriber: SubtitleTranscriber = {
      transcribe: vi.fn(() => generatedTrack.promise),
    };
    const firstBlob = new Blob(["first"], { type: "video/webm" });
    const secondBlob = new Blob(["second"], { type: "video/webm" });

    const { rerender } = render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={firstBlob}
        hasAudio
        durationMs={3_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={store}
        transcriber={transcriber}
        postProcessor={null}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: GENERATE_SUBTITLES_LABEL })).not.toBeDisabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: GENERATE_SUBTITLES_LABEL }));

    rerender(
      <SubtitlePanel
        recordingId="recording-2"
        mediaBlob={secondBlob}
        hasAudio
        durationMs={3_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={store}
        transcriber={transcriber}
        postProcessor={null}
      />,
    );

    await act(async () => {
      generatedTrack.resolve({
        model: "onnx-community/whisper-tiny",
        source: "huggingface-local",
        segments: [{ id: "subtitle-1", startMs: 0, endMs: 1_000, text: "Old recording text." }],
      });
      await flushPromises();
    });

    expect(store.save).not.toHaveBeenCalled();
    expect(screen.queryByText("Old recording text.")).not.toBeInTheDocument();
  });

  it("warms up the transcriber when audio is available", async () => {
    const warmUp = vi.fn(async () => undefined);

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={new Blob(["webm"], { type: "video/webm" })}
        hasAudio
        durationMs={3_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={createMemorySubtitleStore()}
        transcriber={{
          warmUp,
          transcribe: vi.fn(async () => ({
            model: "onnx-community/whisper-tiny",
            source: "huggingface-local" as const,
            segments: [],
          })),
        }}
      />,
    );

    await waitFor(() => expect(warmUp).toHaveBeenCalledTimes(1));
  });

  it("warms up the transcriber as soon as the panel mounts even before audio is available", async () => {
    const warmUp = vi.fn(async () => undefined);

    render(
      <SubtitlePanel
        recordingId={null}
        mediaBlob={null}
        hasAudio={false}
        durationMs={0}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={createMemorySubtitleStore()}
        transcriber={{
          warmUp,
          transcribe: vi.fn(async () => ({
            model: "onnx-community/whisper-tiny",
            source: "huggingface-local" as const,
            segments: [],
          })),
        }}
        postProcessor={null}
      />,
    );

    await waitFor(() => expect(warmUp).toHaveBeenCalledTimes(1));
  });

  it("shows the active ASR stage while generating subtitles", async () => {
    const transcription = createDeferred<SubtitleTrackDraft>();
    const transcriber: SubtitleTranscriber = {
      warmUp: vi.fn(async () => undefined),
      transcribe: vi.fn((input) => {
        input.onStatus?.("loading-local-model");
        return transcription.promise;
      }),
    };

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={new Blob(["webm"], { type: "video/webm" })}
        hasAudio
        durationMs={3_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={createMemorySubtitleStore()}
        transcriber={transcriber}
        postProcessor={null}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: GENERATE_SUBTITLES_LABEL })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: GENERATE_SUBTITLES_LABEL }));

    expect(screen.getByText("正在加载本地 ASR 模型...")).toBeInTheDocument();

    act(() => {
      const input = vi.mocked(transcriber.transcribe).mock.calls[0]?.[0];
      input?.onStatus?.("transcribing");
    });

    expect(screen.getByText("正在识别音频...")).toBeInTheDocument();

    await act(async () => {
      transcription.resolve({
        model: "onnx-community/whisper-tiny",
        source: "huggingface-local",
        segments: [{ id: "subtitle-1", startMs: 0, endMs: 1_000, text: "done" }],
      });
      await flushPromises();
    });

    expect(screen.queryByText("正在识别音频...")).not.toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();
  });

  it("does not warm up the local LLM before subtitles exist", async () => {
    const transcriberWarmUp = vi.fn(async () => undefined);
    const postProcessorWarmUp = vi.fn(async () => undefined);
    const process = vi.fn(async () => ({ segments: [], chapters: [] }));

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={new Blob(["webm"], { type: "video/webm" })}
        hasAudio
        durationMs={3_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={createMemorySubtitleStore()}
        transcriber={{
          warmUp: transcriberWarmUp,
          transcribe: vi.fn(async () => ({
            model: "onnx-community/whisper-tiny",
            source: "huggingface-local" as const,
            segments: [],
          })),
        }}
        postProcessor={{
          warmUp: postProcessorWarmUp,
          process,
        }}
      />,
    );

    await act(async () => {
      await flushPromises();
    });

    expect(postProcessorWarmUp).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
  });

  it("does not warm up the local LLM for no-audio recordings with saved subtitles", async () => {
    const store = createMemorySubtitleStore();
    await store.save({
      recordingId: "recording-1",
      generatedAt: "2026-05-28T00:00:00.000Z",
      model: "onnx-community/whisper-tiny",
      source: "huggingface-local",
      segments: [{ id: "subtitle-1", startMs: 0, endMs: 1_000, text: "Saved subtitles." }],
    });
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      callback({ didTimeout: false, timeRemaining: () => 10 });
      return 1;
    });
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    const postProcessorWarmUp = vi.fn(async () => undefined);

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={null}
        hasAudio={false}
        durationMs={1_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={store}
        transcriber={{
          transcribe: vi.fn(async () => ({
            model: "onnx-community/whisper-tiny",
            source: "huggingface-local" as const,
            segments: [],
          })),
        }}
        postProcessor={{
          warmUp: postProcessorWarmUp,
          process: vi.fn(async () => ({ segments: [], chapters: [] })),
        }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("onnx-community/whisper-tiny")).toBeInTheDocument(),
    );
    expect(screen.getByText("无音频轨道")).toBeInTheDocument();
    expect(requestIdleCallback).not.toHaveBeenCalled();
    expect(postProcessorWarmUp).not.toHaveBeenCalled();
  });

  it("cancels pending idle local LLM warm-up on unmount", async () => {
    const store = createMemorySubtitleStore();
    await store.save({
      recordingId: "recording-1",
      generatedAt: "2026-05-28T00:00:00.000Z",
      model: "onnx-community/whisper-tiny",
      source: "huggingface-local",
      segments: [{ id: "subtitle-1", startMs: 0, endMs: 1_000, text: "Saved subtitles." }],
    });
    const idleCallbacks: IdleRequestCallback[] = [];
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      idleCallbacks.push(callback);
      return 7;
    });
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", cancelIdleCallback);
    const postProcessorWarmUp = vi.fn(async () => undefined);
    const dispose = vi.fn();

    const { unmount } = render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={new Blob(["webm"], { type: "video/webm" })}
        hasAudio
        durationMs={3_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={store}
        transcriber={{
          transcribe: vi.fn(async () => ({
            model: "onnx-community/whisper-tiny",
            source: "huggingface-local" as const,
            segments: [],
          })),
        }}
        postProcessor={{
          warmUp: postProcessorWarmUp,
          process: vi.fn(async () => ({ segments: [], chapters: [] })),
          dispose,
        }}
      />,
    );

    await waitFor(() => expect(screen.getByText("Saved subtitles.")).toBeInTheDocument());
    expect(requestIdleCallback).toHaveBeenCalledTimes(1);
    expect(postProcessorWarmUp).not.toHaveBeenCalled();

    unmount();

    expect(cancelIdleCallback).toHaveBeenCalledWith(7);
    expect(dispose).toHaveBeenCalledTimes(1);
    await act(async () => {
      idleCallbacks[0]?.({ didTimeout: false, timeRemaining: () => 10 });
      await flushPromises();
    });
    expect(postProcessorWarmUp).not.toHaveBeenCalled();
  });

  it("cancels pending idle local LLM warm-up when switching recordings", async () => {
    const store = createMemorySubtitleStore();
    await store.save({
      recordingId: "recording-1",
      generatedAt: "2026-05-28T00:00:00.000Z",
      model: "onnx-community/whisper-tiny",
      source: "huggingface-local",
      segments: [{ id: "subtitle-1", startMs: 0, endMs: 1_000, text: "First recording." }],
    });
    await store.save({
      recordingId: "recording-2",
      generatedAt: "2026-05-28T00:00:01.000Z",
      model: "onnx-community/whisper-tiny",
      source: "huggingface-local",
      segments: [{ id: "subtitle-1", startMs: 0, endMs: 1_000, text: "Second recording." }],
    });
    const idleCallbacks: IdleRequestCallback[] = [];
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    });
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", cancelIdleCallback);
    const postProcessorWarmUp = vi.fn(async () => undefined);
    const dispose = vi.fn();
    const postProcessor: SubtitlePostProcessor = {
      warmUp: postProcessorWarmUp,
      process: vi.fn(async () => ({ segments: [], chapters: [] })),
      dispose,
    };
    const mediaBlob = new Blob(["webm"], { type: "video/webm" });

    const { rerender } = render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={mediaBlob}
        hasAudio
        durationMs={3_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={store}
        transcriber={{
          transcribe: vi.fn(async () => ({
            model: "onnx-community/whisper-tiny",
            source: "huggingface-local" as const,
            segments: [],
          })),
        }}
        postProcessor={postProcessor}
      />,
    );

    await waitFor(() => expect(screen.getByText("First recording.")).toBeInTheDocument());
    expect(requestIdleCallback).toHaveBeenCalledTimes(1);
    expect(postProcessorWarmUp).not.toHaveBeenCalled();

    rerender(
      <SubtitlePanel
        recordingId="recording-2"
        mediaBlob={mediaBlob}
        hasAudio
        durationMs={3_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={store}
        transcriber={{
          transcribe: vi.fn(async () => ({
            model: "onnx-community/whisper-tiny",
            source: "huggingface-local" as const,
            segments: [],
          })),
        }}
        postProcessor={postProcessor}
      />,
    );

    expect(dispose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText("Second recording.")).toBeInTheDocument());
    expect(cancelIdleCallback).toHaveBeenCalledWith(1);
    expect(requestIdleCallback).toHaveBeenCalledTimes(2);

    await act(async () => {
      idleCallbacks[0]?.({ didTimeout: false, timeRemaining: () => 10 });
      await flushPromises();
    });
    expect(postProcessorWarmUp).not.toHaveBeenCalled();

    await act(async () => {
      idleCallbacks[1]?.({ didTimeout: false, timeRemaining: () => 10 });
      await flushPromises();
    });
    expect(postProcessorWarmUp).toHaveBeenCalledTimes(1);
  });

  it("schedules local LLM warm-up after saved subtitles load even before the media blob finishes loading", async () => {
    const store = createMemorySubtitleStore();
    await store.save({
      recordingId: "recording-1",
      generatedAt: "2026-05-28T00:00:00.000Z",
      model: "onnx-community/whisper-tiny",
      source: "huggingface-local",
      segments: [{ id: "subtitle-1", startMs: 0, endMs: 1_000, text: "Saved subtitles." }],
    });
    const idleCallbacks: IdleRequestCallback[] = [];
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      idleCallbacks.push(callback);
      return 1;
    });
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    const postProcessorWarmUp = vi.fn(async () => undefined);

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={null}
        hasAudio
        durationMs={3_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={store}
        transcriber={{
          transcribe: vi.fn(async () => ({
            model: "onnx-community/whisper-tiny",
            source: "huggingface-local" as const,
            segments: [],
          })),
        }}
        postProcessor={{
          warmUp: postProcessorWarmUp,
          process: vi.fn(async () => ({ segments: [], chapters: [] })),
        }}
      />,
    );

    await waitFor(() => expect(screen.getByText("Saved subtitles.")).toBeInTheDocument());
    expect(requestIdleCallback).toHaveBeenCalledTimes(1);
    expect(postProcessorWarmUp).not.toHaveBeenCalled();

    await act(async () => {
      idleCallbacks[0]?.({ didTimeout: false, timeRemaining: () => 10 });
      await flushPromises();
    });

    await waitFor(() => expect(postProcessorWarmUp).toHaveBeenCalledTimes(1));
  });

  it("skips local LLM warm-up when the browser has no idle callback API", async () => {
    const store = createMemorySubtitleStore();
    await store.save({
      recordingId: "recording-1",
      generatedAt: "2026-05-28T00:00:00.000Z",
      model: "onnx-community/whisper-tiny",
      source: "huggingface-local",
      segments: [{ id: "subtitle-1", startMs: 0, endMs: 1_000, text: "Saved subtitles." }],
    });
    vi.stubGlobal("requestIdleCallback", undefined);
    vi.stubGlobal("cancelIdleCallback", undefined);
    const postProcessorWarmUp = vi.fn(async () => undefined);

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={new Blob(["webm"], { type: "video/webm" })}
        hasAudio
        durationMs={3_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={store}
        transcriber={{
          transcribe: vi.fn(async () => ({
            model: "onnx-community/whisper-tiny",
            source: "huggingface-local" as const,
            segments: [],
          })),
        }}
        postProcessor={{
          warmUp: postProcessorWarmUp,
          process: vi.fn(async () => ({ segments: [], chapters: [] })),
        }}
      />,
    );

    await waitFor(() => expect(screen.getByText("Saved subtitles.")).toBeInTheDocument());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await flushPromises();
    });

    expect(postProcessorWarmUp).not.toHaveBeenCalled();
  });

  it("starts local LLM post-processing even if idle warm-up has not run yet", async () => {
    const store = createMemorySubtitleStore();
    await store.save({
      recordingId: "recording-1",
      generatedAt: "2026-05-28T00:00:00.000Z",
      model: "onnx-community/whisper-tiny",
      source: "huggingface-local",
      segments: [{ id: "subtitle-1", startMs: 0, endMs: 1_000, text: "use state hook" }],
    });
    const requestIdleCallback = vi.fn(() => 1);
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    const postProcessorWarmUp = vi.fn(async () => undefined);
    const process = vi.fn(async () => ({
      segments: [{ id: "subtitle-1", text: "useState hook" }],
      chapters: [{ title: "状态设计", startMs: 0, endMs: 1_000 }],
    }));

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={null}
        hasAudio
        durationMs={1_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={store}
        transcriber={{
          transcribe: vi.fn(async () => ({
            model: "onnx-community/whisper-tiny",
            source: "huggingface-local" as const,
            segments: [],
          })),
        }}
        postProcessor={{
          warmUp: postProcessorWarmUp,
          process,
        }}
      />,
    );

    await waitFor(() => expect(screen.getByText("use state hook")).toBeInTheDocument());
    expect(requestIdleCallback).toHaveBeenCalledTimes(1);
    expect(postProcessorWarmUp).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: OPTIMIZE_SUBTITLES_LABEL }));

    await waitFor(() => expect(process).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("useState hook")).toBeInTheDocument());
    expect(postProcessorWarmUp).not.toHaveBeenCalled();
  });

  it("reschedules local LLM warm-up when a pending idle warm-up is canceled by a new subtitle track", async () => {
    const store = createMemorySubtitleStore();
    await store.save({
      recordingId: "recording-1",
      generatedAt: "2026-05-28T00:00:00.000Z",
      model: "onnx-community/whisper-tiny",
      source: "huggingface-local",
      segments: [{ id: "subtitle-1", startMs: 0, endMs: 1_000, text: "Old subtitles." }],
    });
    const idleCallbacks: IdleRequestCallback[] = [];
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    });
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", cancelIdleCallback);
    const postProcessorWarmUp = vi.fn(async () => undefined);

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={new Blob(["webm"], { type: "video/webm" })}
        hasAudio
        durationMs={2_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={store}
        transcriber={{
          transcribe: vi.fn(async () => ({
            model: "onnx-community/whisper-tiny",
            source: "huggingface-local" as const,
            segments: [{ id: "subtitle-1", startMs: 0, endMs: 2_000, text: "New subtitles." }],
          })),
        }}
        postProcessor={{
          warmUp: postProcessorWarmUp,
          process: vi.fn(async () => ({ segments: [], chapters: [] })),
        }}
      />,
    );

    await waitFor(() => expect(screen.getByText("Old subtitles.")).toBeInTheDocument());
    expect(requestIdleCallback).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: GENERATE_AND_OPTIMIZE_LABEL }));

    await waitFor(() => expect(screen.getByText("New subtitles.")).toBeInTheDocument());
    expect(cancelIdleCallback).toHaveBeenCalledWith(1);
    expect(requestIdleCallback).toHaveBeenCalledTimes(2);

    await act(async () => {
      idleCallbacks[0]?.({ didTimeout: false, timeRemaining: () => 10 });
      await flushPromises();
    });
    expect(postProcessorWarmUp).not.toHaveBeenCalled();

    await act(async () => {
      idleCallbacks[1]?.({ didTimeout: false, timeRemaining: () => 10 });
      await flushPromises();
    });
    expect(postProcessorWarmUp).toHaveBeenCalledTimes(1);
  });

  it("cancels pending idle local LLM warm-up while subtitles are generating", async () => {
    const store = createMemorySubtitleStore();
    await store.save({
      recordingId: "recording-1",
      generatedAt: "2026-05-28T00:00:00.000Z",
      model: "onnx-community/whisper-tiny",
      source: "huggingface-local",
      segments: [{ id: "subtitle-1", startMs: 0, endMs: 1_000, text: "Old subtitles." }],
    });
    const idleCallbacks: IdleRequestCallback[] = [];
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    });
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", cancelIdleCallback);
    const postProcessorWarmUp = vi.fn(async () => undefined);
    const generatedTrack = createDeferred<SubtitleTrackDraft>();

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={new Blob(["webm"], { type: "video/webm" })}
        hasAudio
        durationMs={2_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={store}
        transcriber={{
          transcribe: vi.fn(() => generatedTrack.promise),
        }}
        postProcessor={{
          warmUp: postProcessorWarmUp,
          process: vi.fn(async () => ({ segments: [], chapters: [] })),
        }}
      />,
    );

    await waitFor(() => expect(screen.getByText("Old subtitles.")).toBeInTheDocument());
    expect(requestIdleCallback).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: GENERATE_AND_OPTIMIZE_LABEL }));

    await waitFor(() => expect(cancelIdleCallback).toHaveBeenCalledWith(1));
    await act(async () => {
      idleCallbacks[0]?.({ didTimeout: false, timeRemaining: () => 10 });
      await flushPromises();
    });
    expect(postProcessorWarmUp).not.toHaveBeenCalled();

    await act(async () => {
      generatedTrack.resolve({
        model: "onnx-community/whisper-tiny",
        source: "huggingface-local",
        segments: [{ id: "subtitle-1", startMs: 0, endMs: 2_000, text: "New subtitles." }],
      });
      await flushPromises();
    });
    await waitFor(() => expect(screen.getByText("New subtitles.")).toBeInTheDocument());
    expect(requestIdleCallback).toHaveBeenCalledTimes(2);

    await act(async () => {
      idleCallbacks[1]?.({ didTimeout: false, timeRemaining: () => 10 });
      await flushPromises();
    });
    expect(postProcessorWarmUp).toHaveBeenCalledTimes(1);
  });

  it("disposes a running local LLM warm-up before generating subtitles", async () => {
    const store = createMemorySubtitleStore();
    await store.save({
      recordingId: "recording-1",
      generatedAt: "2026-05-28T00:00:00.000Z",
      model: "onnx-community/whisper-tiny",
      source: "huggingface-local",
      segments: [{ id: "subtitle-1", startMs: 0, endMs: 1_000, text: "Old subtitles." }],
    });
    const idleCallbacks: IdleRequestCallback[] = [];
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn((callback: IdleRequestCallback) => {
        idleCallbacks.push(callback);
        return idleCallbacks.length;
      }),
    );
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    const warmUpDeferred = createDeferred<void>();
    const events: string[] = [];
    const dispose = vi.fn(() => {
      events.push("dispose");
    });
    const transcribe = vi.fn(async () => {
      events.push("transcribe");
      return {
        model: "onnx-community/whisper-tiny",
        source: "huggingface-local" as const,
        segments: [{ id: "subtitle-1", startMs: 0, endMs: 2_000, text: "New subtitles." }],
      };
    });

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={new Blob(["webm"], { type: "video/webm" })}
        hasAudio
        durationMs={2_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={store}
        transcriber={{ transcribe }}
        postProcessor={{
          warmUp: vi.fn(() => {
            events.push("warmUp");
            return warmUpDeferred.promise;
          }),
          process: vi.fn(async () => ({ segments: [], chapters: [] })),
          dispose,
        }}
      />,
    );

    await waitFor(() => expect(screen.getByText("Old subtitles.")).toBeInTheDocument());
    await act(async () => {
      idleCallbacks[0]?.({ didTimeout: false, timeRemaining: () => 10 });
      await flushPromises();
    });

    fireEvent.click(screen.getByRole("button", { name: GENERATE_AND_OPTIMIZE_LABEL }));

    await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    expect(events).toEqual(["warmUp", "dispose", "transcribe"]);

    await act(async () => {
      warmUpDeferred.resolve();
      await flushPromises();
    });
  });

  it("keeps a running local LLM warm-up instance when starting post-processing", async () => {
    const store = createMemorySubtitleStore();
    await store.save({
      recordingId: "recording-1",
      generatedAt: "2026-05-28T00:00:00.000Z",
      model: "onnx-community/whisper-tiny",
      source: "huggingface-local",
      segments: [{ id: "subtitle-1", startMs: 0, endMs: 1_000, text: "use state hook" }],
    });
    const idleCallbacks: IdleRequestCallback[] = [];
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn((callback: IdleRequestCallback) => {
        idleCallbacks.push(callback);
        return idleCallbacks.length;
      }),
    );
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    const warmUpDeferred = createDeferred<void>();
    const events: string[] = [];
    const dispose = vi.fn(() => {
      events.push("dispose");
    });
    const process = vi.fn(async () => {
      events.push("process");
      return {
        segments: [{ id: "subtitle-1", text: "useState hook" }],
        chapters: [{ title: "状态设计", startMs: 0, endMs: 1_000 }],
      };
    });

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={null}
        hasAudio
        durationMs={1_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={store}
        transcriber={{
          transcribe: vi.fn(async () => ({
            model: "onnx-community/whisper-tiny",
            source: "huggingface-local" as const,
            segments: [],
          })),
        }}
        postProcessor={{
          warmUp: vi.fn(() => {
            events.push("warmUp");
            return warmUpDeferred.promise;
          }),
          process,
          dispose,
        }}
      />,
    );

    await waitFor(() => expect(screen.getByText("use state hook")).toBeInTheDocument());
    await act(async () => {
      idleCallbacks[0]?.({ didTimeout: false, timeRemaining: () => 10 });
      await flushPromises();
    });

    fireEvent.click(screen.getByRole("button", { name: OPTIMIZE_SUBTITLES_LABEL }));

    await waitFor(() => expect(process).toHaveBeenCalledTimes(1));
    expect(events).toEqual(["warmUp", "process"]);
    expect(dispose).not.toHaveBeenCalled();

    await act(async () => {
      warmUpDeferred.resolve();
      await flushPromises();
    });
  });

  it("warms up a replacement local LLM post-processor instance for the same recording", async () => {
    const store = createMemorySubtitleStore();
    await store.save({
      recordingId: "recording-1",
      generatedAt: "2026-05-28T00:00:00.000Z",
      model: "onnx-community/whisper-tiny",
      source: "huggingface-local",
      segments: [{ id: "subtitle-1", startMs: 0, endMs: 1_000, text: "Saved subtitles." }],
    });
    const idleCallbacks: IdleRequestCallback[] = [];
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    });
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    const firstWarmUp = vi.fn(async () => undefined);
    const secondWarmUp = vi.fn(async () => undefined);
    const createPostProcessor = (warmUp: () => Promise<void>): SubtitlePostProcessor => ({
      warmUp,
      process: vi.fn(async () => ({ segments: [], chapters: [] })),
      dispose: vi.fn(),
    });

    const { rerender } = render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={new Blob(["webm"], { type: "video/webm" })}
        hasAudio
        durationMs={1_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={store}
        transcriber={{
          transcribe: vi.fn(async () => ({
            model: "onnx-community/whisper-tiny",
            source: "huggingface-local" as const,
            segments: [],
          })),
        }}
        postProcessor={createPostProcessor(firstWarmUp)}
      />,
    );

    await waitFor(() => expect(screen.getByText("Saved subtitles.")).toBeInTheDocument());
    expect(requestIdleCallback).toHaveBeenCalledTimes(1);

    rerender(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={new Blob(["webm"], { type: "video/webm" })}
        hasAudio
        durationMs={1_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={store}
        transcriber={{
          transcribe: vi.fn(async () => ({
            model: "onnx-community/whisper-tiny",
            source: "huggingface-local" as const,
            segments: [],
          })),
        }}
        postProcessor={createPostProcessor(secondWarmUp)}
      />,
    );

    await act(async () => {
      await flushPromises();
    });
    await waitFor(() => expect(requestIdleCallback.mock.calls.length).toBeGreaterThanOrEqual(2));
    await act(async () => {
      for (const idleCallback of idleCallbacks) {
        idleCallback({ didTimeout: false, timeRemaining: () => 10 });
      }
      await flushPromises();
    });

    expect(firstWarmUp).not.toHaveBeenCalled();
    await waitFor(() => expect(secondWarmUp).toHaveBeenCalledTimes(1));
  });

  it("warms up a new transcriber identity immediately", async () => {
    const mediaBlob = new Blob(["webm"], { type: "video/webm" });
    const firstWarmUp = vi.fn(async () => undefined);
    const secondWarmUp = vi.fn(async () => undefined);
    const createTranscriber = (warmUp: () => Promise<void>): SubtitleTranscriber => ({
      warmUp,
      transcribe: vi.fn(async () => ({
        model: "onnx-community/whisper-tiny",
        source: "huggingface-local" as const,
        segments: [],
      })),
    });

    const { rerender } = render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={mediaBlob}
        hasAudio
        durationMs={3_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={createMemorySubtitleStore()}
        transcriber={createTranscriber(firstWarmUp)}
      />,
    );
    await waitFor(() => expect(firstWarmUp).toHaveBeenCalledTimes(1));

    rerender(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={mediaBlob}
        hasAudio
        durationMs={3_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={createMemorySubtitleStore()}
        transcriber={createTranscriber(secondWarmUp)}
      />,
    );
    await act(async () => {
      await flushPromises();
    });

    expect(firstWarmUp).toHaveBeenCalledTimes(1);
    expect(secondWarmUp).toHaveBeenCalledTimes(1);
  });
});
