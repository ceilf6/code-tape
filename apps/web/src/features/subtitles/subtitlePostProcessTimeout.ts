import { DEFAULT_EXTERNAL_REQUEST_TIMEOUT_MS } from "./externalLlmSubtitlePostProcessor";

// When an external LLM is configured, the global post-process budget is the
// local model's full budget PLUS the external request's fail-fast budget. This
// guarantees the local fallback keeps its complete original budget after the
// external attempt bails — instead of running inside (and being starved by) it.
export function resolveEffectivePostProcessTimeoutMs(
  localTimeoutMs: number,
  externalConfigured: boolean,
): number {
  if (!externalConfigured) return localTimeoutMs;
  if (!Number.isFinite(localTimeoutMs) || localTimeoutMs <= 0) return localTimeoutMs;
  return localTimeoutMs + DEFAULT_EXTERNAL_REQUEST_TIMEOUT_MS;
}
