import type {
  SubtitleCorrectionResult,
  SubtitlePostProcessor,
  SubtitlePostProcessorContext,
  SubtitleTrack,
} from "./types";
import { DEFAULT_POSTPROCESSOR_MODEL } from "./subtitlePostProcessorConfig";
import { loadTransformersPipeline } from "./transformersLoader";

export { DEFAULT_POSTPROCESSOR_MODEL } from "./subtitlePostProcessorConfig";
const MAX_PROMPT_CODE_CHARS = 6_000;
const MAX_PROMPT_RUNTIME_OUTPUT_CHARS = 2_000;
const BASE_MAX_NEW_TOKENS = 128;
const MAX_POSTPROCESSOR_SEGMENTS = 120;
const POSTPROCESSOR_CHUNK_SEGMENTS = 60;
const MAX_DYNAMIC_NEW_TOKENS = 768;
const NEW_TOKENS_PER_SEGMENT = 5;
const CHAPTER_OUTPUT_TOKEN_RESERVE = 96;
const MAX_REPAIR_OUTPUT_CHARS = 2_000;
const ASCII_TERM_PRESERVATION_RATIO = 0.75;
const SMOLLM_CHAT_TEMPLATE = `{% for message in messages %}{% if loop.first and messages[0]['role'] != 'system' %}{{ '<|im_start|>system
You are a helpful AI assistant named SmolLM, trained by Hugging Face<|im_end|>
' }}{% endif %}{{'<|im_start|>' + message['role'] + '
' + message['content'] + '<|im_end|>' + '
'}}{% endfor %}{% if add_generation_prompt %}{{ '<|im_start|>assistant
' }}{% endif %}`;

type SubtitlePostProcessorMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type TextGenerationPipelineOptions = {
  device: "webgpu" | "wasm";
  dtype: "q4" | "q4f16" | "q8";
};

type TextGenerationPipeline = (
  prompt: string | SubtitlePostProcessorMessage[],
  options: {
    max_new_tokens: number;
    do_sample: boolean;
    repetition_penalty: number;
    return_full_text: boolean;
    chat_template?: string;
  },
) => Promise<unknown>;

type PipelineFactory = (
  task: "text-generation",
  model: string,
  options: TextGenerationPipelineOptions,
) => Promise<TextGenerationPipeline>;

export const DEFAULT_POSTPROCESSOR_RUNTIME_CONFIG: TextGenerationPipelineOptions = {
  device: "wasm",
  dtype: "q8",
};

export type HuggingFaceSubtitlePostProcessorOptions = {
  model?: string;
  pipelineFactory?: PipelineFactory;
};

export function createHuggingFaceSubtitlePostProcessor(
  options: HuggingFaceSubtitlePostProcessorOptions = {},
): SubtitlePostProcessor {
  const model = options.model ?? DEFAULT_POSTPROCESSOR_MODEL;
  // Keep the cold-start path to the single validated browser target; final load errors are wrapped below.
  const pipelineOptions: TextGenerationPipelineOptions[] = [
    DEFAULT_POSTPROCESSOR_RUNTIME_CONFIG,
  ];
  let pipelinePromise: Promise<TextGenerationPipeline> | null = null;
  const getPipeline = () => {
    if (!pipelinePromise) {
      pipelinePromise = loadPipelineWithFallback({
        model,
        pipelineFactory: options.pipelineFactory,
        pipelineOptions,
      }).catch((error: unknown) => {
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
    async process(input) {
      if (input.signal?.aborted) throw new DOMException("字幕纠错已取消", "AbortError");
      const pipeline = await getPipeline();
      if (input.signal?.aborted) throw new DOMException("字幕纠错已取消", "AbortError");
      return processSubtitleTrack({ input, model, pipeline });
    },
  };
}

async function processSubtitleTrack({
  input,
  model,
  pipeline,
}: {
  input: {
    track: SubtitleTrack;
    context?: SubtitlePostProcessorContext;
    signal?: AbortSignal;
  };
  model: string;
  pipeline: TextGenerationPipeline;
}): Promise<SubtitleCorrectionResult> {
  if (input.track.segments.length <= MAX_POSTPROCESSOR_SEGMENTS) {
    return processSubtitleTrackChunk({ input, model, pipeline });
  }

  const chunks = chunkSubtitleTrack(input.track, POSTPROCESSOR_CHUNK_SEGMENTS);
  const merged: SubtitleCorrectionResult = { segments: [], chapters: [] };
  for (const chunk of chunks) {
    if (input.signal?.aborted) throw new DOMException("字幕纠错已取消", "AbortError");
    const result = await processSubtitleTrackChunk({
      input: { ...input, track: chunk },
      model,
      pipeline,
    });
    merged.segments.push(...result.segments);
    merged.chapters?.push(...(result.chapters ?? []));
  }
  if (input.signal?.aborted) throw new DOMException("字幕纠错已取消", "AbortError");
  return constrainCorrectionToTrack(merged, input.track);
}

async function processSubtitleTrackChunk({
  input,
  model,
  pipeline,
}: {
  input: {
    track: SubtitleTrack;
    context?: SubtitlePostProcessorContext;
    signal?: AbortSignal;
  };
  model: string;
  pipeline: TextGenerationPipeline;
}): Promise<SubtitleCorrectionResult> {
  const maxNewTokens = estimateMaxNewTokens(input.track);
  const output = await pipeline(buildSubtitlePostProcessorMessages(input), {
    max_new_tokens: maxNewTokens,
    do_sample: false,
    repetition_penalty: 1.05,
    return_full_text: false,
    ...buildChatTemplateOption(model),
  });
  if (input.signal?.aborted) throw new DOMException("字幕纠错已取消", "AbortError");
  const generatedText = readGeneratedText(output);
  try {
    return constrainCorrectionToTrack(
      extractSubtitleCorrectionResult(generatedText),
      input.track,
    );
  } catch (error) {
    if (!isRecoverableJsonOutputError(error)) throw error;
    const recovered = recoverSubtitleCorrectionResult(generatedText, input.track);
    if (recovered) return recovered;
  }
  if (input.signal?.aborted) throw new DOMException("字幕纠错已取消", "AbortError");
  const retryOutput = await pipeline(buildSubtitlePostProcessorMessages(input, { previousOutput: generatedText }), {
    max_new_tokens: maxNewTokens,
    do_sample: false,
    repetition_penalty: 1.05,
    return_full_text: false,
    ...buildChatTemplateOption(model),
  });
  if (input.signal?.aborted) throw new DOMException("字幕纠错已取消", "AbortError");
  const retryGeneratedText = readGeneratedText(retryOutput);
  try {
    return constrainCorrectionToTrack(
      extractSubtitleCorrectionResult(retryGeneratedText),
      input.track,
    );
  } catch (error) {
    if (!isRecoverableJsonOutputError(error)) throw error;
    const recovered = recoverSubtitleCorrectionResult(retryGeneratedText, input.track);
    if (recovered) return recovered;
    throw error;
  }
}

function chunkSubtitleTrack(track: SubtitleTrack, maxSegments: number): SubtitleTrack[] {
  const chunks: SubtitleTrack[] = [];
  for (let index = 0; index < track.segments.length; index += maxSegments) {
    chunks.push({
      ...track,
      segments: track.segments.slice(index, index + maxSegments),
    });
  }
  return chunks;
}

async function loadPipelineWithFallback({
  model,
  pipelineFactory,
  pipelineOptions,
}: {
  model: string;
  pipelineFactory?: PipelineFactory;
  pipelineOptions: TextGenerationPipelineOptions[];
}): Promise<TextGenerationPipeline> {
  for (const [index, options] of pipelineOptions.entries()) {
    try {
      return pipelineFactory
        ? await pipelineFactory("text-generation", model, options)
        : await loadDefaultPipeline("text-generation", model, options);
    } catch (error) {
      const hasNextOption = index < pipelineOptions.length - 1;
      if (!hasNextOption) {
        throw buildModelLoadError(error, options);
      }
      if (!isRecoverableModelLoadError(error, options)) {
        throw buildModelLoadError(error, options);
      }
    }
  }
  throw new Error("本地字幕 LLM 模型加载失败");
}

function buildModelLoadError(error: unknown, options: TextGenerationPipelineOptions): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(
    `当前浏览器无法加载本地字幕 LLM 模型（${options.device}/${options.dtype}）。请关闭其他占用内存的页面、升级浏览器后重试，或稍后再运行字幕纠错。原始错误：${detail}`,
  );
  if (error instanceof Error) {
    (wrapped as Error & { cause?: unknown }).cause = error;
  }
  return wrapped;
}

function isRecoverableModelLoadError(
  error: unknown,
  options: TextGenerationPipelineOptions,
): boolean {
  return (
    options.device === "webgpu" ||
    isQuantizedWeightCompatibilityError(error) ||
    isMissingModelArtifactError(error)
  );
}

function buildChatTemplateOption(model: string): { chat_template?: string } {
  return model.includes("code-tape-subtitle-postprocessor") ? { chat_template: SMOLLM_CHAT_TEMPLATE } : {};
}

function isQuantizedWeightCompatibilityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("TransposeDQWeightsForMatMulNBits") ||
    message.includes("MatMulNBits") ||
    message.includes("Missing required scale")
  );
}

function isMissingModelArtifactError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Could not locate file") ||
    message.includes("Could not load model") ||
    message.includes("404") ||
    message.includes("Not Found")
  );
}

function estimateMaxNewTokens(track: SubtitleTrack): number {
  const segmentCount = track.segments.length;
  if (segmentCount > MAX_POSTPROCESSOR_SEGMENTS) {
    throw new Error(
      `字幕段过多（${segmentCount} 段），浏览器本地 LLM 单次最多支持 ${MAX_POSTPROCESSOR_SEGMENTS} 段；请先拆分录制或缩短片段后再运行 AI 纠错。`,
    );
  }
  return Math.min(
    MAX_DYNAMIC_NEW_TOKENS,
    Math.max(BASE_MAX_NEW_TOKENS, segmentCount * NEW_TOKENS_PER_SEGMENT + CHAPTER_OUTPUT_TOKEN_RESERVE),
  );
}

export function buildSubtitlePostProcessorPrompt({
  track,
  context,
}: {
  track: SubtitleTrack;
  context?: SubtitlePostProcessorContext;
}): string {
  return buildSubtitlePostProcessorMessages({ track, context })
    .map((message) => message.content)
    .join("\n");
}

export function buildSubtitlePostProcessorMessages(
  input: {
    track: SubtitleTrack;
    context?: SubtitlePostProcessorContext;
  },
  options: { previousOutput?: string } = {},
): SubtitlePostProcessorMessage[] {
  const payload = buildSubtitlePostProcessorPayload(input);
  const messages: SubtitlePostProcessorMessage[] = [
    {
      role: "system",
      content: [
        "You are the code-tape subtitle post-processing model.",
        "Goal: correct ASR subtitle text for frontend/code terms and create playback chapter jump points.",
        "Input subtitle rows with timing are in inputSegments.",
        "Only output JSON with segments and chapters. Do not output Markdown or explanations. 只输出 JSON。",
        "For speed, output only changed subtitle segments in segments. Omit unchanged segments.",
        "Each returned segment must contain only id and text.",
        "Generate short playback chapter jump points from subtitle content and timestamps.",
        'Output shape example: {"segments":[{"id":"subtitle-1","text":"这里用 useState 维护 count"}],"chapters":[{"title":"状态设计","startMs":0,"endMs":1000}]}',
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(payload),
    },
  ];
  if (options.previousOutput !== undefined) {
    messages.push(
      {
        role: "user",
        content: [
          "Previous output failed JSON parsing or validation.",
          "Regenerate from scratch; do not continue, patch, or explain the previous output.",
          "Output exactly one complete JSON object with segments and chapters arrays.",
          "No explanations, Markdown, code fences, or text outside JSON.",
          "Previous output excerpt:",
          budgetPromptText(readRepairOutputExcerpt(options.previousOutput), MAX_REPAIR_OUTPUT_CHARS),
        ].join("\n"),
      },
    );
  }
  return messages;
}

function buildSubtitlePostProcessorPayload({
  track,
  context,
}: {
  track: SubtitleTrack;
  context?: SubtitlePostProcessorContext;
}) {
  return {
    context: {
      fileName: context?.fileName ?? null,
      code: budgetPromptText(context?.code ?? "", MAX_PROMPT_CODE_CHARS),
      runtimeOutput: budgetPromptText(
        context?.runtimeOutput ?? "",
        MAX_PROMPT_RUNTIME_OUTPUT_CHARS,
      ),
      glossary: context?.glossary ?? [],
    },
    inputSegments: track.segments.map((segment) => ({
      id: segment.id,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
    })),
  };
}

function budgetPromptText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const markerFor = (omittedChars: number) => `\n[truncated ${omittedChars} chars]\n`;
  let marker = markerFor(text.length - maxChars);
  let availableChars = maxChars - marker.length;
  if (availableChars <= 0) return text.slice(0, maxChars);

  let headChars = Math.ceil(availableChars / 2);
  let tailChars = Math.floor(availableChars / 2);
  marker = markerFor(text.length - headChars - tailChars);
  availableChars = maxChars - marker.length;
  headChars = Math.ceil(availableChars / 2);
  tailChars = Math.floor(availableChars / 2);

  return `${text.slice(0, headChars)}${marker}${text.slice(text.length - tailChars)}`;
}

function readRepairOutputExcerpt(previousOutput: string): string {
  try {
    return extractJsonObjectText(previousOutput);
  } catch {
    return previousOutput;
  }
}

function isRecoverableJsonOutputError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.startsWith("LLM 输出") ||
    error.message.startsWith("LLM segments") ||
    error.message.startsWith("LLM chapters")
  );
}

export function extractSubtitleCorrectionResult(text: string): SubtitleCorrectionResult {
  const jsonText = extractJsonObjectText(text);
  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`LLM 输出不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPlainObject(value)) {
    throw new Error("LLM 输出 JSON 必须是对象");
  }
  const segments = Array.isArray(value.segments) ? value.segments : null;
  const chapters = Array.isArray(value.chapters) ? value.chapters : null;
  if (!segments) throw new Error("LLM 输出缺少 segments 数组");
  if (!chapters) throw new Error("LLM 输出缺少 chapters 数组");

  return {
    segments: segments.map((segment, index) => normalizeSegment(segment, index)),
    chapters: chapters.map((chapter, index) => normalizeChapter(chapter, index)),
  };
}

function constrainCorrectionToTrack(
  correction: SubtitleCorrectionResult,
  track: SubtitleTrack,
): SubtitleCorrectionResult {
  return {
    ...correction,
    segments: constrainCorrectionSegments(correction.segments, track),
    chapters: constrainCorrectionChaptersToTrack(correction.chapters ?? [], track),
  };
}

function constrainCorrectionChaptersToTrack(
  chapters: NonNullable<SubtitleCorrectionResult["chapters"]>,
  track: SubtitleTrack,
): NonNullable<SubtitleCorrectionResult["chapters"]> {
  const subtitleStartMs = Math.min(Number.POSITIVE_INFINITY, ...track.segments.map((segment) => segment.startMs));
  const subtitleEndMs = Math.max(0, ...track.segments.map((segment) => segment.endMs));
  const timelineState = {
    previousEndMs: Number.NEGATIVE_INFINITY,
    seenTimelines: new Set<string>(),
  };
  return chapters
    .filter((chapter) => chapter.startMs >= subtitleStartMs)
    .filter((chapter) => chapter.startMs < subtitleEndMs)
    .filter((chapter) => !chapter.title.includes("\uFFFD"))
    .map((chapter) => ({
      ...chapter,
      ...(typeof chapter.endMs === "number"
        ? { endMs: Math.min(chapter.endMs, subtitleEndMs) }
      : {}),
    }))
    .filter((chapter) => chapter.endMs === undefined || chapter.endMs > chapter.startMs)
    .sort((left, right) => left.startMs - right.startMs)
    .filter((chapter) => keepOrderedUniqueChapterTimeline(chapter, timelineState));
}

function keepOrderedUniqueChapterTimeline(
  chapter: NonNullable<SubtitleCorrectionResult["chapters"]>[number],
  state: { previousEndMs: number; seenTimelines: Set<string> },
): boolean {
  if (chapter.startMs < state.previousEndMs) return false;
  const key = `${chapter.startMs}:${chapter.endMs ?? ""}`;
  if (state.seenTimelines.has(key)) return false;
  state.seenTimelines.add(key);
  state.previousEndMs = chapter.endMs ?? chapter.startMs;
  return true;
}

function constrainCorrectionSegments(
  segments: SubtitleCorrectionResult["segments"],
  track: SubtitleTrack,
): SubtitleCorrectionResult["segments"] {
  const sourceTextById = new Map(track.segments.map((segment) => [segment.id, segment.text]));
  const seenSegmentIds = new Set<string>();
  return segments.filter((segment) => {
    const sourceText = sourceTextById.get(segment.id);
    if (sourceText === undefined) return dropCorrectionSegment(segment.id, "unknown-segment");
    if (seenSegmentIds.has(segment.id)) return dropCorrectionSegment(segment.id, "duplicate-segment");
    if (!segment.text.trim()) return dropCorrectionSegment(segment.id, "empty-text");
    if (segment.text.includes("\uFFFD")) return dropCorrectionSegment(segment.id, "replacement-character");
    if (!isPlausibleTextCorrection(sourceText, segment.text)) {
      return dropCorrectionSegment(segment.id, "implausible-text");
    }
    seenSegmentIds.add(segment.id);
    return true;
  });
}

function dropCorrectionSegment(segmentId: string, reason: string): false {
  console.debug("[code-tape] dropped subtitle correction", { segmentId, reason });
  return false;
}

function recoverSubtitleCorrectionResult(
  text: string,
  track: SubtitleTrack,
): SubtitleCorrectionResult | null {
  let value: unknown;
  try {
    value = JSON.parse(extractJsonObjectText(text));
  } catch {
    return null;
  }
  if (!isPlainObject(value)) return null;
  if (!Array.isArray(value.segments) || !Array.isArray(value.chapters)) return null;

  const segments = constrainCorrectionSegments(readLooseCorrectionSegments(value.segments), track);
  const chapters = readLooseCorrectionChapters(value);
  return constrainCorrectionToTrack(
    {
      segments,
      chapters,
    },
    track,
  );
}

function readLooseCorrectionSegments(segments: unknown[]): SubtitleCorrectionResult["segments"] {
  return segments.flatMap((segment, index) => {
    try {
      return [normalizeSegment(segment, index)];
    } catch {
      return [];
    }
  });
}

function readLooseCorrectionChapters(
  value: Record<string, unknown>,
): NonNullable<SubtitleCorrectionResult["chapters"]> {
  if (Array.isArray(value.chapters)) {
    return value.chapters.flatMap((chapter, index) => {
      try {
        return [normalizeChapter(chapter, index)];
      } catch {
        return [];
      }
    });
  }
  return [];
}

function isPlausibleTextCorrection(sourceText: string, correctedText: string): boolean {
  const sourceTerms = extractAsciiTerms(sourceText);
  if (sourceTerms.length > 0) {
    const preservedTerms = countPreservedAsciiTerms(sourceTerms, correctedText);
    const requiredPreservedTerms = Math.ceil(sourceTerms.length * ASCII_TERM_PRESERVATION_RATIO);
    return preservedTerms >= requiredPreservedTerms;
  }

  const sourceChars = extractCjkChars(sourceText);
  if (sourceChars.length === 0) return true;
  const correctedChars = new Set(extractCjkChars(correctedText));
  const sharedChars = sourceChars.filter((char) => correctedChars.has(char)).length;
  return sharedChars / sourceChars.length >= 0.35;
}

function extractAsciiTerms(text: string): string[] {
  return [...new Set(text.match(/[a-z][a-z0-9_.$-]*/giu)?.map(normalizeAsciiText) ?? [])]
    .filter((term) => term.length >= 2);
}

function countPreservedAsciiTerms(sourceTerms: string[], correctedText: string): number {
  const corrected = normalizeAsciiText(correctedText);
  const correctedTerms = extractAsciiTerms(correctedText);
  const preservedIndexes = new Set<number>();

  sourceTerms.forEach((sourceTerm, index) => {
    if (corrected.includes(sourceTerm)) {
      preservedIndexes.add(index);
      return;
    }
    if (hasNearCodeTerm(sourceTerm, correctedTerms)) {
      preservedIndexes.add(index);
    }
  });

  for (const fusedSourceTerm of buildFusedSourceTerms(sourceTerms)) {
    if (!hasNearCodeTerm(fusedSourceTerm.term, correctedTerms)) continue;
    for (let index = fusedSourceTerm.start; index < fusedSourceTerm.end; index += 1) {
      preservedIndexes.add(index);
    }
  }

  return preservedIndexes.size;
}

function buildFusedSourceTerms(sourceTerms: string[]): Array<{ term: string; start: number; end: number }> {
  const terms: Array<{ term: string; start: number; end: number }> = [];
  const seen = new Set<string>();
  for (let start = 0; start < sourceTerms.length; start += 1) {
    for (let end = start + 2; end <= sourceTerms.length; end += 1) {
      const term = sourceTerms.slice(start, end).join("");
      if (seen.has(term)) continue;
      seen.add(term);
      terms.push({ term, start, end });
    }
  }
  return terms;
}

function hasNearCodeTerm(sourceTerm: string, correctedTerms: string[]): boolean {
  return correctedTerms.some(
    (correctedTerm) =>
      correctedTerm !== sourceTerm &&
      !correctedTerm.includes(sourceTerm) &&
      isNearCodeTerm(sourceTerm, correctedTerm),
  );
}

function isNearCodeTerm(sourceTerm: string, correctedTerm: string): boolean {
  if (sourceTerm.length < 4 || correctedTerm.length < 3) return false;
  const maxDistance = Math.max(2, Math.floor(Math.max(sourceTerm.length, correctedTerm.length) * 0.2));
  return levenshteinDistanceWithin(sourceTerm, correctedTerm, maxDistance);
}

function levenshteinDistanceWithin(left: string, right: string, maxDistance: number): boolean {
  if (Math.abs(left.length - right.length) > maxDistance) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = current[0] ?? leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const distance = Math.min(
        (previous[rightIndex] ?? 0) + 1,
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + substitutionCost,
      );
      current[rightIndex] = distance;
      rowMinimum = Math.min(rowMinimum, distance);
    }
    if (rowMinimum > maxDistance) return false;
    previous = current;
  }
  return (previous[right.length] ?? Number.POSITIVE_INFINITY) <= maxDistance;
}

function normalizeAsciiText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_.$-]/gu, "");
}

function extractCjkChars(text: string): string[] {
  return text.match(/\p{Script=Han}/gu) ?? [];
}

async function loadDefaultPipeline(
  task: "text-generation",
  model: string,
  options: TextGenerationPipelineOptions,
): Promise<TextGenerationPipeline> {
  return loadTransformersPipeline<TextGenerationPipeline>(task, model, options);
}

function readGeneratedText(output: unknown): string {
  const text = readGeneratedTextCandidate(output);
  if (text !== null) return text;
  throw new Error("LLM 输出缺少 generated_text");
}

function readGeneratedTextCandidate(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const assistantContent = readAssistantMessageContent(output);
    if (assistantContent !== null) return assistantContent;
    return output.length > 0 ? readGeneratedTextCandidate(output[0]) : null;
  }
  if (isPlainObject(output)) {
    return readGeneratedTextCandidate(output.generated_text);
  }
  return null;
}

function readAssistantMessageContent(messages: unknown[]): string | null {
  const assistantMessage = [...messages]
    .reverse()
    .find(
      (message): message is { role: string; content: string } =>
        isPlainObject(message) &&
        message.role === "assistant" &&
        typeof message.content === "string",
    );
  return assistantMessage?.content ?? null;
}

function extractJsonObjectText(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/u)?.[1]?.trim();
  const source = fenced ?? text;
  const start = source.indexOf("{");
  if (start === -1) {
    throw new Error("LLM 输出中未找到 JSON 对象");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error("LLM 输出中未找到完整 JSON 对象");
}

function normalizeSegment(value: unknown, index: number): SubtitleCorrectionResult["segments"][number] {
  if (!isPlainObject(value) || typeof value.id !== "string" || typeof value.text !== "string") {
    throw new Error(`LLM segments[${index}] 格式非法`);
  }
  const id = value.id.trim();
  const text = value.text.trim();
  if (!id || !text) throw new Error(`LLM segments[${index}] 不能为空`);
  return { id, text };
}

function normalizeChapter(
  value: unknown,
  index: number,
): NonNullable<SubtitleCorrectionResult["chapters"]>[number] {
  if (
    !isPlainObject(value) ||
    typeof value.title !== "string" ||
    typeof value.startMs !== "number" ||
    !Number.isFinite(value.startMs)
  ) {
    throw new Error(`LLM chapters[${index}] 格式非法`);
  }
  const title = value.title.trim();
  if (!title) throw new Error(`LLM chapters[${index}] 标题不能为空`);
  const endMs =
    typeof value.endMs === "number" && Number.isFinite(value.endMs)
      ? Math.round(value.endMs)
      : undefined;
  return {
    title,
    startMs: Math.round(value.startMs),
    ...(typeof endMs === "number" ? { endMs } : {}),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
