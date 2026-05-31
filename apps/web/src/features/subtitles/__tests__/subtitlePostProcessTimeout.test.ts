import { describe, expect, it } from "vitest";
import { resolveEffectivePostProcessTimeoutMs } from "../subtitlePostProcessTimeout";
import { DEFAULT_EXTERNAL_REQUEST_TIMEOUT_MS } from "../externalLlmSubtitlePostProcessor";

describe("resolveEffectivePostProcessTimeoutMs", () => {
  it("keeps the local budget unchanged when no external LLM is configured", () => {
    expect(resolveEffectivePostProcessTimeoutMs(60_000, false)).toBe(60_000);
  });

  it("adds the external fail-fast budget on top of the full local budget when configured", () => {
    // Local model keeps its complete 60s after the external attempt bails at its
    // own budget, instead of running inside (and being starved by) the 60s.
    expect(resolveEffectivePostProcessTimeoutMs(60_000, true)).toBe(
      60_000 + DEFAULT_EXTERNAL_REQUEST_TIMEOUT_MS,
    );
  });

  it("leaves a disabled (non-positive / non-finite) budget untouched", () => {
    expect(resolveEffectivePostProcessTimeoutMs(0, true)).toBe(0);
    expect(resolveEffectivePostProcessTimeoutMs(Number.POSITIVE_INFINITY, true)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});
