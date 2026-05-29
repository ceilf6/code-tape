import { Captions, Loader2, WandSparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { SubtitleChapterList } from "./SubtitleChapterList";
import { applySubtitleCorrection } from "./subtitleCorrection";
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
  const transcriber = useMemo(
    () => injectedTranscriber ?? createHuggingFaceSubtitleTranscriber(),
    [injectedTranscriber],
  );
  const postProcessor = useMemo(
    () =>
      injectedPostProcessor === undefined
        ? createWorkerBackedHuggingFaceSubtitlePostProcessor({
            model: resolveSubtitlePostProcessorModel(),
            onMetric: logSubtitlePostProcessorMetric,
          })
        : injectedPostProcessor,
    [injectedPostProcessor],
  );
  const [track, setTrack] = useState<SubtitleTrack | null>(null);
  const [chapters, setChapters] = useState<SubtitleChapter[]>([]);
  const [warnings, setWarnings] = useState<SubtitleCorrectionWarning[]>([]);
  const [status, setStatus] = useState<GenerationStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const activeSegment = findActiveSegment(track?.segments ?? [], currentTimeMs);
  const activeSegmentRef = useRef<HTMLButtonElement | null>(null);
  const requestVersionRef = useRef(0);
  const generationAbortRef = useRef<AbortController | null>(null);
  const warmUpRequestRef = useRef<{ recordingId: string; mediaBlob: Blob } | null>(null);
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
    if (!recordingId || !mediaBlob || !hasAudio || !transcriber.warmUp) {
      warmUpRequestRef.current = null;
      return;
    }
    const lastWarmUpRequest = warmUpRequestRef.current;
    if (lastWarmUpRequest?.recordingId === recordingId && lastWarmUpRequest.mediaBlob === mediaBlob) {
      return;
    }
    warmUpRequestRef.current = { recordingId, mediaBlob };
    void transcriber.warmUp().catch(() => undefined);
  }, [hasAudio, mediaBlob, recordingId, transcriber]);

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
      void postProcessor.warmUp?.()
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
      const draft = await transcriber.transcribe({
        mediaBlob,
        durationMs,
        signal: abortController.signal,
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
      setStatus("ready");
    } catch (err) {
      if (abortController.signal.aborted || requestVersionRef.current !== requestVersion) return;
      if (requestStaleTransformersImportRecovery(err)) return;
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
    setStatus("post-processing");
    setError(null);
    setWarnings([]);
    try {
      const correction = await runWithPostProcessTimeout(
        postProcessor.process({
          track,
          context: postProcessorContext,
          signal: abortController.signal,
        }),
        {
          abortController,
          timeoutMs: postProcessTimeoutMs,
        },
      );
      if (!isCurrentGeneration(requestVersionRef, requestVersion, abortController)) return;
      const result = applySubtitleCorrection(track, correction, { durationMs });
      const hasInvalidCorrection = result.warnings.some((warning) => warning.code === "invalid-correction");
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
        if (requestVersionRef.current !== requestVersion || generationAbortRef.current !== abortController) return;
        setError(formatSubtitleError(err));
        setStatus("error");
        return;
      }
      if (abortController.signal.aborted || requestVersionRef.current !== requestVersion) return;
      if (requestStaleTransformersImportRecovery(err)) return;
      setError(formatSubtitleError(err));
      setStatus("error");
    } finally {
      if (generationAbortRef.current === abortController) {
        generationAbortRef.current = null;
      }
    }
  };

  return (
    <section
      aria-label="字幕"
      className="shrink-0 border-t border-border bg-background px-3 py-2"
    >
      <div className="mb-2 flex min-h-9 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
          <Captions aria-hidden size={17} className="shrink-0 text-primary" />
          <span>字幕</span>
          {track ? (
            <span className="truncate text-xs font-normal text-muted">{track.model}</span>
          ) : null}
        </div>
        <div className="flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2">
          {track && postProcessor ? (
            <button
              type="button"
              aria-label="纠错并生成章节"
              disabled={!canPostProcess}
              onClick={postProcessSubtitles}
              className={buttonClassName}
            >
              {status === "post-processing" ? (
                <Loader2 aria-hidden size={14} className="animate-spin" />
              ) : (
                <WandSparkles aria-hidden size={14} />
              )}
              <span>纠错并生成章节</span>
            </button>
          ) : null}
          <button
            type="button"
            aria-label="生成字幕"
            disabled={!canGenerate}
            onClick={generateSubtitles}
            className={buttonClassName}
          >
            {status === "generating" ? (
              <Loader2 aria-hidden size={14} className="animate-spin" />
            ) : (
              <WandSparkles aria-hidden size={14} />
            )}
            <span>生成字幕</span>
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
      {!hasAudio ? (
        <p className="text-xs text-muted">无音频轨道</p>
      ) : track && track.segments.length > 0 ? (
        <>
          <SubtitleChapterList
            chapters={chapters}
            currentTimeMs={currentTimeMs}
            onSeek={onSeek}
          />
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
                  <span className="font-mono tabular-nums">{formatSubtitleTime(segment.startMs)}</span>
                  <span className="text-foreground">{segment.text}</span>
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <p className="text-xs text-muted">
          {status === "generating"
            ? "正在生成字幕..."
            : status === "post-processing"
              ? "正在纠错并生成章节..."
              : "暂无字幕"}
        </p>
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
