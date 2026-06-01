import { Captions, Loader2, WandSparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { SubtitleAsrConfigButton } from "./SubtitleAsrConfigButton";
import { SubtitleChapterList } from "./SubtitleChapterList";
import { SubtitleLlmConfigButton } from "./SubtitleLlmConfigButton";
import { applySubtitleCorrection } from "./subtitleCorrection";
import { createExternalAsrSubtitleTranscriber } from "./externalAsrSubtitleTranscriber";
import { createExternalLlmSubtitlePostProcessor } from "./externalLlmSubtitlePostProcessor";
import { createFallbackSubtitlePostProcessor } from "./fallbackSubtitlePostProcessor";
import { createFallbackSubtitleTranscriber } from "./fallbackSubtitleTranscriber";
import { resolveEffectivePostProcessTimeoutMs } from "./subtitlePostProcessTimeout";
import { isExternalLlmConfigured, loadExternalLlmConfig } from "./subtitleLlmConfig";
import { isExternalAsrConfigured, loadExternalAsrConfig } from "./subtitleAsrConfig";
import { resolveSubtitlePostProcessorModel } from "./subtitlePostProcessorConfig";
import { createWorkerBackedHuggingFaceSubtitlePostProcessor } from "./subtitlePostProcessorWorkerClient";
import { createSubtitleStore } from "./subtitleStore";
import { createHuggingFaceSubtitleTranscriber } from "./subtitleTranscriber";
import { requestStaleTransformersImportRecovery } from "./transformersLoader";
import type {
  SubtitleChapter,
  SubtitleCorrectionWarning,
  SubtitlePostProcessor,
  SubtitlePostProcessorContext,
  SubtitlePostProcessorMetric,
  SubtitleSegment,
  SubtitleStore,
  SubtitleTrack,
  SubtitleTranscriber,
  SubtitleTranscriptionStatus,
} from "./types";
import { cn } from "@/shared/ui/utils/cn";

export const DEFAULT_SUBTITLE_POSTPROCESS_TIMEOUT_MS = 60_000;

export type SubtitlePanelProps = {
  recordingId: string | null;
  mediaBlob: Blob | null;
  hasAudio: boolean;
  durationMs: number;
  currentTimeMs: number;
  onSeek(timeMs: number): void;
  store?: SubtitleStore;
  transcriber?: SubtitleTranscriber;
  postProcessor?: SubtitlePostProcessor | null;
  postProcessorContext?: SubtitlePostProcessorContext;
  postProcessTimeoutMs?: number;
};

type GenerationStatus = "idle" | "loading" | "generating" | "post-processing" | "ready" | "error";

type AsrRuntimeStatus = "idle" | "warming" | "warm" | "warm-error" | SubtitleTranscriptionStatus;

type PostProcessorWarmUpState = {
  recordingId: string;
  postProcessor: SubtitlePostProcessor;
  status: "pending" | "running" | "completed";
  cancel(): void;
};

export function SubtitlePanel({
  recordingId,
  mediaBlob,
  hasAudio,
  durationMs,
  currentTimeMs,
  onSeek,
  store: injectedStore,
  transcriber: injectedTranscriber,
  postProcessor: injectedPostProcessor,
  postProcessorContext,
  postProcessTimeoutMs = DEFAULT_SUBTITLE_POSTPROCESS_TIMEOUT_MS,
}: SubtitlePanelProps) {
  const store = useMemo(() => injectedStore ?? createSubtitleStore(), [injectedStore]);
  const [asrConfigVersion, setAsrConfigVersion] = useState(0);
  const transcriber = useMemo(() => {
    if (injectedTranscriber) return injectedTranscriber;
    const localTranscriber = createHuggingFaceSubtitleTranscriber();
    const externalConfig = loadExternalAsrConfig();
    if (!isExternalAsrConfigured(externalConfig)) return localTranscriber;
    const externalTranscriber = createExternalAsrSubtitleTranscriber({ config: externalConfig });
    return createFallbackSubtitleTranscriber(externalTranscriber, localTranscriber, {
      onFallback: () =>
        console.warn("[code-tape] external subtitle ASR failed; falling back to local model"),
    });
    // asrConfigVersion bumps when the user saves/clears the external ASR config.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injectedTranscriber, asrConfigVersion]);
  const externalAsrConfigured = useMemo(
    () => isExternalAsrConfigured(loadExternalAsrConfig()),
    // Recompute when the user saves/clears the config (version bump).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [asrConfigVersion],
  );
  const [llmConfigVersion, setLlmConfigVersion] = useState(0);
  const postProcessor = useMemo(
    () => {
      if (injectedPostProcessor !== undefined) return injectedPostProcessor;
      const localProcessor = createWorkerBackedHuggingFaceSubtitlePostProcessor({
        model: resolveSubtitlePostProcessorModel(),
        onMetric: logSubtitlePostProcessorMetric,
      });
      const externalConfig = loadExternalLlmConfig();
      if (!isExternalLlmConfigured(externalConfig)) return localProcessor;
      const externalProcessor = createExternalLlmSubtitlePostProcessor({ config: externalConfig });
      return createFallbackSubtitlePostProcessor(externalProcessor, localProcessor, {
        // Log only a sanitized category — never the raw error/response, which
        // could echo the API key or subtitle/code context from a misconfigured endpoint.
        onFallback: () =>
          console.warn("[code-tape] external subtitle LLM failed; falling back to local model"),
      });
    },
    // llmConfigVersion bumps when the user saves/clears the external LLM config,
    // forcing the post-processor to rebuild against the new config.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [injectedPostProcessor, llmConfigVersion],
  );
  const externalLlmConfigured = useMemo(
    () => isExternalLlmConfigured(loadExternalLlmConfig()),
    // Recompute when the user saves/clears the config (version bump).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [llmConfigVersion],
  );
  const [track, setTrack] = useState<SubtitleTrack | null>(null);
  const [chapters, setChapters] = useState<SubtitleChapter[]>([]);
  const [warnings, setWarnings] = useState<SubtitleCorrectionWarning[]>([]);
  const [status, setStatus] = useState<GenerationStatus>("idle");
  const [asrStatus, setAsrStatus] = useState<AsrRuntimeStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const activeSegment = findActiveSegment(track?.segments ?? [], currentTimeMs);
  const activeSegmentRef = useRef<HTMLButtonElement | null>(null);
  const requestVersionRef = useRef(0);
  const generationAbortRef = useRef<AbortController | null>(null);
  const warmUpTranscriberRef = useRef<SubtitleTranscriber | null>(null);
  const postProcessorWarmUpRef = useRef<PostProcessorWarmUpState | null>(null);

  useEffect(() => {
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    generationAbortRef.current?.abort();
    generationAbortRef.current = null;
    if (!recordingId) {
      setTrack(null);
      setChapters([]);
      setWarnings([]);
      setStatus("idle");
      setError(null);
      return;
    }
    let cancelled = false;
    setTrack(null);
    setChapters([]);
    setWarnings([]);
    setStatus("loading");
    setError(null);
    store
      .load(recordingId)
      .then((savedTrack): Promise<SubtitleChapter[] | null> => {
        if (cancelled || requestVersionRef.current !== requestVersion) return Promise.resolve(null);
        setTrack(savedTrack);
        setStatus(savedTrack ? "ready" : "idle");
        if (!savedTrack) return Promise.resolve([]);
        return Promise.resolve()
          .then(() => store.loadChapters(recordingId))
          .catch(() => []);
      })
      .then((savedChapters) => {
        if (!savedChapters || cancelled || requestVersionRef.current !== requestVersion) return;
        setChapters(savedChapters);
      })
      .catch((err) => {
        if (cancelled || requestVersionRef.current !== requestVersion) return;
        setError(formatSubtitleError(err));
        setStatus("error");
      });
    return () => {
      cancelled = true;
      generationAbortRef.current?.abort();
      generationAbortRef.current = null;
      postProcessorWarmUpRef.current = null;
      postProcessor?.dispose?.();
    };
  }, [postProcessor, recordingId, store]);

  useEffect(() => {
    activeSegmentRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeSegment?.id]);

  useEffect(() => {
    if (!transcriber.warmUp) return;
    if (warmUpTranscriberRef.current === transcriber) return;
    warmUpTranscriberRef.current = transcriber;
    setAsrStatus("warming");
    void transcriber
      .warmUp()
      .then(() => {
        if (warmUpTranscriberRef.current === transcriber) setAsrStatus("warm");
      })
      .catch(() => {
        if (warmUpTranscriberRef.current === transcriber) setAsrStatus("warm-error");
      });
  }, [transcriber]);

  useEffect(() => {
    if (
      !recordingId ||
      !hasAudio ||
      !track ||
      track.recordingId !== recordingId ||
      track.segments.length === 0 ||
      status === "loading" ||
      status === "generating" ||
      status === "post-processing" ||
      !postProcessor?.warmUp
    ) {
      return;
    }
    const existingWarmUp = postProcessorWarmUpRef.current;
    if (
      existingWarmUp?.recordingId === recordingId &&
      existingWarmUp.postProcessor === postProcessor
    ) {
      return;
    }
    let cancelled = false;
    const warmUpState: PostProcessorWarmUpState = {
      recordingId,
      postProcessor,
      status: "pending",
      cancel: () => undefined,
    };
    postProcessorWarmUpRef.current = warmUpState;
    warmUpState.cancel = scheduleIdleWarmUp(() => {
      if (cancelled) return;
      warmUpState.status = "running";
      void postProcessor
        .warmUp?.()
        .catch(() => undefined)
        .finally(() => {
          if (postProcessorWarmUpRef.current === warmUpState) {
            warmUpState.status = "completed";
          }
        });
    });
    return () => {
      cancelled = true;
      cancelPendingPostProcessorWarmUpState(postProcessorWarmUpRef, warmUpState);
    };
  }, [hasAudio, postProcessor, recordingId, status, track]);

  const canGenerate = Boolean(
    recordingId &&
    mediaBlob &&
    hasAudio &&
    status !== "loading" &&
    status !== "generating" &&
    status !== "post-processing",
  );
  const canPostProcess = Boolean(
    recordingId &&
    track &&
    track.segments.length > 0 &&
    postProcessor &&
    status !== "loading" &&
    status !== "generating" &&
    status !== "post-processing",
  );
  const shouldGenerateBeforePostProcess = Boolean(postProcessor && canGenerate);
  const primaryActionLabel = shouldGenerateBeforePostProcess
    ? "生成字幕并优化"
    : track && postProcessor
      ? "优化字幕和章节"
      : "生成字幕";
  const canRunPrimaryAction = shouldGenerateBeforePostProcess
    ? canGenerate
    : track && postProcessor
      ? canPostProcess
      : canGenerate;

  const postProcessTrack = async (
    baseTrack: SubtitleTrack,
    requestVersion: number,
    abortController: AbortController,
  ) => {
    if (!postProcessor) return;
    setStatus("post-processing");
    try {
      const correction = await runWithPostProcessTimeout(
        postProcessor.process({
          track: baseTrack,
          context: postProcessorContext,
          signal: abortController.signal,
        }),
        {
          abortController,
          timeoutMs: resolveEffectivePostProcessTimeoutMs(
            postProcessTimeoutMs,
            externalLlmConfigured,
          ),
        },
      );
      if (!isCurrentGeneration(requestVersionRef, requestVersion, abortController)) return;
      const result = applySubtitleCorrection(baseTrack, correction, { durationMs });
      const hasInvalidCorrection = result.warnings.some(
        (warning) => warning.code === "invalid-correction",
      );
      if (hasInvalidCorrection) {
        setWarnings(result.warnings);
        setStatus("ready");
        return;
      }
      await store.saveWithChapters(result.track, result.chapters);
      if (!isCurrentGeneration(requestVersionRef, requestVersion, abortController)) return;
      setTrack(result.track);
      setChapters(result.chapters);
      setWarnings(result.warnings);
      setStatus("ready");
    } catch (err) {
      if (isPostProcessTimeoutError(err)) {
        if (
          requestVersionRef.current !== requestVersion ||
          generationAbortRef.current !== abortController
        )
          return;
        setError(formatSubtitleError(err));
        setStatus("error");
        return;
      }
      if (abortController.signal.aborted || requestVersionRef.current !== requestVersion) return;
      if (requestStaleTransformersImportRecovery(err)) return;
      setError(formatSubtitleError(err));
      setStatus("error");
    }
  };

  const generateSubtitles = async () => {
    if (!recordingId || !mediaBlob || !hasAudio) return;
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    generationAbortRef.current?.abort();
    cancelActivePostProcessorWarmUp(postProcessorWarmUpRef, postProcessor);
    const abortController = new AbortController();
    generationAbortRef.current = abortController;
    setStatus("generating");
    setError(null);
    setWarnings([]);
    try {
      setAsrStatus("transcribing");
      const draft = await transcriber.transcribe({
        mediaBlob,
        durationMs,
        signal: abortController.signal,
        onStatus: setAsrStatus,
      });
      if (!isCurrentGeneration(requestVersionRef, requestVersion, abortController)) return;
      const nextTrack: SubtitleTrack = {
        recordingId,
        generatedAt: new Date().toISOString(),
        ...draft,
      };
      await store.saveWithChapters(nextTrack, []);
      if (!isCurrentGeneration(requestVersionRef, requestVersion, abortController)) return;
      setTrack(nextTrack);
      setChapters([]);
      setAsrStatus("warm");
      if (postProcessor) {
        await postProcessTrack(nextTrack, requestVersion, abortController);
        return;
      }
      setStatus("ready");
    } catch (err) {
      if (abortController.signal.aborted || requestVersionRef.current !== requestVersion) return;
      if (requestStaleTransformersImportRecovery(err)) return;
      setAsrStatus("warm-error");
      setError(formatSubtitleError(err));
      setStatus("error");
    } finally {
      if (generationAbortRef.current === abortController) {
        generationAbortRef.current = null;
      }
    }
  };

  const postProcessSubtitles = async () => {
    if (!recordingId || !track || !postProcessor) return;
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    generationAbortRef.current?.abort();
    cancelPendingPostProcessorWarmUp(postProcessorWarmUpRef, postProcessor);
    const abortController = new AbortController();
    generationAbortRef.current = abortController;
    setError(null);
    setWarnings([]);
    try {
      await postProcessTrack(track, requestVersion, abortController);
    } finally {
      if (generationAbortRef.current === abortController) {
        generationAbortRef.current = null;
      }
    }
  };

  const runPrimarySubtitleAction = () => {
    if (!shouldGenerateBeforePostProcess && track && postProcessor) {
      void postProcessSubtitles();
      return;
    }
    void generateSubtitles();
  };
  const statusMessage = formatAsrStatusMessage(status, asrStatus);

  return (
    <section aria-label="字幕" className="shrink-0 border-t border-border bg-background px-3 py-2">
      <div className="mb-2 flex min-h-9 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
          <Captions aria-hidden size={17} className="shrink-0 text-primary" />
          <span>字幕</span>
          {track ? (
            <span className="truncate text-xs font-normal text-muted">{track.model}</span>
          ) : null}
        </div>
        <div className="flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2">
          <SubtitleLlmConfigButton
            configured={externalLlmConfigured}
            onConfigChange={() => setLlmConfigVersion((version) => version + 1)}
          />
          <SubtitleAsrConfigButton
            configured={externalAsrConfigured}
            onConfigChange={() => setAsrConfigVersion((version) => version + 1)}
          />
          <button
            type="button"
            aria-label={primaryActionLabel}
            disabled={!canRunPrimaryAction}
            onClick={runPrimarySubtitleAction}
            className={buttonClassName}
          >
            {status === "generating" || status === "post-processing" ? (
              <Loader2 aria-hidden size={14} className="animate-spin" />
            ) : (
              <WandSparkles aria-hidden size={14} />
            )}
            <span>{primaryActionLabel}</span>
          </button>
        </div>
      </div>
      {status === "error" && error ? (
        <p role="alert" className="mb-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
      {warnings.length > 0 ? (
        <p role="alert" className="mb-2 text-xs text-warning">
          {warnings[0]?.message}
        </p>
      ) : null}
      {statusMessage ? <p className="mb-2 text-xs text-muted">{statusMessage}</p> : null}
      {!hasAudio ? (
        <p className="text-xs text-muted">无音频轨道</p>
      ) : track && track.segments.length > 0 ? (
        <>
          <SubtitleChapterList chapters={chapters} currentTimeMs={currentTimeMs} onSeek={onSeek} />
          <div className="flex max-h-32 min-h-0 flex-col gap-1 overflow-y-auto overscroll-contain pr-1">
            {track.segments.map((segment) => {
              const isActive = activeSegment?.id === segment.id;
              return (
                <button
                  key={segment.id}
                  ref={isActive ? activeSegmentRef : undefined}
                  type="button"
                  aria-current={isActive ? "true" : undefined}
                  aria-label={segment.text}
                  onClick={() => onSeek(segment.startMs)}
                  className={cn(
                    "grid grid-cols-[4.5rem_1fr] gap-2 rounded-md px-2 py-1.5 text-left text-xs leading-5",
                    "transition-[background-color,color] duration-150 ease-out-soft",
                    "hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                    isActive ? "bg-surface-raised text-foreground" : "text-muted",
                  )}
                >
                  <span className="font-mono tabular-nums">
                    {formatSubtitleTime(segment.startMs)}
                  </span>
                  <span className="text-foreground">{segment.text}</span>
                </button>
              );
            })}
          </div>
        </>
      ) : status === "generating" || status === "post-processing" ? null : (
        <p className="text-xs text-muted">暂无字幕</p>
      )}
    </section>
  );
}

const buttonClassName = cn(
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium",
  "text-foreground transition-[background-color,color] duration-150 ease-out-soft",
  "hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background",
);

function isCurrentGeneration(
  requestVersionRef: MutableRefObject<number>,
  requestVersion: number,
  abortController: AbortController,
): boolean {
  return !abortController.signal.aborted && requestVersionRef.current === requestVersion;
}

function findActiveSegment(
  segments: SubtitleSegment[],
  currentTimeMs: number,
): SubtitleSegment | null {
  return (
    segments.find((segment) => currentTimeMs >= segment.startMs && currentTimeMs < segment.endMs) ??
    null
  );
}

function formatSubtitleTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatSubtitleError(error: unknown): string {
  return error instanceof Error ? error.message : "字幕生成失败";
}

function formatAsrStatusMessage(
  generationStatus: GenerationStatus,
  asrStatus: AsrRuntimeStatus,
): string | null {
  if (generationStatus === "post-processing") return "ASR 完成，正在纠错并生成章节...";
  if (generationStatus === "generating") {
    if (asrStatus === "loading-local-model") return "正在加载本地 ASR 模型...";
    if (asrStatus === "requesting-external-asr") return "正在请求外部 ASR...";
    if (asrStatus === "transcribing") return "正在识别音频...";
    return "正在生成字幕...";
  }
  if (asrStatus === "warming") return "正在加载本地 ASR 模型...";
  if (asrStatus === "warm-error") return "本地 ASR 模型预热失败，点击生成时会重试。";
  return null;
}

class PostProcessTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`字幕纠错超时（${formatTimeoutBudget(timeoutMs)}），已保留当前字幕和章节。`);
    this.name = "PostProcessTimeoutError";
  }
}

function runWithPostProcessTimeout<T>(
  operation: Promise<T>,
  {
    abortController,
    timeoutMs,
  }: {
    abortController: AbortController;
    timeoutMs: number;
  },
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return operation;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let didTimeout = false;
  const guardedOperation = operation.catch((error) => {
    if (didTimeout) throw new PostProcessTimeoutError(timeoutMs);
    throw error;
  });
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      didTimeout = true;
      abortController.abort();
      reject(new PostProcessTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  return Promise.race([guardedOperation, timeout]).finally(() => {
    if (timeoutId !== null) clearTimeout(timeoutId);
  });
}

function isPostProcessTimeoutError(error: unknown): error is PostProcessTimeoutError {
  return error instanceof Error && error.name === "PostProcessTimeoutError";
}

function cancelActivePostProcessorWarmUp(
  warmUpRef: MutableRefObject<PostProcessorWarmUpState | null>,
  postProcessor: SubtitlePostProcessor | null,
): void {
  const warmUpState = warmUpRef.current;
  if (!warmUpState || warmUpState.postProcessor !== postProcessor) return;
  cancelPostProcessorWarmUpState(warmUpRef, warmUpState);
}

function cancelPostProcessorWarmUpState(
  warmUpRef: MutableRefObject<PostProcessorWarmUpState | null>,
  warmUpState: PostProcessorWarmUpState,
): void {
  warmUpState.cancel();
  if (warmUpRef.current !== warmUpState || warmUpState.status === "completed") return;
  warmUpRef.current = null;
  if (warmUpState.status === "running") {
    warmUpState.postProcessor.dispose?.();
  }
}

function cancelPendingPostProcessorWarmUp(
  warmUpRef: MutableRefObject<PostProcessorWarmUpState | null>,
  postProcessor: SubtitlePostProcessor | null,
): void {
  const warmUpState = warmUpRef.current;
  if (!warmUpState || warmUpState.postProcessor !== postProcessor) return;
  cancelPendingPostProcessorWarmUpState(warmUpRef, warmUpState);
}

function cancelPendingPostProcessorWarmUpState(
  warmUpRef: MutableRefObject<PostProcessorWarmUpState | null>,
  warmUpState: PostProcessorWarmUpState,
): void {
  warmUpState.cancel();
  if (warmUpRef.current === warmUpState && warmUpState.status === "pending") {
    warmUpRef.current = null;
  }
}

function scheduleIdleWarmUp(callback: () => void): () => void {
  const requestIdle = globalThis.requestIdleCallback;
  if (typeof requestIdle === "function") {
    const handle = requestIdle(callback, { timeout: 2_000 });
    return () => {
      globalThis.cancelIdleCallback?.(handle);
    };
  }
  return () => undefined;
}

function formatTimeoutBudget(timeoutMs: number): string {
  if (timeoutMs < 1_000) return `${Math.round(timeoutMs)}ms`;
  return `${Math.round(timeoutMs / 1_000)} 秒`;
}

function logSubtitlePostProcessorMetric(metric: SubtitlePostProcessorMetric): void {
  console.debug("[code-tape] subtitle postprocessor metric", {
    phase: metric.phase,
    status: metric.status,
    model: metric.model,
    workerLoadDurationMs: roundMetricDuration(metric.workerLoadDurationMs),
    workerRequestDurationMs: roundMetricDuration(metric.workerRequestDurationMs),
    totalDurationMs: roundMetricDuration(metric.totalDurationMs),
  });
}

function roundMetricDuration(durationMs: number): number {
  return Math.round(Math.max(0, durationMs) * 1_000) / 1_000;
}
