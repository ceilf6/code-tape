import { describe, expect, it, vi } from "vitest";
import {
  ExternalLlmTimeoutError,
  createExternalLlmSubtitlePostProcessor,
} from "../externalLlmSubtitlePostProcessor";
import type { ExternalLlmConfig } from "../subtitleLlmConfig";
import type { SubtitleTrack } from "../types";

type FetchMock = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const track: SubtitleTrack = {
  recordingId: "rec-1",
  generatedAt: "2026-05-31T00:00:00.000Z",
  model: "whisper-tiny",
  source: "huggingface-local",
  segments: [
    { id: "subtitle-1", startMs: 0, endMs: 1000, text: "这里用 use state 维护 count" },
    { id: "subtitle-2", startMs: 1000, endMs: 2000, text: "然后 set count 触发 render" },
  ],
};

const correctionJson = JSON.stringify({
  segments: [{ id: "subtitle-1", text: "这里用 useState 维护 count" }],
  chapters: [{ title: "状态设计", startMs: 0, endMs: 1000 }],
});

function openAiResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function anthropicResponse(content: string) {
  return new Response(JSON.stringify({ content: [{ type: "text", text: content }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const openAiConfig: ExternalLlmConfig = {
  provider: "openai",
  baseURL: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "gpt-4o-mini",
};

const anthropicConfig: ExternalLlmConfig = {
  provider: "anthropic",
  baseURL: "https://api.anthropic.com/v1",
  apiKey: "ak-test",
  model: "claude-haiku",
};

describe("createExternalLlmSubtitlePostProcessor", () => {
  it("posts an OpenAI chat completion and parses the correction", async () => {
    const fetchImpl = vi.fn<FetchMock>(async () => openAiResponse(correctionJson));
    const processor = createExternalLlmSubtitlePostProcessor({ config: openAiConfig, fetchImpl });

    const result = await processor.process({ track });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].role).toBe("system");
    expect(result.segments).toEqual([{ id: "subtitle-1", text: "这里用 useState 维护 count" }]);
    expect(result.chapters).toEqual([{ title: "状态设计", startMs: 0, endMs: 1000 }]);
  });

  it("posts an Anthropic message with system hoisted and x-api-key header", async () => {
    const fetchImpl = vi.fn<FetchMock>(async () => anthropicResponse(correctionJson));
    const processor = createExternalLlmSubtitlePostProcessor({ config: anthropicConfig, fetchImpl });

    const result = await processor.process({ track });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("ak-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    // Required CORS opt-in for browser direct access to the Anthropic API.
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(typeof body.system).toBe("string");
    expect(body.system.length).toBeGreaterThan(0);
    expect(body.messages.every((m: { role: string }) => m.role !== "system")).toBe(true);
    expect(result.segments).toEqual([{ id: "subtitle-1", text: "这里用 useState 维护 count" }]);
  });

  it("does not leak the response body into the HTTP error", async () => {
    const fetchImpl = vi.fn<FetchMock>(
      async () =>
        new Response('{"error":"invalid x-api-key: sk-leaked-secret"}', {
          status: 401,
          statusText: "Unauthorized",
        }),
    );
    const processor = createExternalLlmSubtitlePostProcessor({ config: openAiConfig, fetchImpl });
    await expect(processor.process({ track })).rejects.toThrow(/HTTP 401/);
    await processor.process({ track }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("sk-leaked-secret");
      expect(message).not.toContain("invalid x-api-key");
    });
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = vi.fn<FetchMock>(async () => new Response("nope", { status: 401 }));
    const processor = createExternalLlmSubtitlePostProcessor({ config: openAiConfig, fetchImpl });
    await expect(processor.process({ track })).rejects.toThrow(/HTTP 401/);
  });

  it("throws when the response body is not valid JSON", async () => {
    const fetchImpl = vi.fn<FetchMock>(
      async () =>
        new Response("<html>oops</html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    const processor = createExternalLlmSubtitlePostProcessor({ config: openAiConfig, fetchImpl });
    await expect(processor.process({ track })).rejects.toThrow(/合法 JSON/);
  });

  it("propagates abort without wrapping it as a request failure", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<FetchMock>(async (_url, init) => {
      init?.signal?.throwIfAborted?.();
      throw new DOMException("aborted", "AbortError");
    });
    const processor = createExternalLlmSubtitlePostProcessor({ config: openAiConfig, fetchImpl });
    controller.abort();
    await expect(processor.process({ track, signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("forwards the abort signal to fetch", async () => {
    const fetchImpl = vi.fn<FetchMock>(async () => openAiResponse(correctionJson));
    const processor = createExternalLlmSubtitlePostProcessor({ config: openAiConfig, fetchImpl });
    const controller = new AbortController();
    await processor.process({ track, signal: controller.signal });
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws ExternalLlmTimeoutError (not AbortError) when its own request timeout fires", async () => {
    // fetch hangs until its signal aborts; the internal timeout should trip first
    // and surface as a recoverable timeout so the fallback wrapper runs the local model.
    const fetchImpl = vi.fn<FetchMock>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const processor = createExternalLlmSubtitlePostProcessor({
      config: openAiConfig,
      fetchImpl,
      requestTimeoutMs: 10,
    });
    await expect(processor.process({ track })).rejects.toBeInstanceOf(ExternalLlmTimeoutError);
  });

  it("propagates a caller abort as AbortError even with a request timeout set", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<FetchMock>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const processor = createExternalLlmSubtitlePostProcessor({
      config: openAiConfig,
      fetchImpl,
      requestTimeoutMs: 10_000,
    });
    const promise = processor.process({ track, signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses a single overall budget across chunks for tracks over the chunk size", async () => {
    // >60 segments => multiple chunks. The whole external attempt shares ONE
    // fail-fast budget, so a hung endpoint trips exactly one timeout (not one per
    // chunk) and the panel's additive budget keeps the local fallback's full slice.
    const bigTrack: SubtitleTrack = {
      ...track,
      segments: Array.from({ length: 130 }, (_, index) => ({
        id: `subtitle-${index + 1}`,
        startMs: index * 1000,
        endMs: index * 1000 + 1000,
        text: `第 ${index + 1} 段`,
      })),
    };
    let fetchCalls = 0;
    const fetchImpl = vi.fn<FetchMock>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          fetchCalls += 1;
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const processor = createExternalLlmSubtitlePostProcessor({
      config: openAiConfig,
      fetchImpl,
      requestTimeoutMs: 20,
    });
    await expect(processor.process({ track: bigTrack })).rejects.toBeInstanceOf(ExternalLlmTimeoutError);
    // The shared budget aborts the in-flight chunk; we never fan out to a fresh
    // per-chunk timeout, so at most one request is outstanding when it trips.
    expect(fetchCalls).toBeLessThanOrEqual(3);
  });
});
