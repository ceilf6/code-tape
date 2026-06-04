import { describe, expect, it } from "vitest";
import { resolveEffectivePostProcessTimeoutMs } from "../subtitlePostProcessTimeout";

describe("resolveEffectivePostProcessTimeoutMs", () => {
  it("keeps the local budget unchanged when no external LLM is configured", () => {
    expect(resolveEffectivePostProcessTimeoutMs(60_000, false)).toBe(60_000);
  });

  it("keeps the global budget unchanged when external LLM is configured", () => {
    expect(resolveEffectivePostProcessTimeoutMs(60_000, true)).toBe(60_000);
  });

  it("leaves a disabled (non-positive / non-finite) budget untouched", () => {
    expect(resolveEffectivePostProcessTimeoutMs(0, true)).toBe(0);
    expect(resolveEffectivePostProcessTimeoutMs(Number.POSITIVE_INFINITY, true)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});
