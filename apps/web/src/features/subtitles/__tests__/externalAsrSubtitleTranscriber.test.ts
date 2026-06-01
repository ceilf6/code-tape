import { afterEach, describe, expect, it, vi } from "vitest";
import { createExternalAsrSubtitleTranscriber } from "../externalAsrSubtitleTranscriber";
import type { ExternalAsrConfig } from "../subtitleAsrConfig";

const config: ExternalAsrConfig = {
  provider: "openai-compatible",
  baseURL: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "gpt-4o-mini-transcribe",
  language: "zh",
};

describe("createExternalAsrSubtitleTranscriber", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("requests OpenAI-compatible audio transcriptions with the recording blob", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      Response.json({
        language: "zh",
        segments: [
          { start: 0.25, end: 1.5, text: "  use state hook  " },
          { start: 1.5, end: 3, text: "render result" },
        ],
      }),
    );
    const mediaBlob = new Blob(["webm"], { type: "video/webm" });
    const transcriber = createExternalAsrSubtitleTranscriber({ config, fetchImpl });

    await expect(transcriber.transcribe({ mediaBlob, durationMs: 4_000 })).resolves.toEqual({
      model: "gpt-4o-mini-transcribe",
      source: "external-asr",
      language: "zh",
      segments: [
        { id: "subtitle-1", startMs: 250, endMs: 1_500, text: "use state hook" },
        { id: "subtitle-2", startMs: 1_500, endMs: 3_000, text: "render result" },
      ],
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example.com/v1/audio/transcriptions",
      expect.objectContaining({
        method: "POST",
        headers: { authorization: "Bearer sk-test" },
        body: expect.any(FormData),
      }),
    );
    const body = vi.mocked(fetchImpl).mock.calls[0]?.[1]?.body as FormData;
    expect(body.get("file")).toBeInstanceOf(File);
    expect(body.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(body.get("language")).toBe("zh");
    expect(body.get("response_format")).toBe("verbose_json");
  });

  it("falls back to one full-duration segment when the endpoint only returns text", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => Response.json({ text: "plain transcript" }));
    const transcriber = createExternalAsrSubtitleTranscriber({
      config: { ...config, language: "" },
      fetchImpl,
    });

    await expect(
      transcriber.transcribe({
        mediaBlob: new Blob(["webm"], { type: "video/webm" }),
        durationMs: 2_500,
      }),
    ).resolves.toMatchObject({
      language: "zh",
      segments: [{ id: "subtitle-1", startMs: 0, endMs: 2_500, text: "plain transcript" }],
    });

    const body = vi.mocked(fetchImpl).mock.calls[0]?.[1]?.body as FormData;
    expect(body.has("language")).toBe(false);
  });

  it("surfaces external ASR HTTP failures without leaking the response body", async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async () => new Response("secret echo", { status: 401, statusText: "Unauthorized" }),
    );
    const transcriber = createExternalAsrSubtitleTranscriber({ config, fetchImpl });

    await expect(
      transcriber.transcribe({
        mediaBlob: new Blob(["webm"], { type: "video/webm" }),
        durationMs: 1_000,
      }),
    ).rejects.toThrow("外部 ASR 返回 HTTP 401 Unauthorized");
  });

  it("times out a hanging external ASR request as a fallback-eligible failure", async () => {
    vi.useFakeTimers();
    const fetchImpl: typeof fetch = vi.fn(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const transcriber = createExternalAsrSubtitleTranscriber({
      config,
      fetchImpl,
      requestTimeoutMs: 1_000,
    });

    const result = transcriber.transcribe({
      mediaBlob: new Blob(["webm"], { type: "video/webm" }),
      durationMs: 1_000,
    });
    const assertion = expect(result).rejects.toThrow("外部 ASR 请求超时");
    await vi.advanceTimersByTimeAsync(1_000);

    await assertion;
  });
});
