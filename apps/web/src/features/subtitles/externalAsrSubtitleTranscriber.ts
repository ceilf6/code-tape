import type { ExternalAsrConfig } from "./subtitleAsrConfig";
import type { SubtitleSegment, SubtitleTrackDraft, SubtitleTranscriber } from "./types";

const DEFAULT_TRANSCRIPTION_LANGUAGE = "zh";
const AUDIO_TRANSCRIPTIONS_PATH = "audio/transcriptions";
export const DEFAULT_EXTERNAL_ASR_REQUEST_TIMEOUT_MS = 30_000;

export class ExternalAsrTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`外部 ASR 请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    this.name = "ExternalAsrTimeoutError";
  }
}

type ExternalAsrResult = {
  text?: unknown;
  language?: unknown;
  segments?: unknown;
};

type ExternalAsrSegment = {
  start?: unknown;
  end?: unknown;
  text?: unknown;
};

export type ExternalAsrSubtitleTranscriberOptions = {
  config: ExternalAsrConfig;
  fetchImpl?: typeof fetch;
  prepareUploadBlob?: (mediaBlob: Blob, signal?: AbortSignal) => Promise<Blob>;
  requestTimeoutMs?: number;
};

export function createExternalAsrSubtitleTranscriber(
  options: ExternalAsrSubtitleTranscriberOptions,
): SubtitleTranscriber {
  const { config } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const prepareUploadBlob = options.prepareUploadBlob ?? prepareExternalAsrUploadBlob;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_EXTERNAL_ASR_REQUEST_TIMEOUT_MS;

  return {
    async transcribe({ mediaBlob, durationMs, signal, onStatus }): Promise<SubtitleTrackDraft> {
      if (signal?.aborted) throw new DOMException("字幕生成已取消", "AbortError");
      onStatus?.("requesting-external-asr");
      const uploadBlob = await prepareUploadBlob(mediaBlob, signal);
      if (signal?.aborted) throw new DOMException("字幕生成已取消", "AbortError");
      const body = new FormData();
      body.append("file", uploadBlob, buildAudioFileName(uploadBlob));
      body.append("model", config.model);
      body.append("response_format", resolveExternalAsrResponseFormat(config.model));
      if (config.language.trim()) body.append("language", config.language.trim());

      let response: Response;
      const attempt = createExternalAsrAttemptSignal(signal, requestTimeoutMs);
      try {
        response = await fetchImpl(joinUrl(config.baseURL, AUDIO_TRANSCRIPTIONS_PATH), {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.apiKey}`,
          },
          body,
          signal: attempt.signal,
        });
      } catch (error) {
        if (attempt.didTimeout && !signal?.aborted) throw new ExternalAsrTimeoutError(requestTimeoutMs);
        if (isAbortError(error)) throw error;
        throw new Error(
          `外部 ASR 请求失败：${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        attempt.dispose();
      }
      if (!response.ok) {
        throw new Error(
          `外部 ASR 返回 HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
        );
      }
      const payload = (await response.json().catch(() => {
        throw new Error("外部 ASR 响应不是合法 JSON");
      })) as ExternalAsrResult;

      return {
        model: config.model,
        source: "external-asr",
        language: readLanguage(payload),
        segments: normalizeExternalAsrResult(payload, durationMs),
      };
    },
  };
}

export async function prepareExternalAsrUploadBlob(
  mediaBlob: Blob,
  signal?: AbortSignal,
): Promise<Blob> {
  if (!isWebmBlob(mediaBlob)) return mediaBlob;
  if (signal?.aborted) throw new DOMException("字幕生成已取消", "AbortError");
  try {
    return await transcodeWebmToWav(mediaBlob, signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(
      `上传外部 ASR 前转换 WebM 音频失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

type ExternalAsrAttempt = {
  signal: AbortSignal;
  didTimeout: boolean;
  dispose(): void;
};

function createExternalAsrAttemptSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): ExternalAsrAttempt {
  const controller = new AbortController();
  const attempt: ExternalAsrAttempt = {
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

export function normalizeExternalAsrResult(
  result: ExternalAsrResult,
  durationMs: number,
): SubtitleSegment[] {
  const rawSegments = Array.isArray(result.segments) ? result.segments : [];
  const segments = rawSegments
    .map((segment, index) => segmentFromExternalValue(segment, index, durationMs))
    .filter((segment): segment is SubtitleSegment => Boolean(segment));
  if (segments.length > 0)
    return segments.map((segment, index) => ({ ...segment, id: `subtitle-${index + 1}` }));

  const text = typeof result.text === "string" ? result.text.trim() : "";
  if (!text) return [];
  return [{ id: "subtitle-1", startMs: 0, endMs: Math.max(0, durationMs), text }];
}

function segmentFromExternalValue(
  value: unknown,
  index: number,
  durationMs: number,
): SubtitleSegment | null {
  if (!isPlainObject(value)) return null;
  const segment = value as ExternalAsrSegment;
  const text = typeof segment.text === "string" ? segment.text.trim() : "";
  if (!text) return null;
  const startMs = clampMs(secondsToMs(readNumber(segment.start) ?? 0), durationMs);
  const endMs = clampMs(secondsToMs(readNumber(segment.end) ?? durationMs / 1000), durationMs);
  if (endMs <= startMs) return null;
  return { id: `subtitle-${index + 1}`, startMs, endMs, text };
}

function readLanguage(result: ExternalAsrResult): string {
  return typeof result.language === "string" && result.language.trim()
    ? result.language.trim()
    : DEFAULT_TRANSCRIPTION_LANGUAGE;
}

function buildAudioFileName(blob: Blob): string {
  if (blob.type.includes("mp4")) return "recording.mp4";
  if (blob.type.includes("mpeg") || blob.type.includes("mp3")) return "recording.mp3";
  if (blob.type.includes("wav")) return "recording.wav";
  return "recording.webm";
}

function resolveExternalAsrResponseFormat(model: string): "json" | "verbose_json" {
  const normalizedModel = model.trim().toLowerCase();
  if (normalizedModel.includes("gpt-4o") && normalizedModel.includes("transcribe")) {
    return "json";
  }
  return "verbose_json";
}

function isWebmBlob(blob: Blob): boolean {
  return blob.type.toLowerCase().includes("webm");
}

async function transcodeWebmToWav(mediaBlob: Blob, signal?: AbortSignal): Promise<Blob> {
  const AudioContextCtor = getAudioContextConstructor();
  if (!AudioContextCtor) throw new Error("当前浏览器不支持 Web Audio 解码");
  const audioContext = new AudioContextCtor();
  try {
    const buffer = await mediaBlob.arrayBuffer();
    if (signal?.aborted) throw new DOMException("字幕生成已取消", "AbortError");
    const audioBuffer = await audioContext.decodeAudioData(buffer.slice(0));
    if (signal?.aborted) throw new DOMException("字幕生成已取消", "AbortError");
    return audioBufferToWavBlob(audioBuffer);
  } finally {
    await audioContext.close().catch(() => undefined);
  }
}

function getAudioContextConstructor(): typeof AudioContext | null {
  const maybeGlobal = globalThis as typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };
  return maybeGlobal.AudioContext ?? maybeGlobal.webkitAudioContext ?? null;
}

function audioBufferToWavBlob(audioBuffer: AudioBuffer): Blob {
  const channelCount = audioBuffer.numberOfChannels;
  const frameCount = audioBuffer.length;
  const bytesPerSample = 2;
  const dataSize = frameCount * channelCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, audioBuffer.sampleRate, true);
  view.setUint32(28, audioBuffer.sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  const channels = Array.from({ length: channelCount }, (_value, channel) =>
    audioBuffer.getChannelData(channel),
  );
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channels[channel]?.[frame] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function joinUrl(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function secondsToMs(value: number): number {
  return Math.round(value * 1000);
}

function clampMs(value: number, durationMs: number): number {
  return Math.max(0, Math.min(Math.max(0, durationMs), value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}
