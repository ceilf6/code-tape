import { randomBytes } from "node:crypto";
import { RECORDING_SCHEMA_VERSION, type RecordingLanguage } from "@code-tape/recording-schema";
import { sha256Hex } from "@code-tape/recording-schema/hash";
import { parseIsoUtcInstantMs } from "./isoDate.js";
import type { MetadataRepository } from "./metadataRepository.js";
import type { ObjectStorage } from "./objectStorage.js";
import {
  RECORDING_ASSET_KINDS,
  MAX_RECORDING_DURATION_MS,
  MAX_RECORDING_MEDIA_SIZE_BYTES,
  MAX_RECORDING_TOTAL_ASSET_SIZE_BYTES,
} from "./types.js";
import type {
  CloudApiError,
  CloudPlaybackDescriptor,
  CloudRecordingDetail,
  CloudRecordingDetailResponse,
  CloudRecordingListItem,
  CloudRecordingAssetRecord,
  CloudRecordingRecord,
  CloudResult,
  CompleteUploadSessionRequest,
  CompleteUploadSessionResponse,
  CreateShareLinkRequest,
  CreateShareLinkResponse,
  CreateUploadSessionRequest,
  CreateUploadSessionResponse,
  DeleteRecordingResponse,
  ListRecordingsResponse,
  RecordingAssetKind,
  RenameRecordingRequest,
  RenameRecordingResponse,
  UploadSessionRecord,
  UploadTarget,
} from "./types.js";

const REQUIRED_ASSETS: RecordingAssetKind[] = ["manifest", "meta", "events", "snapshots"];
const PLAYBACK_DESCRIPTOR_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const RECORDING_ASSET_KIND_SET = new Set<string>(RECORDING_ASSET_KINDS);
const RECORDING_LANGUAGES = [
  "javascript",
  "typescript",
  "python",
] as const satisfies readonly RecordingLanguage[];
const RECORDING_LANGUAGE_SET = new Set<string>(RECORDING_LANGUAGES);
const MAX_UPLOAD_SCALAR_LENGTH = 128;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const DEFAULT_LIST_LIMIT = 20;
const SHARE_TOKEN_BYTES = 32;
const MAX_SHARE_TOKEN_ATTEMPTS = 5;
const SOFT_DELETE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type CloudRecordingService = {
  createUploadSession(input: {
    ownerId: string;
    input: CreateUploadSessionRequest;
  }): Promise<CloudResult<CreateUploadSessionResponse>>;
  completeUpload(input: {
    ownerId: string;
    sessionId: string;
    input: CompleteUploadSessionRequest;
  }): Promise<CloudResult<CompleteUploadSessionResponse>>;
  listRecordings(input: {
    ownerId: string;
    cursor?: string;
    limit?: number;
  }): Promise<CloudResult<ListRecordingsResponse>>;
  getRecording(input: {
    ownerId: string;
    recordingId: string;
  }): Promise<CloudResult<CloudRecordingDetailResponse>>;
  renameRecording(input: {
    ownerId: string;
    recordingId: string;
    input: RenameRecordingRequest;
  }): Promise<CloudResult<RenameRecordingResponse>>;
  deleteRecording(input: {
    ownerId: string;
    recordingId: string;
  }): Promise<CloudResult<DeleteRecordingResponse>>;
  createShareLink(input: {
    ownerId: string;
    recordingId: string;
    input: CreateShareLinkRequest;
  }): Promise<CloudResult<CreateShareLinkResponse>>;
  getPlaybackDescriptor(input: {
    ownerId: string;
    recordingId: string;
  }): Promise<CloudResult<CloudPlaybackDescriptor>>;
  getSharedPlaybackDescriptor(input: {
    token: string;
  }): Promise<CloudResult<CloudPlaybackDescriptor>>;
};

export function createCloudRecordingService(deps: {
  metadata: MetadataRepository;
  objectStorage: ObjectStorage;
  now?: () => Date;
  createId?: (prefix: string) => string;
  createShareToken?: () => string;
}): CloudRecordingService {
  const now = deps.now ?? (() => new Date());
  const createId = deps.createId ?? createCounterIdFactory();
  const createShareToken = deps.createShareToken ?? createSecureShareToken;

  return {
    async createUploadSession({ ownerId, input }) {
      const invalid = validateCreateUploadSessionInput(input);
      if (invalid) return { ok: false, error: invalid };

      const existing = await deps.metadata.findSessionByOwnerAndIdempotencyKey(
        ownerId,
        input.idempotencyKey,
      );
      if (existing) {
        return resolveExistingUploadSession({
          metadata: deps.metadata,
          objectStorage: deps.objectStorage,
          now,
          existing,
          input,
        });
      }

      const createdAt = now().toISOString();
      const expiresAt = new Date(Date.parse(createdAt) + SESSION_TTL_MS).toISOString();
      const recordingId = createId("rec");
      const sessionId = createId("upl");
      const recording: CloudRecordingRecord = {
        id: recordingId,
        ownerId,
        localPackageId: input.localPackageId,
        title: input.title.trim(),
        schemaVersion: input.schemaVersion,
        status: "uploading",
        visibility: "private",
        createdAt,
        updatedAt: createdAt,
        completedAt: null,
        deletedAt: null,
        durationMs: input.durationMs,
        initialLanguage: input.initialLanguage,
        hasAudio: input.hasAudio,
        hasCamera: input.hasCamera,
        totalSizeBytes: input.assets.reduce((sum, asset) => sum + asset.sizeBytes, 0),
        eventCount: null,
        snapshotCount: null,
        failureCode: null,
        failureMessage: null,
      };
      const assets = input.assets.map<CloudRecordingAssetRecord>((asset) => ({
        id: createId("asset"),
        recordingId,
        kind: asset.kind,
        objectKey: objectKeyFor(recordingId, asset.kind),
        sha256: asset.sha256,
        sizeBytes: asset.sizeBytes,
        mimeType: asset.mimeType,
        uploadedAt: null,
        validatedAt: null,
      }));
      const session: UploadSessionRecord = {
        id: sessionId,
        recordingId,
        ownerId,
        status: "open",
        expiresAt,
        idempotencyKey: input.idempotencyKey,
        createdAt,
        completedAt: null,
      };

      const write = await deps.metadata.createUpload({ recording, assets, session });
      if (write.status === "idempotency-key-exists") {
        return resolveExistingUploadSession({
          metadata: deps.metadata,
          objectStorage: deps.objectStorage,
          now,
          existing: write.existingSession,
          input,
        });
      }

      return {
        ok: true,
        value: {
          sessionId,
          recordingId,
          expiresAt,
          uploadTargets: createUploadTargets(deps.objectStorage, assets),
        },
      };
    },

    async completeUpload({ ownerId, sessionId, input }) {
      const session = await deps.metadata.getSession(sessionId);
      if (!session) return { ok: false, error: { code: "not-found", message: "upload session not found" } };
      if (session.ownerId !== ownerId) {
        return { ok: false, error: { code: "forbidden", message: "upload session owner mismatch" } };
      }
      const recording = await deps.metadata.getRecording(session.recordingId);
      if (!recording || recording.ownerId !== ownerId || !isOwnerVisibleStatus(recording.status)) {
        return { ok: false, error: { code: "not-found", message: "recording not found" } };
      }
      if (session.status === "completed") {
        const status =
          recording.status === "ready" || recording.status === "failed" ? recording.status : "processing";
        return { ok: true, value: { recordingId: session.recordingId, status } };
      }
      if (session.status !== "open") {
        return {
          ok: false,
          error: { code: "upload-session-conflict", message: "upload session is not open" },
        };
      }
      if (Date.parse(session.expiresAt) <= now().getTime()) {
        return {
          ok: false,
          error: { code: "upload-session-expired", message: "upload session expired" },
        };
      }
      const assets = await deps.metadata.listAssets(session.recordingId);
      const conflict = findCompleteConflict(assets, input);
      if (conflict) return { ok: false, error: conflict };
      const completedAt = now().toISOString();
      await deps.metadata.markUploadCompleted({
        sessionId,
        completedAt,
        uploadedAssetKinds: input.uploadedAssets.map((asset) => asset.kind),
      });
      const completedRecording = await deps.metadata.getRecording(session.recordingId);
      if (
        !completedRecording ||
        completedRecording.ownerId !== ownerId ||
        !isOwnerVisibleStatus(completedRecording.status)
      ) {
        return { ok: false, error: { code: "not-found", message: "recording not found" } };
      }
      const status =
        completedRecording.status === "ready" || completedRecording.status === "failed"
          ? completedRecording.status
          : "processing";
      return { ok: true, value: { recordingId: session.recordingId, status } };
    },
    async listRecordings({ ownerId, cursor, limit }) {
      const recordings = await deps.metadata.listRecordingsByOwner({
        ownerId,
        statuses: ["ready"],
      });
      const pageSize = limit ?? DEFAULT_LIST_LIMIT;
      const cursorIndex = cursor ? recordings.findIndex((recording) => recording.id === cursor) : -1;
      const startIndex = cursorIndex >= 0 ? cursorIndex + 1 : 0;
      const page = recordings.slice(startIndex, startIndex + pageSize);
      const hasMore = startIndex + pageSize < recordings.length;
      return {
        ok: true,
        value: {
          items: page.map(toListItem),
          nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
        },
      };
    },
    async getRecording({ ownerId, recordingId }) {
      const recording = await deps.metadata.getRecording(recordingId);
      if (!recording || recording.ownerId !== ownerId || !isOwnerVisibleStatus(recording.status)) {
        return { ok: false, error: { code: "not-found", message: "recording not found" } };
      }
      const assets = await deps.metadata.listAssets(recordingId);
      return {
        ok: true,
        value: {
          recording: toDetail(recording),
          assets: assets.map(toAssetSummary),
        },
      };
    },
    async renameRecording({ ownerId, recordingId, input }) {
      const invalid = validateRenameTitle(input.title);
      if (invalid) return { ok: false, error: invalid };

      const recording = await deps.metadata.getRecording(recordingId);
      if (!recording || recording.ownerId !== ownerId || !isOwnerVisibleStatus(recording.status)) {
        return { ok: false, error: { code: "not-found", message: "recording not found" } };
      }

      const updatedAt = now().toISOString();
      const renamed = await updateOwnerVisibleRecordingPatch({
        metadata: deps.metadata,
        ownerId,
        recording,
        patch: {
          title: input.title.trim(),
          updatedAt,
        },
      });
      if (!renamed) {
        return { ok: false, error: { code: "not-found", message: "recording not found" } };
      }
      return {
        ok: true,
        value: { id: renamed.id, title: renamed.title, updatedAt },
      };
    },
    async deleteRecording({ ownerId, recordingId }) {
      const recording = await deps.metadata.getRecording(recordingId);
      if (!recording || recording.ownerId !== ownerId) {
        return { ok: false, error: { code: "not-found", message: "recording not found" } };
      }

      // Idempotent: if already soft_deleted by this owner, return current state.
      // If deletedAt is missing (dirty data), generate and persist it now.
      if (recording.status === "soft_deleted") {
        const deletedAt = await ensureSoftDeleteTimestamp({
          metadata: deps.metadata,
          ownerId,
          recording,
          fallbackDeletedAt: now().toISOString(),
        });
        if (!deletedAt) {
          return { ok: false, error: { code: "not-found", message: "recording not found" } };
        }
        await deps.metadata.revokeShareLinksByRecordingId({
          recordingId: recording.id,
          revokedAt: deletedAt,
        });
        return {
          ok: true,
          value: {
            id: recording.id,
            recordingId: recording.id,
            status: "soft_deleted" as const,
            deletedAt,
            purgeAfter: purgeAfterFor(deletedAt),
          },
        };
      }

      // Non-visible terminal states (purging/deleted) are not accessible to the owner.
      if (!isOwnerVisibleStatus(recording.status)) {
        return { ok: false, error: { code: "not-found", message: "recording not found" } };
      }

      const deletedAt = now().toISOString();
      let current = recording;
      while (true) {
        const write = await deps.metadata.updateRecordingIfStatus({
          recordingId: current.id,
          expectedStatus: current.status,
          patch: {
            status: "soft_deleted",
            deletedAt,
            updatedAt: deletedAt,
          },
        });
        if (write.status === "updated") {
          await deps.metadata.revokeShareLinksByRecordingId({
            recordingId: write.recording.id,
            revokedAt: deletedAt,
          });
          return {
            ok: true,
            value: {
              id: write.recording.id,
              recordingId: write.recording.id,
              status: "soft_deleted" as const,
              deletedAt,
              purgeAfter: purgeAfterFor(deletedAt),
            },
          };
        }

        const latest = write.current;
        if (!latest || latest.ownerId !== ownerId) {
          return { ok: false, error: { code: "not-found", message: "recording not found" } };
        }
        if (latest.status === "soft_deleted") {
          const latestDeletedAt = await ensureSoftDeleteTimestamp({
            metadata: deps.metadata,
            ownerId,
            recording: latest,
            fallbackDeletedAt: deletedAt,
          });
          if (!latestDeletedAt) {
            return { ok: false, error: { code: "not-found", message: "recording not found" } };
          }
          await deps.metadata.revokeShareLinksByRecordingId({
            recordingId: latest.id,
            revokedAt: latestDeletedAt,
          });
          return {
            ok: true,
            value: {
              id: latest.id,
              recordingId: latest.id,
              status: "soft_deleted" as const,
              deletedAt: latestDeletedAt,
              purgeAfter: purgeAfterFor(latestDeletedAt),
            },
          };
        }
        if (!isOwnerVisibleStatus(latest.status)) {
          return { ok: false, error: { code: "not-found", message: "recording not found" } };
        }
        current = latest;
      }
    },
    async createShareLink({ ownerId, recordingId, input }) {
      const recording = await deps.metadata.getRecording(recordingId);
      if (!recording || recording.ownerId !== ownerId || recording.status !== "ready") {
        return { ok: false, error: { code: "not-found", message: "recording not found" } };
      }

      const invalid = validateCreateShareLinkInput(input, recording, now());
      if (invalid) return { ok: false, error: invalid };

      const createdAt = now().toISOString();
      const expiresAt = input.expiresAt ?? null;
      for (let attempt = 0; attempt < MAX_SHARE_TOKEN_ATTEMPTS; attempt += 1) {
        const token = createShareToken();
        const tokenHash = await sha256Hex(token);
        const write = await deps.metadata.createShareLink({
          id: createId("share"),
          recordingId: recording.id,
          tokenHash,
          createdBy: ownerId,
          createdAt,
          expiresAt,
          revokedAt: null,
        });
        if (write.status === "created") {
          await deps.metadata.updateRecordingIfStatus({
            recordingId: recording.id,
            expectedStatus: "ready",
            patch: {
              visibility: "unlisted",
              updatedAt: createdAt,
            },
          });
          return {
            ok: true,
            value: {
              url: buildShareUrl(token, input.startTimeMs),
              expiresAt,
            },
          };
        }
      }

      return {
        ok: false,
        error: { code: "rate-limited", message: "share token collision retry budget exceeded" },
      };
    },
    async getPlaybackDescriptor({ ownerId, recordingId }) {
      const recording = await deps.metadata.getRecording(recordingId);
      if (!recording || recording.ownerId !== ownerId || recording.status !== "ready") {
        return { ok: false, error: { code: "not-found", message: "recording not found" } };
      }

      return buildPlaybackDescriptor({
        metadata: deps.metadata,
        objectStorage: deps.objectStorage,
        recording,
        now,
      });
    },
    async getSharedPlaybackDescriptor({ token }) {
      const tokenHash = await sha256Hex(token);
      const shareLink = await deps.metadata.findShareLinkByTokenHash(tokenHash);
      if (
        !shareLink ||
        shareLink.revokedAt !== null ||
        (shareLink.expiresAt !== null && Date.parse(shareLink.expiresAt) <= now().getTime())
      ) {
        return { ok: false, error: { code: "not-found", message: "share link not found" } };
      }

      const recording = await deps.metadata.getRecording(shareLink.recordingId);
      if (!recording || recording.status !== "ready") {
        return { ok: false, error: { code: "not-found", message: "share link not found" } };
      }

      return buildPlaybackDescriptor({
        metadata: deps.metadata,
        objectStorage: deps.objectStorage,
        recording,
        now,
      });
    },
  };
}

function toListItem(recording: CloudRecordingRecord): CloudRecordingListItem {
  return {
    id: recording.id,
    title: recording.title,
    durationMs: recording.durationMs,
    createdAt: recording.createdAt,
    initialLanguage: recording.initialLanguage,
    hasAudio: recording.hasAudio,
    hasCamera: recording.hasCamera,
    thumbnailUrl: null,
    visibility: recording.visibility,
  };
}

function toDetail(recording: CloudRecordingRecord): CloudRecordingDetail {
  return {
    id: recording.id,
    title: recording.title,
    durationMs: recording.durationMs,
    createdAt: recording.createdAt,
    updatedAt: recording.updatedAt,
    initialLanguage: recording.initialLanguage,
    hasAudio: recording.hasAudio,
    hasCamera: recording.hasCamera,
    status: recording.status,
    localPackageId: recording.localPackageId,
    schemaVersion: recording.schemaVersion,
    visibility: recording.visibility,
    completedAt: recording.completedAt,
    totalSizeBytes: recording.totalSizeBytes,
    eventCount: recording.eventCount,
    snapshotCount: recording.snapshotCount,
    failureCode: recording.failureCode,
    failureMessage: recording.failureMessage,
  };
}

function toAssetSummary(asset: CloudRecordingAssetRecord) {
  return {
    kind: asset.kind,
    sizeBytes: asset.sizeBytes,
    mimeType: asset.mimeType,
    validatedAt: asset.validatedAt,
  };
}

async function buildPlaybackDescriptor(input: {
  metadata: MetadataRepository;
  objectStorage: ObjectStorage;
  recording: CloudRecordingRecord;
  now: () => Date;
}): Promise<CloudResult<CloudPlaybackDescriptor>> {
  const assets = await input.metadata.listAssets(input.recording.id);
  const assetsByKind = new Map(assets.map((asset) => [asset.kind, asset]));
  const missingRequired = REQUIRED_ASSETS.filter((kind) => !assetsByKind.has(kind));
  if (missingRequired.length > 0) {
    return {
      ok: false,
      error: { code: "not-found", message: "playback descriptor not available" },
    };
  }

  const getUrl = (kind: RecordingAssetKind): string | null => {
    const asset = assetsByKind.get(kind);
    return asset ? input.objectStorage.getAssetUrl(asset.objectKey) : null;
  };

  return {
    ok: true,
    value: {
      id: input.recording.id,
      title: input.recording.title,
      durationMs: input.recording.durationMs,
      schemaVersion: input.recording.schemaVersion,
      manifestUrl: getUrl("manifest")!,
      metaUrl: getUrl("meta")!,
      eventsUrl: getUrl("events")!,
      snapshotsUrl: getUrl("snapshots")!,
      indexesUrl: getUrl("indexes"),
      mediaUrl: getUrl("media"),
      thumbnailUrl: getUrl("thumbnail"),
      expiresAt: new Date(input.now().getTime() + PLAYBACK_DESCRIPTOR_TTL_MS).toISOString(),
    },
  };
}

function isOwnerVisibleStatus(status: CloudRecordingRecord["status"]): boolean {
  return status === "uploading" || status === "processing" || status === "ready" || status === "failed";
}

async function updateOwnerVisibleRecordingPatch(input: {
  metadata: MetadataRepository;
  ownerId: string;
  recording: CloudRecordingRecord;
  patch: Partial<Omit<CloudRecordingRecord, "id">>;
}): Promise<CloudRecordingRecord | null> {
  let current = input.recording;
  while (true) {
    const write = await input.metadata.updateRecordingIfStatus({
      recordingId: current.id,
      expectedStatus: current.status,
      patch: input.patch,
    });
    if (write.status === "updated") return write.recording;

    const latest = write.current;
    if (!latest || latest.ownerId !== input.ownerId || !isOwnerVisibleStatus(latest.status)) {
      return null;
    }
    current = latest;
  }
}

async function ensureSoftDeleteTimestamp(input: {
  metadata: MetadataRepository;
  ownerId: string;
  recording: CloudRecordingRecord;
  fallbackDeletedAt: string;
}): Promise<string | null> {
  let current = input.recording;
  while (current.deletedAt == null) {
    const write = await input.metadata.updateRecordingIfStatus({
      recordingId: current.id,
      expectedStatus: "soft_deleted",
      patch: { deletedAt: input.fallbackDeletedAt },
    });
    if (write.status === "updated") {
      return write.recording.deletedAt;
    }

    const latest = write.current;
    if (!latest || latest.ownerId !== input.ownerId || latest.status !== "soft_deleted") {
      return null;
    }
    current = latest;
  }
  return current.deletedAt;
}

function purgeAfterFor(deletedAt: string): string {
  return new Date(Date.parse(deletedAt) + SOFT_DELETE_RETENTION_MS).toISOString();
}

async function resolveExistingUploadSession(input: {
  metadata: MetadataRepository;
  objectStorage: ObjectStorage;
  now: () => Date;
  existing: UploadSessionRecord;
  input: CreateUploadSessionRequest;
}): Promise<CloudResult<CreateUploadSessionResponse>> {
  const assets = await input.metadata.listAssets(input.existing.recordingId);
  const recording = await input.metadata.getRecording(input.existing.recordingId);
  const conflict = findIdempotencyConflict(recording, assets, input.input);
  if (conflict) return { ok: false, error: conflict };
  if (input.existing.status !== "open") {
    return {
      ok: false,
      error: { code: "upload-session-conflict", message: "upload session is not open" },
    };
  }
  if (Date.parse(input.existing.expiresAt) <= input.now().getTime()) {
    return {
      ok: false,
      error: { code: "upload-session-expired", message: "upload session expired" },
    };
  }
  return {
    ok: true,
    value: {
      sessionId: input.existing.id,
      recordingId: input.existing.recordingId,
      expiresAt: input.existing.expiresAt,
      uploadTargets: createUploadTargets(input.objectStorage, assets),
    },
  };
}

function validateCreateUploadSessionInput(input: CreateUploadSessionRequest): CloudApiError | null {
  if (input.schemaVersion !== RECORDING_SCHEMA_VERSION) {
    return {
      code: "unsupported-schema",
      message: `unsupported schemaVersion: ${input.schemaVersion}`,
    };
  }
  const invalidIdempotencyKey = validateBoundedText(input.idempotencyKey, "idempotencyKey");
  if (invalidIdempotencyKey) return invalidIdempotencyKey;
  const invalidLocalPackageId = validateBoundedText(input.localPackageId, "localPackageId");
  if (invalidLocalPackageId) return invalidLocalPackageId;
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs < 0) {
    return {
      code: "invalid-manifest",
      message: "durationMs must be a non-negative safe integer",
    };
  }
  if (input.durationMs > MAX_RECORDING_DURATION_MS) {
    return {
      code: "quota-exceeded",
      message: `duration exceeds budget limit of ${MAX_RECORDING_DURATION_MS / 60000} minutes: ${input.durationMs}ms`,
    };
  }
  if (!RECORDING_LANGUAGE_SET.has(input.initialLanguage)) {
    return {
      code: "invalid-manifest",
      message: "initialLanguage must be one of javascript, typescript, python",
    };
  }
  const seenKinds = new Set<RecordingAssetKind>();
  for (const asset of input.assets) {
    if (!isRecordingAssetKind(asset.kind)) {
      return { code: "invalid-manifest", message: `unsupported asset kind: ${asset.kind}` };
    }
    if (seenKinds.has(asset.kind)) {
      return { code: "invalid-manifest", message: `duplicate asset kind: ${asset.kind}` };
    }
    seenKinds.add(asset.kind);
    if (!SHA256_HEX_PATTERN.test(asset.sha256)) {
      return { code: "invalid-manifest", message: `invalid asset checksum: ${asset.kind}` };
    }
    if (!Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0) {
      return { code: "invalid-manifest", message: `invalid asset size: ${asset.kind}` };
    }
    if (asset.kind === "media" && asset.sizeBytes > MAX_RECORDING_MEDIA_SIZE_BYTES) {
      return {
        code: "quota-exceeded",
        message: `media size exceeds budget limit of ${MAX_RECORDING_MEDIA_SIZE_BYTES / (1024 * 1024)}MB: ${asset.sizeBytes} bytes`,
      };
    }
    if (asset.mimeType.trim().length < 1) {
      return { code: "invalid-manifest", message: `invalid asset mime type: ${asset.kind}` };
    }
  }
  let totalSizeBytes = 0;
  for (const asset of input.assets) {
    totalSizeBytes += asset.sizeBytes;
    if (totalSizeBytes > MAX_RECORDING_TOTAL_ASSET_SIZE_BYTES) {
      return {
        code: "quota-exceeded",
        message: `total asset size exceeds budget limit of ${MAX_RECORDING_TOTAL_ASSET_SIZE_BYTES / (1024 * 1024)}MB: ${totalSizeBytes} bytes`,
      };
    }
  }
  const kinds = new Set(input.assets.map((asset) => asset.kind));
  const missing = REQUIRED_ASSETS.filter((kind) => !kinds.has(kind));
  if (missing.length > 0) {
    return {
      code: "invalid-manifest",
      message: `missing required assets: ${missing.join(", ")}`,
    };
  }
  if (input.title.trim().length < 1 || input.title.trim().length > 80) {
    return { code: "invalid-manifest", message: "title must be 1 to 80 characters" };
  }
  return null;
}

function validateBoundedText(value: string, field: string): CloudApiError | null {
  const trimmedLength = value.trim().length;
  if (
    trimmedLength < 1 ||
    trimmedLength > MAX_UPLOAD_SCALAR_LENGTH ||
    value.length > MAX_UPLOAD_SCALAR_LENGTH
  ) {
    return {
      code: "invalid-manifest",
      message: `${field} must be 1 to ${MAX_UPLOAD_SCALAR_LENGTH} characters`,
    };
  }
  return null;
}

const MAX_RECORDING_TITLE_LENGTH = 80;

function validateRenameTitle(title: unknown): CloudApiError | null {
  if (typeof title !== "string") {
    return { code: "bad-request", message: "title must be a string" };
  }
  const trimmed = title.trim();
  const titleLength = Array.from(trimmed).length;
  if (titleLength < 1 || titleLength > MAX_RECORDING_TITLE_LENGTH) {
    return {
      code: "bad-request",
      message: `title must be 1 to ${MAX_RECORDING_TITLE_LENGTH} characters`,
    };
  }
  return null;
}

function validateCreateShareLinkInput(
  input: CreateShareLinkRequest,
  recording: CloudRecordingRecord,
  currentTime: Date,
): CloudApiError | null {
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    const expiresAtMs = parseIsoUtcInstantMs(input.expiresAt);
    if (expiresAtMs === null) {
      return { code: "bad-request", message: "expiresAt must be an ISO date string or null" };
    }
    if (expiresAtMs <= currentTime.getTime()) {
      return { code: "bad-request", message: "expiresAt must be in the future" };
    }
  }
  if (input.startTimeMs !== undefined) {
    if (
      !Number.isSafeInteger(input.startTimeMs) ||
      input.startTimeMs < 0 ||
      input.startTimeMs > recording.durationMs
    ) {
      return {
        code: "bad-request",
        message: "startTimeMs must be a non-negative safe integer within the recording duration",
      };
    }
  }
  return null;
}

function buildShareUrl(token: string, startTimeMs: number | undefined): string {
  const path = `/s/${encodeURIComponent(token)}`;
  return startTimeMs === undefined ? path : `${path}?t=${startTimeMs}`;
}

function createSecureShareToken(): string {
  return randomBytes(SHARE_TOKEN_BYTES).toString("base64url");
}

function isRecordingAssetKind(value: string): value is RecordingAssetKind {
  return RECORDING_ASSET_KIND_SET.has(value);
}

function findIdempotencyConflict(
  recording: CloudRecordingRecord | null,
  assets: CloudRecordingAssetRecord[],
  input: CreateUploadSessionRequest,
): CloudApiError | null {
  if (!recording) return idempotencyConflictError();
  if (
    recording.localPackageId !== input.localPackageId ||
    recording.title !== input.title.trim() ||
    recording.schemaVersion !== input.schemaVersion ||
    recording.durationMs !== input.durationMs ||
    recording.initialLanguage !== input.initialLanguage ||
    recording.hasAudio !== input.hasAudio ||
    recording.hasCamera !== input.hasCamera
  ) {
    return idempotencyConflictError();
  }

  const assetsByKind = new Map(assets.map((asset) => [asset.kind, asset]));
  if (assetsByKind.size !== input.assets.length) return idempotencyConflictError();
  for (const asset of input.assets) {
    const existing = assetsByKind.get(asset.kind);
    if (
      !existing ||
      existing.sha256 !== asset.sha256 ||
      existing.sizeBytes !== asset.sizeBytes ||
      existing.mimeType !== asset.mimeType
    ) {
      return idempotencyConflictError();
    }
  }
  return null;
}

function idempotencyConflictError(): CloudApiError {
  return {
    code: "upload-session-conflict",
    message: "idempotency key reused with a different upload request",
  };
}

function createUploadTargets(
  objectStorage: ObjectStorage,
  assets: CloudRecordingAssetRecord[],
): UploadTarget[] {
  return assets.map((asset) =>
    objectStorage.createUploadTarget({
      kind: asset.kind,
      objectKey: asset.objectKey,
      mimeType: asset.mimeType,
      maxSizeBytes: asset.sizeBytes,
    }),
  );
}

function findCompleteConflict(
  expectedAssets: CloudRecordingAssetRecord[],
  input: CompleteUploadSessionRequest,
): CloudApiError | null {
  const uploadedByKind = new Map(input.uploadedAssets.map((asset) => [asset.kind, asset]));
  for (const expected of expectedAssets) {
    const uploaded = uploadedByKind.get(expected.kind);
    if (!uploaded) {
      return {
        code: "upload-session-conflict",
        message: `missing uploaded asset: ${expected.kind}`,
      };
    }
    if (uploaded.sha256 !== expected.sha256 || uploaded.sizeBytes !== expected.sizeBytes) {
      return {
        code: "upload-session-conflict",
        message: `uploaded asset mismatch: ${expected.kind}`,
      };
    }
  }
  return null;
}

function objectKeyFor(recordingId: string, kind: RecordingAssetKind): string {
  const nameByKind: Record<RecordingAssetKind, string> = {
    manifest: "package/manifest.json",
    meta: "package/meta.json",
    events: "package/events.json",
    snapshots: "package/snapshots.json",
    indexes: "package/indexes.json",
    media: "media/media.webm",
    thumbnail: "thumbnails/poster.webp",
  };
  return `recordings/${recordingId}/${nameByKind[kind]}`;
}

function createCounterIdFactory(): (prefix: string) => string {
  let next = 1;
  return (prefix: string) => `${prefix}_${next++}`;
}
