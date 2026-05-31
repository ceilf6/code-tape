import type { ExternalLlmConfig } from "./subtitleLlmConfig";
import {
  POSTPROCESSOR_CHUNK_SEGMENTS,
  buildSubtitlePostProcessorMessages,
  chunkSubtitleTrack,
  constrainCorrectionToTrack,
  extractSubtitleCorrectionResult,
  isRecoverableJsonOutputError,
  recoverSubtitleCorrectionResult,
  type SubtitlePostProcessorMessage,
} from "./subtitlePostProcessorShared";
import type { SubtitleCorrectionResult, SubtitlePostProcessor, SubtitleTrack } from "./types";

const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MAX_TOKENS = 2_048;
const ABORT_MESSAGE = "字幕纠错已取消";
// External request gets its own fail-fast budget via its own AbortController.
// The panel ADDS this on top of the local model's full budget (see
// resolvePostProcessTimeoutMs) so that when the external endpoint hangs, the
// local fallback still gets its complete original budget — never a leftover sliver.
export const DEFAULT_EXTERNAL_REQUEST_TIMEOUT_MS = 30_000;

// Thrown when the external request exceeds its own timeout (not a user cancel).
// The fallback wrapper treats this as a recoverable failure and runs the local
// model, unlike a genuine user/global AbortError which it rethrows.
export class ExternalLlmTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`外部 LLM 请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    this.name = "ExternalLlmTimeoutError";
  }
}

// Stronger system prompt for capable external models: the local fine-tuned model
// is tiny, so its prompt is terse. External models can do richer term correction
// and chaptering for the code-explanation scenario, while still emitting the same
// {segments, chapters} JSON contract so all downstream validation is reused.
const EXTERNAL_SYSTEM_CONTENT = [
  "你是 code-tape 的资深前端 / 代码讲解字幕编辑。输入是一段录制代码讲解的 ASR 字幕。",
  "任务一（纠错）：修正 ASR 听写错误，重点是前端与代码术语——变量名、函数名、组件名、框架/库名（如 React、useState、TypeScript）、包名、英文缩写。保持讲解原意，不要改写语气或扩写。",
  "任务二（章节）：根据字幕内容和时间戳，把讲解切分为有意义的章节跳转点，标题简短面向回放导航（如「问题分析」「状态设计」「代码实现」「调试验证」）。",
  "inputSegments 是带 id/startMs/endMs/text 的原始字幕。",
  "只输出一个 JSON 对象，不要 Markdown、不要代码围栏、不要任何解释。",
  "segments 只包含你改动过的字幕，每项只含 id 和 text；未改动的不要返回。",
  "chapters 总是数组（无法可靠分段时返回空数组），每项含 title、startMs，可含 endMs；startMs 必须落在字幕时间范围内。",
  '输出形如：{"segments":[{"id":"subtitle-1","text":"这里用 useState 维护 count"}],"chapters":[{"title":"状态设计","startMs":0,"endMs":1000}]}',
].join("\n");

export type ExternalLlmSubtitlePostProcessorOptions = {
  config: ExternalLlmConfig;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

export function createExternalLlmSubtitlePostProcessor(
  options: ExternalLlmSubtitlePostProcessorOptions,
): SubtitlePostProcessor {
  const { config } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_EXTERNAL_REQUEST_TIMEOUT_MS;

  return {
    async process(input) {
      throwIfAborted(input.signal);
      // One overall fail-fast budget for the WHOLE external attempt (all chunks
      // combined), so the external path never consumes more than requestTimeoutMs
      // total — regardless of chunk count. This keeps the panel's additive budget
      // (local full budget + one external budget) exact, leaving the local
      // fallback its complete budget after the external attempt bails.
      const attempt = createExternalAttemptSignal(input.signal, requestTimeoutMs);
      try {
        if (input.track.segments.length <= POSTPROCESSOR_CHUNK_SEGMENTS) {
          return await processChunk(input.track, input, config, fetchImpl, attempt.signal);
        }
        const chunks = chunkSubtitleTrack(input.track, POSTPROCESSOR_CHUNK_SEGMENTS);
        const merged: SubtitleCorrectionResult = { segments: [], chapters: [] };
        for (const chunk of chunks) {
          const result = await processChunk(chunk, input, config, fetchImpl, attempt.signal);
          merged.segments.push(...result.segments);
          merged.chapters?.push(...(result.chapters ?? []));
        }
        return constrainCorrectionToTrack(merged, input.track);
      } catch (error) {
        // The attempt's own deadline aborted us (not a user cancel): surface a
        // recoverable timeout so the fallback wrapper runs the local model.
        if (attempt.didTimeout && !input.signal?.aborted) {
          throw new ExternalLlmTimeoutError(requestTimeoutMs);
        }
        throw error;
      } finally {
        attempt.dispose();
      }
    },
  };
}

type ExternalAttempt = {
  signal: AbortSignal;
  didTimeout: boolean;
  dispose(): void;
};

// Bridges the caller's signal with a single overall deadline for the whole
// external attempt. didTimeout distinguishes "our deadline fired" from a genuine
// caller/global cancel so the two can surface as different error types.
function createExternalAttemptSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): ExternalAttempt {
  const controller = new AbortController();
  const attempt: ExternalAttempt = {
    signal: controller.signal,
    didTimeout: false,
    dispose: () => {},
  };
  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timeoutId =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          attempt.didTimeout = true;
          controller.abort();
        }, timeoutMs)
      : null;
  attempt.dispose = () => {
    if (timeoutId !== null) clearTimeout(timeoutId);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  };
  return attempt;
}

async function processChunk(
  track: SubtitleTrack,
  input: { context?: Parameters<SubtitlePostProcessor["process"]>[0]["context"] },
  config: ExternalLlmConfig,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<SubtitleCorrectionResult> {
  const messages = buildSubtitlePostProcessorMessages(
    { track, context: input.context },
    { systemContent: EXTERNAL_SYSTEM_CONTENT },
  );
  const generatedText = await requestCompletion(messages, config, fetchImpl, signal);
  try {
    return constrainCorrectionToTrack(extractSubtitleCorrectionResult(generatedText), track);
  } catch (error) {
    if (!isRecoverableJsonOutputError(error)) throw error;
    const recovered = recoverSubtitleCorrectionResult(generatedText, track);
    if (recovered) return recovered;
    throw error;
  }
}

async function requestCompletion(
  messages: SubtitlePostProcessorMessage[],
  config: ExternalLlmConfig,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<string> {
  const request =
    config.provider === "anthropic"
      ? buildAnthropicRequest(messages, config)
      : buildOpenAiRequest(messages, config);

  let response: Response;
  try {
    response = await fetchImpl(request.url, { ...request.init, signal });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(`外部 LLM 请求失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    // Deliberately omit the response body: a misconfigured proxy/endpoint could
    // echo request headers (the API key) or subtitle/code context, and this
    // error is surfaced to logs on fallback. Status + statusText is enough to act on.
    throw new Error(`外部 LLM 返回 HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
  }
  const payload: unknown = await response.json().catch(() => {
    throw new Error("外部 LLM 响应不是合法 JSON");
  });
  const text = config.provider === "anthropic" ? readAnthropicText(payload) : readOpenAiText(payload);
  if (!text) throw new Error("外部 LLM 响应缺少文本内容");
  return text;
}

function buildOpenAiRequest(messages: SubtitlePostProcessorMessage[], config: ExternalLlmConfig) {
  return {
    url: joinUrl(config.baseURL, "chat/completions"),
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    } satisfies RequestInit,
  };
}

function buildAnthropicRequest(messages: SubtitlePostProcessorMessage[], config: ExternalLlmConfig) {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  const nonSystem = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role, content: message.content }));
  return {
    url: joinUrl(config.baseURL, "messages"),
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        // Required opt-in for calling the Anthropic API directly from a browser
        // (CORS). Without it official endpoints reject the preflight.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        system,
        messages: nonSystem,
      }),
    } satisfies RequestInit,
  };
}

function readOpenAiText(payload: unknown): string | null {
  if (!isPlainObject(payload)) return null;
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = isPlainObject(choices[0]) ? choices[0].message : null;
  if (!isPlainObject(message)) return null;
  return typeof message.content === "string" ? message.content : null;
}

function readAnthropicText(payload: unknown): string | null {
  if (!isPlainObject(payload)) return null;
  const content = payload.content;
  if (!Array.isArray(content)) return null;
  const texts = content
    .filter((block): block is { type: string; text: string } =>
      isPlainObject(block) && block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text);
  return texts.length > 0 ? texts.join("") : null;
}

function joinUrl(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException(ABORT_MESSAGE, "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
