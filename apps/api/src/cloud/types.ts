import type { RecordingLanguage, RecordingSchemaVersion } from "@code-tape/recording-schema";

export const RECORDING_ASSET_KINDS = [
  "manifest",
  "meta",
  "events",
  "snapshots",
  "indexes",
  "media",
  "thumbnail",
] as const;

export type RecordingAssetKind = (typeof RECORDING_ASSET_KINDS)[number];

export const MAX_RECORDING_DURATION_MS = 15 * 60 * 1000; // 15 minutes
export const MAX_RECORDING_EVENT_COUNT = 20000;
export const MAX_RECORDING_MEDIA_SIZE_BYTES = 200 * 1024 * 1024; // 200MB
export const MAX_RECORDING_TOTAL_ASSET_SIZE_BYTES = 250 * 1024 * 1024; // 250MB

export type RecordingStatus =
  | "uploading"
  | "processing"
  | "ready"
  | "failed"
  | "soft_deleted"
  | "purging"
  | "deleted";

export type UploadSessionStatus = "open" | "completed" | "expired" | "failed";

export type CloudApiErrorCode =
  | "bad-request"
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "upload-session-expired"
  | "upload-session-conflict"
  | "unsupported-schema"
  | "invalid-manifest"
  | "invalid-event"
  | "checksum-mismatch"
  | "quota-exceeded"
  | "media-type-not-supported"
  | "rate-limited";

export type CloudApiError = {
  code: CloudApiErrorCode;
  message: string;
  requestId?: string;
  details?: unknown;
};

export type CloudResult<T> = { ok: true; value: T } | { ok: false; error: CloudApiError };

export type CreateUploadSessionRequest = {
  idempotencyKey: string;
  localPackageId: string;
  title: string;
  schemaVersion: RecordingSchemaVersion;
  durationMs: number;
  initialLanguage: RecordingLanguage;
  hasAudio: boolean;
  hasCamera: boolean;
  assets: Array<{
    kind: RecordingAssetKind;
    sha256: string;
    sizeBytes: number;
    mimeType: string;
  }>;
};

export type UploadTarget = {
  kind: RecordingAssetKind;
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  maxSizeBytes: number;
};

export type CreateUploadSessionResponse = {
  sessionId: string;
  recordingId: string;
  expiresAt: string;
  uploadTargets: UploadTarget[];
};

export type CompleteUploadSessionRequest = {
  uploadedAssets: Array<{
    kind: RecordingAssetKind;
    sha256: string;
    sizeBytes: number;
  }>;
};

export type CompleteUploadSessionResponse = {
  recordingId: string;
  status: "processing" | "ready" | "failed";
};

export type CloudRecordingListItem = {
  id: string;
  title: string;
  durationMs: number;
  createdAt: string;
  initialLanguage: RecordingLanguage;
  hasAudio: boolean;
  hasCamera: boolean;
  thumbnailUrl: string | null;
  visibility: "private" | "unlisted";
};

export type CloudRecordingDetail = {
  id: string;
  title: string;
  durationMs: number;
  createdAt: string;
  updatedAt: string;
  initialLanguage: RecordingLanguage;
  hasAudio: boolean;
  hasCamera: boolean;
  status: RecordingStatus;
  localPackageId: string;
  schemaVersion: RecordingSchemaVersion;
  visibility: "private" | "unlisted";
  completedAt: string | null;
  totalSizeBytes: number;
  eventCount: number | null;
  snapshotCount: number | null;
  failureCode: CloudApiErrorCode | null;
  failureMessage: string | null;
};

export type CloudPlaybackDescriptor = {
  id: string;
  title: string;
  durationMs: number;
  schemaVersion: RecordingSchemaVersion;
  manifestUrl: string;
  metaUrl: string;
  eventsUrl: string;
  snapshotsUrl: string;
  indexesUrl: string | null;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  expiresAt: string;
};

export type CloudRecordingAssetSummary = Pick<
  CloudRecordingAssetRecord,
  "kind" | "sizeBytes" | "mimeType" | "validatedAt"
>;

export type CloudRecordingDetailResponse = {
  recording: CloudRecordingDetail;
  assets: CloudRecordingAssetSummary[];
};

export type ListRecordingsResponse = {
  items: CloudRecordingListItem[];
  nextCursor: string | null;
};

export type CloudRecordingRecord = {
  id: string;
  ownerId: string;
  localPackageId: string;
  title: string;
  schemaVersion: RecordingSchemaVersion;
  status: RecordingStatus;
  visibility: "private" | "unlisted";
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  durationMs: number;
  initialLanguage: RecordingLanguage;
  hasAudio: boolean;
  hasCamera: boolean;
  totalSizeBytes: number;
  eventCount: number | null;
  snapshotCount: number | null;
  failureCode: CloudApiErrorCode | null;
  failureMessage: string | null;
};

export type CloudRecordingAssetRecord = {
  id: string;
  recordingId: string;
  kind: RecordingAssetKind;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  uploadedAt: string | null;
  validatedAt: string | null;
};

export type UploadSessionRecord = {
  id: string;
  recordingId: string;
  ownerId: string;
  status: UploadSessionStatus;
  expiresAt: string;
  idempotencyKey: string;
  createdAt: string;
  completedAt: string | null;
};
