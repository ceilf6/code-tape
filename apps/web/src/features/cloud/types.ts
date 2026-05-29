/*
 * 云端录制仓库类型定义
 *
 * 本文件定义前端 CloudRecordingRepository 使用的类型，与后端 apps/api/src/cloud/types.ts
 * 中的契约保持一致。前端不直接依赖 @code-tape/api，因此在此处复刻所需类型。
 */

import type {
  RecordingLanguage,
  RecordingPackageV1,
  RecordingSchemaVersion,
} from "@code-tape/recording-schema";

// ─────────────────────────────────────────────────────────────
// 资产种类（与后端 RECORDING_ASSET_KINDS 一致）
// ─────────────────────────────────────────────────────────────

export type RecordingAssetKind =
  | "manifest"
  | "meta"
  | "events"
  | "snapshots"
  | "indexes"
  | "media"
  | "thumbnail";

// ─────────────────────────────────────────────────────────────
// 录制状态
// ─────────────────────────────────────────────────────────────

export type CloudRecordingStatus =
  | "uploading"
  | "processing"
  | "ready"
  | "failed"
  | "soft_deleted"
  | "purging"
  | "deleted";

// ─────────────────────────────────────────────────────────────
// API 错误类型
// ─────────────────────────────────────────────────────────────

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
  code: CloudApiErrorCode | "network-error";
  message: string;
  requestId?: string;
  details?: unknown;
};

export type CloudResult<T> = { ok: true; value: T } | { ok: false; error: CloudApiError };

// ─────────────────────────────────────────────────────────────
// 上传会话相关类型
// ─────────────────────────────────────────────────────────────

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

export type CreateShareLinkRequest = {
  expiresAt?: string | null;
  startTimeMs?: number;
};

export type CreateShareLinkResponse = {
  url: string;
  expiresAt: string | null;
};

// ─────────────────────────────────────────────────────────────
// 录制详情与列表（与后端 CloudRecordingListItem / CloudRecordingDetail 契约一致）
// ─────────────────────────────────────────────────────────────

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
  status: CloudRecordingStatus;
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

export type CloudRecordingAssetSummary = {
  kind: RecordingAssetKind;
  sizeBytes: number;
  mimeType: string;
  validatedAt: string | null;
};

export type CloudRecordingDetailResponse = {
  recording: CloudRecordingDetail;
  assets: CloudRecordingAssetSummary[];
};

export type ListRecordingsInput = {
  cursor?: string;
  limit?: number;
};

export type ListRecordingsResponse = {
  items: CloudRecordingListItem[];
  nextCursor: string | null;
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

// ─────────────────────────────────────────────────────────────
// 上传进度
// ─────────────────────────────────────────────────────────────

export type UploadProgress = {
  /** 已上传字节数 */
  bytesUploaded: number;
  /** 总字节数 */
  totalBytes: number;
  /** 当前正在上传的资产种类（null 表示尚未开始） */
  currentAssetKind: RecordingAssetKind | null;
};

// ─────────────────────────────────────────────────────────────
// CloudRecordingRepository 接口
// ─────────────────────────────────────────────────────────────

export type CloudRecordingRepository = {
  /** 创建上传会话，获取上传目标 URL 列表 */
  createUploadSession(
    input: CreateUploadSessionRequest,
  ): Promise<CloudResult<CreateUploadSessionResponse>>;

  /** 通过 HTTP PUT 上传单个资产到签名 URL，支持进度回调与超时 */
  uploadAsset(
    target: UploadTarget,
    blob: Blob,
    onProgress?: (progress: UploadProgress) => void,
    timeoutMs?: number,
  ): Promise<CloudResult<void>>;

  /** 通知服务端全部资产已上传完毕，触发校验 */
  completeUpload(
    sessionId: string,
    input: CompleteUploadSessionRequest,
  ): Promise<CloudResult<CompleteUploadSessionResponse>>;

  /**
   * 一步完成完整上传流程：序列化 RecordingPackageV1 JSON 资产 → create session →
   * PUT 各资产 → complete。调用方只需提供 package 和二进制 blob。
   */
  uploadPackage(
    pkg: RecordingPackageV1,
    blobs: { media?: Blob; thumbnail?: Blob },
    options?: { idempotencyKey?: string; onProgress?: (progress: UploadProgress) => void; timeoutMs?: number },
  ): Promise<CloudResult<{ recordingId: string; status: string }>>;

  /** 查询录制详情与当前状态（uploading/processing/ready/failed） */
  get(recordingId: string): Promise<CloudResult<CloudRecordingDetailResponse>>;

  /**
   * 轮询录制状态直到 ready / failed / timeout。
   * 默认每 3 秒轮询一次，最长等待 10 分钟。
   */
  pollUntilReady(
    recordingId: string,
    options?: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<CloudResult<CloudRecordingDetailResponse>>;

  /** 查询当前 owner 的 ready 录制列表 */
  list(input?: ListRecordingsInput): Promise<CloudResult<ListRecordingsResponse>>;

  /** 获取 ready 录制的云端播放描述 */
  getPlaybackDescriptor(recordingId: string): Promise<CloudResult<CloudPlaybackDescriptor>>;

  /** 为当前 owner 的 ready 云端录制创建分享链接 */
  createShareLink(
    recordingId: string,
    input: CreateShareLinkRequest,
  ): Promise<CloudResult<CreateShareLinkResponse>>;

  /** 通过分享 token 获取只读播放描述，无需 owner token */
  getSharedPlaybackDescriptor(token: string): Promise<CloudResult<CloudPlaybackDescriptor>>;

  /** 重命名当前 owner 可访问的云端录制 */
  rename(recordingId: string, title: string): Promise<CloudResult<void>>;

  /** 软删除当前 owner 可访问的云端录制 */
  remove(recordingId: string): Promise<CloudResult<void>>;

  /** 获取当前持久化的 owner token */
  getOwnerToken(): string;
};
