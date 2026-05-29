import { DEFAULT_POSTPROCESSOR_MODEL } from "./subtitlePostProcessorConfig";
import { requestStaleTransformersImportRecovery } from "./transformersLoader";
import type {
  SubtitleCorrectionResult,
  SubtitlePostProcessor,
  SubtitlePostProcessorContext,
  SubtitlePostProcessorMetric,
  SubtitleTrack,
} from "./types";

type SerializablePostProcessorInput = {
  track: SubtitleTrack;
  context?: SubtitlePostProcessorContext;
};

type WorkerRequest =
  | {
      id: string;
      type: "warmUp";
      model: string;
    }
  | {
      id: string;
      type: "process";
      model: string;
      input: SerializablePostProcessorInput;
    }
  | {
      id: string;
      type: "abort";
    };

type WorkerCommand =
  | {
      type: "warmUp";
    }
  | {
      type: "process";
      input: SerializablePostProcessorInput;
    };

type WorkerResponse =
  | {
      id: string;
      type: "success";
      result?: SubtitleCorrectionResult;
      metrics?: WorkerResponseMetrics;
    }
  | {
      id: string;
      type: "error";
      error: SerializedWorkerError;
      metrics?: WorkerResponseMetrics;
    };

type SerializedWorkerError = {
  name: string;
  message: string;
};

type WorkerResponseMetrics = {
  workerRequestDurationMs: number;
};

type PendingRequest = {
  resolve(result: SubtitleCorrectionResult | undefined, metrics?: WorkerResponseMetrics): void;
  reject(error: unknown, metrics?: WorkerResponseMetrics): void;
};

export type WorkerBackedSubtitlePostProcessorOptions = {
  model?: string;
  workerFactory?: () => Worker;
  onMetric?: (metric: SubtitlePostProcessorMetric) => void;
};

export function createWorkerBackedHuggingFaceSubtitlePostProcessor(
  options: WorkerBackedSubtitlePostProcessorOptions = {},
): SubtitlePostProcessor {
  const model = options.model ?? DEFAULT_POSTPROCESSOR_MODEL;
  const pendingRequests = new Map<string, PendingRequest>();
  let worker: Worker | null = null;
  let workerPromise: Promise<Worker> | null = null;
  let nextRequestId = 0;
  let workerVersion = 0;

  const ensureWorker = () => {
    if (worker) return Promise.resolve(worker);
    if (!workerPromise) {
      const loadingVersion = workerVersion;
      workerPromise = loadWorker(options.workerFactory)
        .then((loadedWorker) => {
          if (loadingVersion !== workerVersion) {
            loadedWorker.terminate();
            throw createAbortError();
          }
          worker = loadedWorker;
          worker.addEventListener("message", handleWorkerMessage);
          worker.addEventListener("error", handleWorkerError);
          worker.addEventListener("messageerror", handleWorkerError);
          return worker;
        })
        .catch((error: unknown) => {
          if (loadingVersion === workerVersion) {
            workerPromise = null;
          }
          throw error;
        });
    }
    return workerPromise;
  };

  const postRequest = async (
    request: WorkerCommand,
    signal?: AbortSignal,
  ): Promise<SubtitleCorrectionResult | undefined> => {
    if (signal?.aborted) throw createAbortError();
    const startedAt = performance.now();
    let activeWorker: Worker;
    let workerLoadDurationMs: number;
    try {
      activeWorker = await ensureWorker();
      workerLoadDurationMs = performance.now() - startedAt;
      if (activeWorker !== worker) throw createAbortError();
      if (signal?.aborted) throw createAbortError();
    } catch (error) {
      const failedLoadDurationMs = performance.now() - startedAt;
      emitMetric({
        phase: request.type,
        status: isAbortError(error) ? "aborted" : "error",
        model,
        workerLoadDurationMs: failedLoadDurationMs,
        workerRequestDurationMs: 0,
        totalDurationMs: failedLoadDurationMs,
      });
      throw error;
    }
    const id = `subtitle-postprocess-${nextRequestId}`;
    nextRequestId += 1;
    const message = { ...request, id, model } as WorkerRequest;
    const requestPostedAt = performance.now();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        pendingRequests.delete(id);
        signal?.removeEventListener("abort", onAbort);
      };
      const emitRequestMetric = (
        status: SubtitlePostProcessorMetric["status"],
        metrics?: WorkerResponseMetrics,
      ) => {
        emitMetric({
          phase: request.type,
          status,
          model,
          workerLoadDurationMs,
          workerRequestDurationMs:
            metrics?.workerRequestDurationMs ?? performance.now() - requestPostedAt,
          totalDurationMs: performance.now() - startedAt,
        });
      };
      const onAbort = () => {
        const abortError = createAbortError();
        const pending = pendingRequests.get(id);
        pending?.reject(abortError);
        activeWorker.postMessage({ id, type: "abort" } satisfies WorkerRequest);
        terminateWorker(abortError);
      };
      pendingRequests.set(id, {
        resolve(result, metrics) {
          emitRequestMetric("success", metrics);
          cleanup();
          resolve(result);
        },
        reject(error, metrics) {
          emitRequestMetric(isAbortError(error) ? "aborted" : "error", metrics);
          cleanup();
          reject(error);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      activeWorker.postMessage(message);
    });
  };

  const terminateWorker = (error: unknown) => {
    workerVersion += 1;
    // Aborting local LLM inference is deliberately coarse-grained: terminate the
    // worker so CPU-bound/WASM generation cannot keep running behind playback.
    for (const pending of pendingRequests.values()) {
      pending.reject(error);
    }
    pendingRequests.clear();
    worker?.terminate();
    worker = null;
    workerPromise = null;
  };

  const emitMetric = (metric: SubtitlePostProcessorMetric) => {
    try {
      options.onMetric?.(metric);
    } catch {
      // Metrics are diagnostic only; they must never break subtitle recovery.
    }
  };

  function handleWorkerMessage(event: MessageEvent<WorkerResponse>) {
    const response = event.data;
    const pending = pendingRequests.get(response.id);
    if (!pending) return;
    if (response.type === "success") {
      pending.resolve(response.result, response.metrics);
      return;
    }
    const error = deserializeWorkerError(response.error);
    requestStaleTransformersImportRecovery(error);
    pending.reject(error, response.metrics);
  }

  function handleWorkerError(event: Event) {
    const message = getWorkerEventMessage(event);
    const error = new Error(message);
    requestStaleTransformersImportRecovery(error);
    terminateWorker(error);
  }

  return {
    async warmUp() {
      await postRequest({ type: "warmUp" });
    },
    async process(input) {
      const result = await postRequest(
        {
          type: "process",
          input: {
            track: input.track,
            context: input.context,
          },
        },
        input.signal,
      );
      if (!result) throw new Error("字幕 LLM worker 未返回纠错结果");
      return result;
    },
    dispose() {
      terminateWorker(createAbortError());
    },
  };
}

async function loadWorker(workerFactory?: () => Worker): Promise<Worker> {
  if (workerFactory) return workerFactory();
  const workerModule = await import("./subtitlePostProcessorWorker?worker");
  return new workerModule.default();
}

function deserializeWorkerError(error: SerializedWorkerError): Error {
  const deserialized = new Error(error.message);
  deserialized.name = error.name || "Error";
  return deserialized;
}

function createAbortError(): DOMException {
  return new DOMException("字幕纠错已取消", "AbortError");
}

function readWorkerEventMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (!value || typeof value !== "object" || !("message" in value)) return undefined;
  const message = (value as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

function getWorkerEventMessage(event: Event): string {
  return (
    readWorkerEventMessage((event as { message?: unknown }).message) ??
    readWorkerEventMessage((event as { error?: unknown }).error) ??
    readWorkerEventMessage((event as { data?: unknown }).data) ??
    "字幕 LLM worker 执行失败"
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}
