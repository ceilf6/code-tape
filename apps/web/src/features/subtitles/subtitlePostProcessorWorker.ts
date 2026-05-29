import { createHuggingFaceSubtitlePostProcessor } from "./subtitlePostProcessor";
import type {
  SubtitleCorrectionResult,
  SubtitlePostProcessor,
  SubtitlePostProcessorContext,
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

const processorsByModel = new Map<string, SubtitlePostProcessor>();
const abortControllersByRequest = new Map<string, AbortController>();

globalThis.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  void handleRequest(event.data);
});

async function handleRequest(request: WorkerRequest): Promise<void> {
  if (request.type === "abort") {
    abortControllersByRequest.get(request.id)?.abort();
    abortControllersByRequest.delete(request.id);
    return;
  }

  const abortController = new AbortController();
  abortControllersByRequest.set(request.id, abortController);
  const requestStartedAt = performance.now();
  try {
    const postProcessor = getPostProcessor(request.model);
    if (request.type === "warmUp") {
      await postProcessor.warmUp?.();
      postWorkerResponse({
        id: request.id,
        type: "success",
        metrics: buildWorkerMetrics(requestStartedAt),
      });
      return;
    }

    const result = await postProcessor.process({
      ...request.input,
      signal: abortController.signal,
    });
    postWorkerResponse({
      id: request.id,
      type: "success",
      result,
      metrics: buildWorkerMetrics(requestStartedAt),
    });
  } catch (error) {
    postWorkerResponse({
      id: request.id,
      type: "error",
      error: serializeWorkerError(error),
      metrics: buildWorkerMetrics(requestStartedAt),
    });
  } finally {
    abortControllersByRequest.delete(request.id);
  }
}

function getPostProcessor(model: string): SubtitlePostProcessor {
  const existing = processorsByModel.get(model);
  if (existing) return existing;
  const postProcessor = createHuggingFaceSubtitlePostProcessor({ model });
  processorsByModel.set(model, postProcessor);
  return postProcessor;
}

function postWorkerResponse(response: WorkerResponse): void {
  globalThis.postMessage(response);
}

function buildWorkerMetrics(requestStartedAt: number): WorkerResponseMetrics {
  return {
    workerRequestDurationMs: performance.now() - requestStartedAt,
  };
}

function serializeWorkerError(error: unknown): SerializedWorkerError {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message,
    };
  }
  return {
    name: "Error",
    message: String(error),
  };
}
