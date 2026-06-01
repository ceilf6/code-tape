import { generateId } from "@/shared/util/ids";
import { createSnapshotBuilder } from "./snapshotBuilder";
import type {
  EventProducer,
  PackageBuildInput,
  RecordingController,
  RecordingControllerDeps,
  RecordingControllerState,
  RecordingControllerStatus,
  RecordingEvent,
  RecordingPackageV1,
  RecordStartPayload,
} from "@/shared/recording-schema";

export type RecordingControllerOptions = RecordingControllerDeps & {
  appVersion: string;
  generateTitle?: () => string;
  mediaSource?: () => Promise<PackageBuildInput["media"]>;
  onPersistenceFailure?: (failure: RecordingPersistenceFailure) => void | Promise<void>;
};

const VALID_TRANSITIONS: Record<RecordingControllerStatus, RecordingControllerStatus[]> = {
  idle: ["requestingPermission", "recording", "failed"],
  requestingPermission: ["recording", "failed", "idle"],
  recording: ["paused", "stopping", "failed"],
  paused: ["recording", "stopping", "failed"],
  stopping: ["processing", "failed"],
  processing: ["completed", "failed"],
  completed: ["idle"],
  failed: ["idle", "stopping"],
};

type PendingPackageSave = { pkg: RecordingPackageV1; mediaBlob: Blob | null };
export type RecordingPersistenceFailure = PendingPackageSave & { error: unknown };

/**
 * RecordingController — central state machine that wires clock + bus + producers
 * + builder + repository.
 *
 * State transitions are strictly enforced via VALID_TRANSITIONS so callers
 * never accidentally drive the controller into impossible states. Each public
 * method does:
 *   1. transition guard
 *   2. side effects (clock + producers + bus emit)
 *   3. publish state to listeners
 *
 * Errors during any phase tear the controller down to `failed`; callers may
 * `reset()` back to `idle` after surfacing the error.
 */
export function createRecordingController(options: RecordingControllerOptions): RecordingController {
  const { clock, bus, producers, packageBuilder, repository } = options;
  const listeners = new Set<(s: RecordingControllerState) => void>();
  const snapshotBuilder = createSnapshotBuilder();
  bus.subscribe((event) => snapshotBuilder.apply(event));

  let state: RecordingControllerState = {
    status: "idle",
    startedAt: null,
    durationMs: 0,
    mediaCapability: {
      audio: "unsupported",
      camera: "unsupported",
      selectedAudioDeviceId: null,
      selectedCameraDeviceId: null,
    },
    lastError: null,
  };

  let startPayload: RecordStartPayload | null = null;
  let finalizedMedia: PackageBuildInput["media"] | undefined;
  let pendingPackageSave: PendingPackageSave | null = null;

  const publish = () => listeners.forEach((fn) => fn(state));
  const transitionTo = (next: RecordingControllerStatus, patch: Partial<RecordingControllerState> = {}) => {
    const allowed = VALID_TRANSITIONS[state.status] ?? [];
    if (!allowed.includes(next) && next !== state.status) {
      throw new Error(`Illegal transition: ${state.status} -> ${next}`);
    }
    state = { ...state, ...patch, status: next };
    publish();
  };

  const forEachProducer = (op: (p: EventProducer) => void): void => {
    for (const producer of producers) {
      try {
        op(producer);
      } catch (err) {
        console.warn("[recording-controller] producer threw:", err);
      }
    }
  };

  return {
    get state() {
      return state;
    },
    async start(input) {
      transitionTo("requestingPermission", { lastError: null });
      try {
        snapshotBuilder.reset();
        startPayload = input;
        clock.start();
        const startedAt = new Date().toISOString();
        transitionTo("recording", {
          startedAt,
          durationMs: 0,
          mediaCapability: input.mediaCapability,
        });
        bus.emit({
          type: "record-start",
          source: "recorder",
          track: "main",
          payload: input,
        });
        forEachProducer((p) => p.start());
      } catch (err) {
        transitionTo("failed", { lastError: errorToInfo(err) });
        throw err;
      }
    },
    pause() {
      if (state.status !== "recording") return;
      const seq = bus.peek().length;
      bus.emit({
        type: "record-pause",
        source: "recorder",
        track: "main",
        payload: { reason: "user", stateSeq: seq },
      });
      forEachProducer((p) => p.pause());
      clock.pause();
      transitionTo("paused", { durationMs: clock.durationMs() });
    },
    async resume() {
      if (state.status !== "paused") return;
      clock.resume();
      forEachProducer((p) => p.resume());
      bus.emit({
        type: "record-resume",
        source: "recorder",
        track: "main",
        payload: { reason: "user" },
      });
      transitionTo("recording", { durationMs: clock.durationMs() });
    },
    async stop(reason): Promise<RecordingPackageV1> {
      if (state.status === "failed" && !pendingPackageSave) {
        throw new Error("No pending recording package is available to retry.");
      }
      transitionTo("stopping", { lastError: null });
      try {
        if (!pendingPackageSave) {
          forEachProducer((p) => p.stop());
          const durationMs = clock.durationMs();
          bus.emit({
            type: "record-stop",
            source: "recorder",
            track: "main",
            payload: { durationMs, reason },
          });
          clock.stop();
          transitionTo("processing", { durationMs });

          const snapshots = snapshotBuilder.finalize();
          const events = bus.drain();
          if (!startPayload) {
            throw new Error("RecordingController.start() must be called before stop().");
          }
          if (finalizedMedia === undefined) {
            finalizedMedia = await resolveMedia(options.mediaSource);
          }

          const titleProvider = options.generateTitle ?? (() => `录制 ${new Date().toLocaleString()}`);

          pendingPackageSave = await packageBuilder.build({
            meta: {
              id: generateId("rec"),
              title: titleProvider(),
              createdAt: state.startedAt ?? new Date().toISOString(),
              durationMs,
              appVersion: options.appVersion,
              ownerId: null,
              creatorInfo: null,
              initialLanguage: startPayload.initialLanguage,
              initialActiveScriptLanguage: startPayload.initialActiveScriptLanguage,
              initialDocuments: startPayload.initialDocuments,
              initialFontSize: startPayload.initialFontSize,
              initialTheme: startPayload.initialTheme,
              mediaCapability: startPayload.mediaCapability,
            },
            events,
            snapshots,
            media: finalizedMedia,
          });
        } else {
          transitionTo("processing", { durationMs: pendingPackageSave.pkg.meta.durationMs });
        }

        pendingPackageSave = await persistPackage(repository, packageBuilder, pendingPackageSave, (fallback) => {
          pendingPackageSave = fallback;
        });

        transitionTo("completed");
        const pkg = pendingPackageSave.pkg;
        pendingPackageSave = null;
        finalizedMedia = undefined;
        startPayload = null;
        return pkg;
      } catch (err) {
        if (pendingPackageSave) {
          try {
            await options.onPersistenceFailure?.({ ...pendingPackageSave, error: err });
          } catch (fallbackErr) {
            console.warn("[recording-controller] persistence fallback failed:", fallbackErr);
          }
        }
        transitionTo("failed", { lastError: errorToInfo(err) });
        throw err;
      }
    },
    reset() {
      if (isActiveStatus(state.status)) {
        forEachProducer((p) => p.stop());
        clock.stop();
      }
      forEachProducer((p) => p.dispose());
      bus.reset();
      snapshotBuilder.reset();
      state = {
        status: "idle",
        startedAt: null,
        durationMs: 0,
        mediaCapability: state.mediaCapability,
        lastError: null,
      };
      startPayload = null;
      finalizedMedia = undefined;
      pendingPackageSave = null;
      publish();
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
  } satisfies RecordingController;
}

async function persistPackage(
  repository: RecordingControllerDeps["repository"],
  packageBuilder: RecordingControllerDeps["packageBuilder"],
  pending: PendingPackageSave,
  setFallbackPending?: (pending: PendingPackageSave) => void,
): Promise<PendingPackageSave> {
  await assertSufficientQuota(repository, pending);
  const { pkg, mediaBlob } = pending;
  const saveResult = await repository.saveDraft({
    meta: pkg.meta,
    events: pkg.events,
    snapshots: pkg.snapshots,
    indexes: pkg.indexes ?? {
      generatedAt: new Date().toISOString(),
      eventsByType: {} as Record<string, number[]>,
      snapshotSeqsByTime: [],
      markers: [],
    },
    mediaBlob,
  });
  if (!saveResult.ok) {
    if (saveResult.reason === "media-write-failed" && mediaBlob) {
      const eventOnlyPending = await buildMediaMissingFallback(packageBuilder, pending, saveResult.message);
      setFallbackPending?.(eventOnlyPending);
      await assertSufficientQuota(repository, eventOnlyPending);
      const eventOnlySave = await repository.saveDraft({
        meta: eventOnlyPending.pkg.meta,
        events: eventOnlyPending.pkg.events,
        snapshots: eventOnlyPending.pkg.snapshots,
        indexes: eventOnlyPending.pkg.indexes ?? {
          generatedAt: new Date().toISOString(),
          eventsByType: {} as Record<string, number[]>,
          snapshotSeqsByTime: [],
          markers: [],
        },
        mediaBlob: null,
      });
      if (!eventOnlySave.ok) {
        throw persistenceError("save-draft-failed", eventOnlySave.reason, eventOnlySave.message);
      }
      const eventOnlyCommit = await repository.commit(eventOnlyPending.pkg.meta.id);
      if (!eventOnlyCommit.ok) {
        throw persistenceError("commit-failed", eventOnlyCommit.reason, eventOnlyCommit.message);
      }
      return eventOnlyPending;
    }
    throw persistenceError("save-draft-failed", saveResult.reason, saveResult.message);
  }

  const commitResult = await repository.commit(pkg.meta.id);
  if (!commitResult.ok) {
    throw persistenceError("commit-failed", commitResult.reason, commitResult.message);
  }
  return pending;
}

async function assertSufficientQuota(
  repository: RecordingControllerDeps["repository"],
  pending: PendingPackageSave,
): Promise<void> {
  let estimate: { usageBytes: number; quotaBytes: number };
  try {
    estimate = await repository.estimateQuota();
  } catch (err) {
    console.warn("[recording-controller] quota estimate failed:", err);
    return;
  }
  if (estimate.quotaBytes <= 0) return;
  const availableBytes = Math.max(0, estimate.quotaBytes - estimate.usageBytes);
  const requiredBytes = estimateRequiredSaveBytes(pending);
  if (availableBytes < requiredBytes) {
    throw persistenceError(
      "quota-precheck-failed",
      "quota-exceeded",
      `Local storage has ${(availableBytes / 1024 / 1024).toFixed(1)} MB available; recording needs about ${(requiredBytes / 1024 / 1024).toFixed(1)} MB.`,
    );
  }
}

function estimateRequiredSaveBytes({ pkg, mediaBlob }: PendingPackageSave): number {
  const jsonBytes = estimateValueBytes(pkg.manifest)
    + estimateValueBytes(pkg.meta)
    + estimateValueBytes(pkg.events)
    + estimateValueBytes(pkg.snapshots)
    + estimateValueBytes(pkg.indexes ?? {})
    + estimateValueBytes(pkg.media ?? null);
  const mediaBytes = mediaBlob ? Math.ceil(mediaBlob.size * 1.4) : 0;
  return jsonBytes + mediaBytes + 512 * 1024;
}

function estimateValueBytes(value: unknown): number {
  if (value === null || typeof value === "undefined") return 4;
  if (typeof value === "string") return estimateStringBytes(value);
  if (typeof value === "number" || typeof value === "boolean") return 16;
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + estimateValueBytes(item) + 1, 2);
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).reduce(
      (sum, [key, item]) => sum + estimateStringBytes(key) + estimateValueBytes(item) + 2,
      2,
    );
  }
  return estimateStringBytes(String(value));
}

function estimateStringBytes(value: string): number {
  return value.length * 2 + 2;
}

async function buildMediaMissingFallback(
  packageBuilder: RecordingControllerDeps["packageBuilder"],
  pending: PendingPackageSave,
  message: string,
): Promise<PendingPackageSave> {
  const warning = mediaMissingWarningEvent(pending.pkg, message);
  return packageBuilder.build({
    meta: pending.pkg.meta,
    events: [...pending.pkg.events, warning],
    snapshots: pending.pkg.snapshots,
    media: null,
  });
}

function mediaMissingWarningEvent(pkg: RecordingPackageV1, message: string): RecordingEvent {
  const lastSeq = pkg.events.reduce((max, event) => Math.max(max, event.seq), -1);
  return {
    id: generateId("e"),
    seq: lastSeq + 1,
    timestampMs: pkg.meta.durationMs,
    wallTime: new Date().toISOString(),
    source: "media",
    track: "media",
    type: "media-warning",
    payload: {
      target: "recorder",
      code: "recorder-error",
      message: `Media could not be saved. Event timeline was preserved. ${message}`,
    },
  };
}

function isActiveStatus(status: RecordingControllerStatus): boolean {
  return (
    status === "requestingPermission" ||
    status === "recording" ||
    status === "paused" ||
    status === "stopping" ||
    status === "processing"
  );
}

function errorToInfo(err: unknown): { code: string; message: string } {
  if (err instanceof Error) return { code: err.name, message: err.message };
  return { code: "unknown", message: String(err) };
}

async function resolveMedia(
  mediaSource: RecordingControllerOptions["mediaSource"],
): Promise<PackageBuildInput["media"]> {
  if (!mediaSource) return null;
  try {
    return await mediaSource();
  } catch (err) {
    console.warn("[recording-controller] mediaSource threw:", err);
    return null;
  }
}

function persistenceError(code: string, reason: string, message: string): Error {
  const error = new Error(`${code}: ${reason}: ${message}`);
  error.name = code;
  return error;
}
