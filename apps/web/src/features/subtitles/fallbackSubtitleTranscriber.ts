import type { SubtitleTrackDraft, SubtitleTranscriber, SubtitleTranscriberInput } from "./types";

export type FallbackSubtitleTranscriberOptions = {
  onFallback?: (error: unknown) => void;
};

export function createFallbackSubtitleTranscriber(
  primary: SubtitleTranscriber,
  fallback: SubtitleTranscriber,
  options: FallbackSubtitleTranscriberOptions = {},
): SubtitleTranscriber {
  return {
    async warmUp() {
      await fallback.warmUp?.();
    },
    async transcribe(input: SubtitleTranscriberInput): Promise<SubtitleTrackDraft> {
      try {
        return await primary.transcribe(input);
      } catch (error) {
        if (isAbortError(error) || input.signal?.aborted) throw error;
        options.onFallback?.(error);
        return fallback.transcribe(input);
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
