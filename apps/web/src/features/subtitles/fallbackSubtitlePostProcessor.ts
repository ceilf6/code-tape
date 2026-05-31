import type { SubtitleCorrectionResult, SubtitlePostProcessor, SubtitlePostProcessorInput } from "./types";

export type FallbackSubtitlePostProcessorOptions = {
  onFallback?: (error: unknown) => void;
};

// Wraps a primary post-processor (external LLM) with a fallback (local model).
// If the primary fails for any reason OTHER than user cancellation, the fallback
// runs. User aborts propagate unchanged so cancelling does not silently re-run
// the slower local model.
export function createFallbackSubtitlePostProcessor(
  primary: SubtitlePostProcessor,
  fallback: SubtitlePostProcessor,
  options: FallbackSubtitlePostProcessorOptions = {},
): SubtitlePostProcessor {
  return {
    async warmUp() {
      // Only the local fallback needs warm-up (model download/init). The external
      // HTTP backend has no warm-up and pre-pinging it would waste tokens.
      await fallback.warmUp?.();
    },
    async process(input: SubtitlePostProcessorInput): Promise<SubtitleCorrectionResult> {
      try {
        return await primary.process(input);
      } catch (error) {
        // Genuine user/global cancellation rethrows; any other failure — including
        // the external backend's own request timeout (ExternalLlmTimeoutError, which
        // is NOT an AbortError) — falls back to the local model. The local model
        // still runs because the external timeout uses its own controller, leaving
        // the caller's signal live.
        if (isAbortError(error) || input.signal?.aborted) throw error;
        options.onFallback?.(error);
        return fallback.process(input);
      }
    },
    dispose() {
      primary.dispose?.();
      fallback.dispose?.();
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}
