import { describe, expect, it, vi } from "vitest";
import { createWorkerBackedHuggingFaceSubtitlePostProcessor } from "../subtitlePostProcessorWorkerClient";
import type { SubtitleCorrectionResult, SubtitleTrack } from "../types";

function makeTrack(): SubtitleTrack {
  return {
    recordingId: "recording-1",
    generatedAt: "2026-05-28T00:00:00.000Z",
    model: "onnx-community/whisper-tiny",
    source: "huggingface-local",
    language: "zh",
    segments: [
      { id: "subtitle-1", startMs: 0, endMs: 1_000, text: "use state hook" },
      { id: "subtitle-2", startMs: 1_000, endMs: 2_000, text: "render result" },
    ],
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createMockWorker() {
  const listeners = new Set<(event: MessageEvent) => void>();
  const worker = {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type !== "message" || typeof listener !== "function") return;
      listeners.add(listener as (event: MessageEvent) => void);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type !== "message" || typeof listener !== "function") return;
      listeners.delete(listener as (event: MessageEvent) => void);
    }),
    dispatch(data: unknown) {
      for (const listener of listeners) {
        listener({ data } as MessageEvent);
      }
    },
  };
  return worker;
}

describe("createWorkerBackedHuggingFaceSubtitlePostProcessor", () => {
  it("runs subtitle post-processing through a browser worker", async () => {
    const worker = createMockWorker();
    const onMetric = vi.fn();
    const workerFactory = vi.fn(() => worker as unknown as Worker);
    const postProcessor = createWorkerBackedHuggingFaceSubtitlePostProcessor({
      model: "ceilf6/test-subtitle-model",
      workerFactory,
      onMetric,
    });
    const context = { fileName: "Counter.tsx", glossary: ["useState"] };
    const result: SubtitleCorrectionResult = {
      segments: [{ id: "subtitle-1", text: "useState hook" }],
      chapters: [{ title: "状态设计", startMs: 0, endMs: 2_000 }],
    };

    const promise = postProcessor.process({ track: makeTrack(), context });
    await flushPromises();
    const request = worker.postMessage.mock.calls[0]?.[0] as { id: string; type: string };

    expect(workerFactory).toHaveBeenCalledTimes(1);
    expect(request).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        type: "process",
        model: "ceilf6/test-subtitle-model",
        input: { track: makeTrack(), context },
      }),
    );

    worker.dispatch({
      id: request.id,
      type: "success",
      result,
      metrics: { workerRequestDurationMs: 12.345 },
    });

    await expect(promise).resolves.toEqual(result);
    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "ceilf6/test-subtitle-model",
        phase: "process",
        status: "success",
        workerLoadDurationMs: expect.any(Number),
        workerRequestDurationMs: 12.345,
        totalDurationMs: expect.any(Number),
      }),
    );
    expect(JSON.stringify(onMetric.mock.calls[0]?.[0])).not.toContain("use state hook");
  });

  it("emits an error metric when worker creation fails before posting a request", async () => {
    const onMetric = vi.fn();
    const workerFactory = vi.fn(() => {
      throw new Error("worker bootstrap failed");
    });
    const postProcessor = createWorkerBackedHuggingFaceSubtitlePostProcessor({
      model: "ceilf6/test-subtitle-model",
      workerFactory,
      onMetric,
    });

    await expect(postProcessor.process({ track: makeTrack() })).rejects.toThrow("worker bootstrap failed");

    expect(workerFactory).toHaveBeenCalledTimes(1);
    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "ceilf6/test-subtitle-model",
        phase: "process",
        status: "error",
        workerLoadDurationMs: expect.any(Number),
        workerRequestDurationMs: 0,
        totalDurationMs: expect.any(Number),
      }),
    );
    expect(JSON.stringify(onMetric.mock.calls[0]?.[0])).not.toContain("use state hook");
  });

  it("terminates in-flight worker inference when the request is aborted", async () => {
    const worker = createMockWorker();
    const onMetric = vi.fn();
    const postProcessor = createWorkerBackedHuggingFaceSubtitlePostProcessor({
      workerFactory: () => worker as unknown as Worker,
      onMetric,
    });
    const abortController = new AbortController();

    const promise = postProcessor.process({
      track: makeTrack(),
      signal: abortController.signal,
    });
    await flushPromises();

    abortController.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "process",
        status: "aborted",
        workerLoadDurationMs: expect.any(Number),
        workerRequestDurationMs: expect.any(Number),
        totalDurationMs: expect.any(Number),
      }),
    );
  });

  it("treats abort as an exclusive worker reset and succeeds on the next request", async () => {
    const firstWorker = createMockWorker();
    const secondWorker = createMockWorker();
    const workerFactory = vi
      .fn()
      .mockReturnValueOnce(firstWorker as unknown as Worker)
      .mockReturnValueOnce(secondWorker as unknown as Worker);
    const postProcessor = createWorkerBackedHuggingFaceSubtitlePostProcessor({
      workerFactory,
    });
    const abortController = new AbortController();
    const result: SubtitleCorrectionResult = {
      segments: [{ id: "subtitle-1", text: "useState hook" }],
      chapters: [{ title: "状态设计", startMs: 0, endMs: 2_000 }],
    };

    const warmUpPromise = postProcessor.warmUp?.();
    await flushPromises();
    const processPromise = postProcessor.process({
      track: makeTrack(),
      signal: abortController.signal,
    });
    await flushPromises();

    abortController.abort();

    await expect(processPromise).rejects.toMatchObject({ name: "AbortError" });
    await expect(warmUpPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(firstWorker.terminate).toHaveBeenCalledTimes(1);

    const retryPromise = postProcessor.process({ track: makeTrack() });
    await flushPromises();
    const retryRequest = secondWorker.postMessage.mock.calls[0]?.[0] as {
      id: string;
      type: string;
    };

    expect(workerFactory).toHaveBeenCalledTimes(2);
    expect(retryRequest).toEqual(expect.objectContaining({ type: "process" }));

    secondWorker.dispatch({ id: retryRequest.id, type: "success", result });

    await expect(retryPromise).resolves.toEqual(result);
  });

  it("disposes pending warm-up work and recreates the worker on a later request", async () => {
    const firstWorker = createMockWorker();
    const secondWorker = createMockWorker();
    const workerFactory = vi
      .fn()
      .mockReturnValueOnce(firstWorker as unknown as Worker)
      .mockReturnValueOnce(secondWorker as unknown as Worker);
    const postProcessor = createWorkerBackedHuggingFaceSubtitlePostProcessor({
      workerFactory,
    });
    const result: SubtitleCorrectionResult = {
      segments: [{ id: "subtitle-1", text: "useState hook" }],
      chapters: [{ title: "状态设计", startMs: 0, endMs: 2_000 }],
    };

    const warmUpPromise = postProcessor.warmUp?.();
    await flushPromises();

    postProcessor.dispose?.();

    await expect(warmUpPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(firstWorker.terminate).toHaveBeenCalledTimes(1);

    const retryPromise = postProcessor.process({ track: makeTrack() });
    await flushPromises();
    const retryRequest = secondWorker.postMessage.mock.calls[0]?.[0] as {
      id: string;
      type: string;
    };

    expect(workerFactory).toHaveBeenCalledTimes(2);
    expect(retryRequest).toEqual(expect.objectContaining({ type: "process" }));

    secondWorker.dispatch({ id: retryRequest.id, type: "success", result });

    await expect(retryPromise).resolves.toEqual(result);
  });
});
