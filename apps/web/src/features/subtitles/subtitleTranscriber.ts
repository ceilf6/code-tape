import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import type { SubtitleSegment, SubtitleTranscriber } from "./types";
import { loadTransformersPipeline } from "./transformersLoader";

export const DEFAULT_TRANSCRIPTION_MODEL = "onnx-community/whisper-tiny";
const DEFAULT_TRANSCRIPTION_LANGUAGE = "zh";
const WHISPER_TRANSCRIPTION_LANGUAGE = "chinese";

type RawAsrChunk = {
  text?: unknown;
  timestamp?: unknown;
};

type RawAsrResult = {
  text?: unknown;
  chunks?: unknown;
  language?: unknown;
};

type AsrPipeline = (
  input: string,
  options: NonNullable<Parameters<AutomaticSpeechRecognitionPipeline>[1]>,
) => Promise<RawAsrResult>;

const TRANSCRIPTION_OPTIONS = {
  chunk_length_s: 30,
  stride_length_s: 5,
  return_timestamps: true,
  language: WHISPER_TRANSCRIPTION_LANGUAGE,
  task: "transcribe",
} satisfies NonNullable<Parameters<AutomaticSpeechRecognitionPipeline>[1]>;

type AsrPipelineOptions = {
  device: "wasm";
  dtype: "q8";
};

type PipelineFactory = (
  task: "automatic-speech-recognition",
  model: string,
  options: AsrPipelineOptions,
) => Promise<AsrPipeline>;

export type HuggingFaceSubtitleTranscriberOptions = {
  model?: string;
  pipelineFactory?: PipelineFactory;
};

export function normalizeTranscriptionResult(
  result: RawAsrResult,
  durationMs: number,
): SubtitleSegment[] {
  const chunks = Array.isArray(result.chunks) ? result.chunks : [];
  const segments = chunks
    .map((chunk, index) => segmentFromChunk(chunk, index, durationMs, chunks[index + 1]))
    .filter((segment): segment is SubtitleSegment => Boolean(segment));

  if (segments.length > 0) return reindexSegments(segments);

  const text = typeof result.text === "string" ? result.text.trim() : "";
  if (!text) return [];
  return [{ id: "subtitle-1", startMs: 0, endMs: Math.max(0, durationMs), text }];
}

export function createHuggingFaceSubtitleTranscriber(
  options: HuggingFaceSubtitleTranscriberOptions = {},
): SubtitleTranscriber {
  const model = options.model ?? DEFAULT_TRANSCRIPTION_MODEL;
  const pipelineOptions: AsrPipelineOptions = { device: "wasm", dtype: "q8" };
  let pipelinePromise: Promise<AsrPipeline> | null = null;
  const getPipeline = () => {
    if (!pipelinePromise) {
      pipelinePromise = (options.pipelineFactory
        ? options.pipelineFactory("automatic-speech-recognition", model, pipelineOptions)
        : loadDefaultPipeline("automatic-speech-recognition", model, pipelineOptions)
      ).catch((error: unknown) => {
        pipelinePromise = null;
        throw error;
      });
    }
    return pipelinePromise;
  };

  return {
    async warmUp() {
      await getPipeline();
    },
    async transcribe({ mediaBlob, durationMs, signal }) {
      if (signal?.aborted) throw new DOMException("字幕生成已取消", "AbortError");
      const pipeline = await getPipeline();
      if (signal?.aborted) throw new DOMException("字幕生成已取消", "AbortError");
      const url = URL.createObjectURL(mediaBlob);
      try {
        const result = await pipeline(url, TRANSCRIPTION_OPTIONS);
        return {
          model,
          source: "huggingface-local",
          language: readTranscriptionLanguage(result),
          segments: normalizeTranscriptionResult(result, durationMs),
        };
      } finally {
        URL.revokeObjectURL(url);
      }
    },
  };
}

async function loadDefaultPipeline(
  task: "automatic-speech-recognition",
  model: string,
  options: AsrPipelineOptions,
): Promise<AsrPipeline> {
  return loadTransformersPipeline<AsrPipeline>(task, model, options);
}

function segmentFromChunk(
  value: unknown,
  index: number,
  durationMs: number,
  nextValue: unknown,
): SubtitleSegment | null {
  if (!isPlainObject(value)) return null;
  const chunk = value as RawAsrChunk;
  const text = typeof chunk.text === "string" ? chunk.text.trim() : "";
  if (!text) return null;
  const [startSec, endSec] = readTimestamp(chunk.timestamp);
  const fallbackEndSec = getOpenEndFallbackSec(nextValue, startSec, durationMs);
  const startMs = clampMs(secondsToMs(startSec), durationMs);
  const endMs = clampMs(secondsToMs(endSec ?? fallbackEndSec), durationMs);
  if (endMs <= startMs) return null;
  return { id: `subtitle-${index + 1}`, startMs, endMs, text };
}

function reindexSegments(segments: SubtitleSegment[]): SubtitleSegment[] {
  return segments.map((segment, index) => ({ ...segment, id: `subtitle-${index + 1}` }));
}

function readTranscriptionLanguage(result: RawAsrResult): string {
  return typeof result.language === "string" && result.language.trim()
    ? result.language.trim()
    : DEFAULT_TRANSCRIPTION_LANGUAGE;
}

function readTimestamp(value: unknown): [number, number | null] {
  if (!Array.isArray(value)) return [0, null];
  const [start, end] = value;
  return [
    typeof start === "number" && Number.isFinite(start) ? start : 0,
    typeof end === "number" && Number.isFinite(end) ? end : null,
  ];
}

function getOpenEndFallbackSec(nextValue: unknown, startSec: number, durationMs: number): number {
  const nextStartSec = readChunkStartSec(nextValue);
  if (nextStartSec !== null && nextStartSec > startSec) return nextStartSec;
  return Math.max(0, durationMs) / 1000;
}

function readChunkStartSec(value: unknown): number | null {
  if (!isPlainObject(value)) return null;
  const timestamp = (value as RawAsrChunk).timestamp;
  if (!Array.isArray(timestamp)) return null;
  const [start] = timestamp;
  return typeof start === "number" && Number.isFinite(start) ? start : null;
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
