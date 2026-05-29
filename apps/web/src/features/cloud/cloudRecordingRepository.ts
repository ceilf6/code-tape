/*
 * CloudRecordingRepository 实现
 *
 * 为后续上传 UI 和云端列表接入提供稳定的前端门面。
 * 不替换 P0 本地 RecordingRepository，作为独立的云端通道存在。
 *
 * 职责：
 * - 创建上传会话（POST /api/recordings/upload-sessions）
 * - 按 upload targets 通过 HTTP PUT 上传各资产（支持进度回调）
 * - 调用 complete API 通知服务端开始校验
 * - 查询录制详情与状态（GET /api/recordings/:id）
 * - 查询当前 owner 的 ready 录制列表（GET /api/recordings）
 * - 获取 playback descriptor，重命名，软删除
 * - 管理持久化的 demo owner token
 *
 * 不包含：
 * - 上传按钮或完整 UI
 * - 云端播放页、CloudPackageLoader
 * - 分享
 * - 对 P0 本地保存/回放主链路的任何修改
 */

import type { RecordingPackageV1 } from "@code-tape/recording-schema";
import { canonicalStringify, sha256Hex } from "@code-tape/recording-schema/hash";
import type {
  CloudRecordingRepository,
  CloudResult,
  CloudRecordingDetailResponse,
  CompleteUploadSessionRequest,
  CompleteUploadSessionResponse,
  CreateUploadSessionRequest,
  CreateUploadSessionResponse,
  CreateShareLinkRequest,
  CreateShareLinkResponse,
  CloudPlaybackDescriptor,
  ListRecordingsInput,
  ListRecordingsResponse,
  UploadProgress,
  UploadTarget,
  CloudApiError,
  RecordingAssetKind,
} from "./types";

// ─────────────────────────────────────────────────────────────
// 配置常量
// ─────────────────────────────────────────────────────────────

/** localStorage 中存储 owner token 的键名 */
const OWNER_TOKEN_KEY = "code-tape-cloud-owner-token";

/** owner token 随机字符串长度（32 字节 hex = 64 字符） */
const OWNER_TOKEN_BYTES = 32;

const OWNER_TOKEN_PATTERN = /^[a-f0-9]{64}$/i;

/** 默认 API 基础路径（空串表示同源） */
const DEFAULT_API_BASE = "";

// ─────────────────────────────────────────────────────────────
// 工厂函数
// ─────────────────────────────────────────────────────────────

export type CloudRecordingRepositoryOptions = {
  /** API 基础 URL，默认空串（同源）。测试中可传入 mock 地址 */
  apiBase?: string;
};

/**
 * 创建 CloudRecordingRepository 实例
 *
 * owner token 在首次调用 getOwnerToken() 时自动生成并持久化到 localStorage，
 * 该 token 用于标识当前匿名 owner，上传的录制归属于此 owner。
 */
export function createCloudRecordingRepository(
  options: CloudRecordingRepositoryOptions = {},
): CloudRecordingRepository {
  const apiBase = options.apiBase ?? DEFAULT_API_BASE;
  let inMemoryOwnerToken: string | null = null;

  const repo: CloudRecordingRepository = {
    // ── 创建上传会话 ──────────────────────────────────────
    async createUploadSession(input: CreateUploadSessionRequest) {
      const token = repo.getOwnerToken();
      try {
        const response = await fetch(`${apiBase}/api/recordings/upload-sessions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-owner-token": token,
          },
          body: JSON.stringify(input),
        });
        return handleJsonResponse<CreateUploadSessionResponse>(response);
      } catch (err) {
        return { ok: false, error: networkError("create upload session failed", err) };
      }
    },

    // ── 上传单个资产（PUT，支持进度回调） ──────────────────
    async uploadAsset(
      target: UploadTarget,
      blob: Blob,
      onProgress?: (progress: UploadProgress) => void,
      timeoutMs?: number,
    ): Promise<CloudResult<void>> {
      const totalBytes = blob.size;
      // 上报初始进度（0 字节）
      onProgress?.({
        bytesUploaded: 0,
        totalBytes,
        currentAssetKind: target.kind,
      });

      try {
        await putBlobWithProgress(target.url, blob, target.headers, (bytesUploaded) => {
          onProgress?.({
            bytesUploaded,
            totalBytes,
            currentAssetKind: target.kind,
          });
        }, timeoutMs);
        return { ok: true, value: undefined };
      } catch (err) {
        return {
          ok: false,
          error: networkError("asset upload failed", err),
        };
      }
    },

    // ── 完成上传 ──────────────────────────────────────────
    async completeUpload(
      sessionId: string,
      input: CompleteUploadSessionRequest,
    ): Promise<CloudResult<CompleteUploadSessionResponse>> {
      const token = repo.getOwnerToken();
      try {
        const response = await fetch(
          `${apiBase}/api/recordings/upload-sessions/${encodeURIComponent(sessionId)}/complete`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-owner-token": token,
            },
            body: JSON.stringify(input),
          },
        );
        return handleJsonResponse<CompleteUploadSessionResponse>(response);
      } catch (err) {
        return { ok: false, error: networkError("complete upload failed", err) };
      }
    },

    // ── 查询录制详情 ──────────────────────────────────────
    async get(recordingId: string): Promise<CloudResult<CloudRecordingDetailResponse>> {
      const token = repo.getOwnerToken();
      try {
        const response = await fetch(
          `${apiBase}/api/recordings/${encodeURIComponent(recordingId)}`,
          {
            method: "GET",
            headers: { "x-owner-token": token },
          },
        );
        return handleJsonResponse<CloudRecordingDetailResponse>(response);
      } catch (err) {
        return { ok: false, error: networkError("get recording failed", err) };
      }
    },

    // ── 查询录制列表 ──────────────────────────────────────
    async list(input: ListRecordingsInput = {}): Promise<CloudResult<ListRecordingsResponse>> {
      const token = repo.getOwnerToken();
      const query = buildListQuery(input);
      try {
        const response = await fetch(
          `${apiBase}/api/recordings${query}`,
          {
            method: "GET",
            headers: { "x-owner-token": token },
          },
        );
        return handleJsonResponse<ListRecordingsResponse>(response);
      } catch (err) {
        return { ok: false, error: networkError("list recordings failed", err) };
      }
    },

    // ── 获取云端播放描述 ──────────────────────────────────
    async getPlaybackDescriptor(
      recordingId: string,
    ): Promise<CloudResult<CloudPlaybackDescriptor>> {
      const token = repo.getOwnerToken();
      try {
        const response = await fetch(
          `${apiBase}/api/recordings/${encodeURIComponent(recordingId)}/playback`,
          {
            method: "GET",
            headers: { "x-owner-token": token },
          },
        );
        return handleJsonResponse<CloudPlaybackDescriptor>(response);
      } catch (err) {
        return { ok: false, error: networkError("get playback descriptor failed", err) };
      }
    },

    // ── 创建分享链接 ──────────────────────────────────────
    async createShareLink(
      recordingId: string,
      input: CreateShareLinkRequest,
    ): Promise<CloudResult<CreateShareLinkResponse>> {
      const token = repo.getOwnerToken();
      try {
        const response = await fetch(
          `${apiBase}/api/recordings/${encodeURIComponent(recordingId)}/share-links`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-owner-token": token,
            },
            body: JSON.stringify(input),
          },
        );
        return handleJsonResponse<CreateShareLinkResponse>(response);
      } catch (err) {
        return { ok: false, error: networkError("create share link failed", err) };
      }
    },

    // ── 通过分享 token 获取播放描述 ───────────────────────
    async getSharedPlaybackDescriptor(
      token: string,
    ): Promise<CloudResult<CloudPlaybackDescriptor>> {
      try {
        const response = await fetch(
          `${apiBase}/api/share/${encodeURIComponent(token)}/playback`,
          { method: "GET" },
        );
        return handleJsonResponse<CloudPlaybackDescriptor>(response);
      } catch (err) {
        return { ok: false, error: networkError("get shared playback descriptor failed", err) };
      }
    },

    // ── 重命名云端录制 ────────────────────────────────────
    async rename(recordingId: string, title: string): Promise<CloudResult<void>> {
      const token = repo.getOwnerToken();
      try {
        const response = await fetch(
          `${apiBase}/api/recordings/${encodeURIComponent(recordingId)}`,
          {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "x-owner-token": token,
            },
            body: JSON.stringify({ title }),
          },
        );
        return handleVoidResponse(response);
      } catch (err) {
        return { ok: false, error: networkError("rename recording failed", err) };
      }
    },

    // ── 软删除云端录制 ────────────────────────────────────
    async remove(recordingId: string): Promise<CloudResult<void>> {
      const token = repo.getOwnerToken();
      try {
        const response = await fetch(
          `${apiBase}/api/recordings/${encodeURIComponent(recordingId)}`,
          {
            method: "DELETE",
            headers: { "x-owner-token": token },
          },
        );
        return handleVoidResponse(response);
      } catch (err) {
        return { ok: false, error: networkError("delete recording failed", err) };
      }
    },

    // ── 一步上传完整 RecordingPackageV1 ──────────────────
    async uploadPackage(
      pkg: RecordingPackageV1,
      blobs: { media?: Blob; thumbnail?: Blob },
      options?: { idempotencyKey?: string; onProgress?: (progress: UploadProgress) => void; timeoutMs?: number },
    ): Promise<CloudResult<{ recordingId: string; status: string }>> {
      // 0. 校验：含媒体录制必须提供 media blob，否则会创建与本地包不一致的云端记录
      if (pkg.media && !blobs.media) {
        return {
          ok: false,
          error: {
            code: "network-error",
            message: "Recording package has media but no media blob was provided",
          },
        };
      }

      const onProgress = options?.onProgress;
      const idempotencyKey = options?.idempotencyKey ?? pkg.manifest.packageId;

      // 1. 序列化 JSON 资产并计算 sha256 / size
      let assetDefs: Awaited<ReturnType<typeof buildPackageAssetDefs>>;
      try {
        assetDefs = await buildPackageAssetDefs(pkg, blobs);
      } catch (err) {
        return {
          ok: false,
          error: {
            code: "network-error",
            message: `prepare upload assets failed: ${formatError(err)}`,
          },
        };
      }

      // 2. 创建上传会话
      const sessionInput: CreateUploadSessionRequest = {
        idempotencyKey,
        localPackageId: pkg.manifest.packageId,
        title: pkg.meta.title,
        schemaVersion: pkg.manifest.schemaVersion,
        durationMs: pkg.meta.durationMs,
        initialLanguage: pkg.meta.initialLanguage,
        hasAudio: pkg.media?.hasAudio ?? false,
        hasCamera: pkg.media?.hasCamera ?? false,
        assets: assetDefs.map((a) => ({
          kind: a.kind,
          sha256: a.sha256,
          sizeBytes: a.sizeBytes,
          mimeType: a.mimeType,
        })),
      };
      const sessionResult = await repo.createUploadSession(sessionInput);
      if (!sessionResult.ok) return sessionResult;
      const { sessionId, recordingId, uploadTargets } = sessionResult.value;

      // 3. 按 target 上传各资产
      const totalBytes = assetDefs.reduce((sum, a) => sum + a.sizeBytes, 0);
      let bytesUploaded = 0;
      const uploadedAssets: { kind: RecordingAssetKind; sha256: string; sizeBytes: number }[] = [];

      // 构建 kind → blob 映射
      const blobByKind = new Map<string, Blob>();
      for (const asset of assetDefs) {
        blobByKind.set(asset.kind, asset.blob);
      }

      for (const target of uploadTargets) {
        const blob = blobByKind.get(target.kind);
        if (!blob) {
          return {
            ok: false,
            error: {
              code: "network-error",
              message: `missing blob for upload target kind: ${target.kind}`,
            },
          };
        }

        const completedBytesBeforeAsset = bytesUploaded;
        const assetResult = await repo.uploadAsset(target, blob, (p) => {
          onProgress?.({
            bytesUploaded: completedBytesBeforeAsset + p.bytesUploaded,
            totalBytes,
            currentAssetKind: p.currentAssetKind,
          });
        }, options?.timeoutMs);
        if (!assetResult.ok) return assetResult;

        // 资产上传完成，累加进度
        const def = assetDefs.find((a) => a.kind === target.kind);
        if (def) bytesUploaded += def.sizeBytes;

        uploadedAssets.push({
          kind: target.kind,
          sha256: assetDefs.find((a) => a.kind === target.kind)!.sha256,
          sizeBytes: assetDefs.find((a) => a.kind === target.kind)!.sizeBytes,
        });
      }

      // 4. complete
      const completeResult = await repo.completeUpload(sessionId, { uploadedAssets });
      if (!completeResult.ok) return completeResult;

      return {
        ok: true,
        value: { recordingId, status: completeResult.value.status },
      };
    },

    // ── 状态轮询 ──────────────────────────────────────────
    async pollUntilReady(
      recordingId: string,
      options?: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal },
    ): Promise<CloudResult<CloudRecordingDetailResponse>> {
      const intervalMs = options?.intervalMs ?? 3000;
      const timeoutMs = options?.timeoutMs ?? 10 * 60 * 1000;
      const signal = options?.signal;
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        if (signal?.aborted) {
          return {
            ok: false,
            error: { code: "network-error", message: "poll cancelled" },
          };
        }

        const result = await repo.get(recordingId);
        if (!result.ok) return result;

        const { status } = result.value.recording;
        if (status === "ready") {
          return result;
        }
        if (status === "failed") {
          return result;
        }

        // 等待下一个轮询间隔
        await sleep(Math.min(intervalMs, deadline - Date.now()));
      }

      return {
        ok: false,
        error: {
          code: "network-error",
          message: `poll timed out after ${timeoutMs}ms for recording ${recordingId}`,
        },
      };
    },

    // ── owner token 管理 ──────────────────────────────────
    getOwnerToken(): string {
      // 1. 优先从 localStorage 读取
      const existing = readOwnerToken();
      if (existing) {
        inMemoryOwnerToken = existing;
        return existing;
      }
      // 2. localStorage 不可用时复用实例内缓存的 token
      if (inMemoryOwnerToken) return inMemoryOwnerToken;
      // 3. 生成新 token 并同时写入内存和尝试持久化
      const token = generateOwnerToken();
      inMemoryOwnerToken = token;
      persistOwnerToken(token);
      return token;
    },
  };

  return repo;
}

function buildListQuery(input: ListRecordingsInput): string {
  const params = new URLSearchParams();
  if (input.cursor) params.set("cursor", input.cursor);
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  const query = params.toString();
  return query ? `?${query}` : "";
}

// ─────────────────────────────────────────────────────────────
// 内部工具函数
// ─────────────────────────────────────────────────────────────

/**
 * 解析 API JSON 响应，区分成功与错误。
 * 后端错误响应格式：{ error: { code, message, requestId, details? } }
 */
async function handleJsonResponse<T>(response: Response): Promise<CloudResult<T>> {
  if (!response.ok) {
    return parseApiError(response);
  }
  try {
    const value = (await response.json()) as T;
    return { ok: true, value };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "network-error",
        message: `failed to parse response JSON: ${formatError(err)}`,
      },
    };
  }
}

async function handleVoidResponse(response: Response): Promise<CloudResult<void>> {
  if (!response.ok) {
    return parseApiError(response);
  }
  return { ok: true, value: undefined };
}

/** 从非 2xx 响应中解析结构化错误 */
async function parseApiError<T>(response: Response): Promise<CloudResult<T>> {
  const requestId = response.headers.get("x-request-id") ?? undefined;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string; details?: unknown } };
    if (body?.error && typeof body.error.code === "string") {
      return {
        ok: false,
        error: {
          code: body.error.code as CloudApiError["code"],
          message: body.error.message ?? "unknown error",
          requestId,
          details: body.error.details,
        },
      };
    }
  } catch {
    // 响应体不是 JSON，使用 HTTP 状态文本
  }
  return {
    ok: false,
    error: {
      code: "network-error",
      message: `API error ${response.status}: ${response.statusText}`,
      requestId,
    },
  };
}

/** 构造网络错误 */
function networkError(context: string, err: unknown): CloudApiError {
  return {
    code: "network-error",
    message: `${context}: ${formatError(err)}`,
  };
}

/** 格式化异常信息为可展示文本 */
function formatError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  return "unknown error";
}

// ─────────────────────────────────────────────────────────────
// RecordingPackageV1 资产序列化
// ─────────────────────────────────────────────────────────────

type AssetDef = {
  kind: RecordingAssetKind;
  blob: Blob;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
};

async function buildPackageAssetDefs(
  pkg: RecordingPackageV1,
  blobs: { media?: Blob; thumbnail?: Blob },
): Promise<AssetDef[]> {
  const defs: AssetDef[] = [];

  // manifest
  const manifestStr = canonicalStringify(pkg.manifest);
  defs.push(await buildJsonAsset("manifest", manifestStr));

  // meta
  defs.push(await buildJsonAsset("meta", canonicalStringify(pkg.meta)));

  // events
  defs.push(await buildJsonAsset("events", canonicalStringify(pkg.events)));

  // snapshots
  defs.push(await buildJsonAsset("snapshots", canonicalStringify(pkg.snapshots)));

  // indexes（可选）
  if (pkg.indexes) {
    defs.push(await buildJsonAsset("indexes", canonicalStringify(pkg.indexes)));
  }

  // media（二进制，由调用方提供）
  if (blobs.media) {
    const sha256 = await sha256Blob(blobs.media);
    defs.push({
      kind: "media",
      blob: blobs.media,
      sha256,
      sizeBytes: blobs.media.size,
      mimeType: blobs.media.type || pkg.media?.mimeType || "video/webm",
    });
  }

  // thumbnail（二进制，可选）
  if (blobs.thumbnail) {
    const sha256 = await sha256Blob(blobs.thumbnail);
    defs.push({
      kind: "thumbnail",
      blob: blobs.thumbnail,
      sha256,
      sizeBytes: blobs.thumbnail.size,
      mimeType: blobs.thumbnail.type || "image/webp",
    });
  }

  return defs;
}

async function buildJsonAsset(kind: RecordingAssetKind, json: string): Promise<AssetDef> {
  const sha256 = await sha256Hex(json);
  const blob = new Blob([json], { type: "application/json" });
  return { kind, blob, sha256, sizeBytes: blob.size, mimeType: "application/json" };
}

async function sha256Blob(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(buffer));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// ─────────────────────────────────────────────────────────────
// 上传进度（XMLHttpRequest）
// ─────────────────────────────────────────────────────────────

/**
 * 使用 XMLHttpRequest 发送 PUT 请求，通过 upload.onprogress 上报字节进度。
 *
 * 选择 XHR 而非 fetch 是因为 fetch 目前不提供上传进度事件，
 * 而 CloudRecordingRepository 的接口需求明确要求支持进度回调。
 */
function putBlobWithProgress(
  url: string,
  blob: Blob,
  headers: Record<string, string>,
  onBytes: (uploaded: number) => void,
  timeoutMs = 30_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.timeout = timeoutMs;

    // 设置自定义请求头（由签名 URL 指定）
    for (const [key, value] of Object.entries(headers)) {
      xhr.setRequestHeader(key, value);
    }

    xhr.upload.onprogress = (event: ProgressEvent) => {
      if (event.lengthComputable && event.loaded > 0) {
        onBytes(event.loaded);
      }
    };

    xhr.onload = () => {
      // 2xx 状态码视为成功
      if (xhr.status >= 200 && xhr.status < 300) {
        onBytes(blob.size);
        resolve();
      } else {
        reject(
          new Error(
            `PUT ${url} returned ${xhr.status}${xhr.statusText ? `: ${xhr.statusText}` : ""}`,
          ),
        );
      }
    };

    xhr.onerror = () => {
      reject(new Error(`PUT ${url} network error`));
    };

    xhr.ontimeout = () => {
      reject(new Error(`PUT ${url} timed out`));
    };

    xhr.send(blob);
  });
}

// ─────────────────────────────────────────────────────────────
// owner token 持久化
// ─────────────────────────────────────────────────────────────

function readOwnerToken(): string | null {
  try {
    if (typeof localStorage !== "undefined") {
      const token = localStorage.getItem(OWNER_TOKEN_KEY);
      if (token && OWNER_TOKEN_PATTERN.test(token)) {
        return token.toLowerCase();
      }
    }
  } catch {
    // localStorage 不可用（如无痕模式或 SSR），返回 null
  }
  return null;
}

function persistOwnerToken(token: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(OWNER_TOKEN_KEY, token);
    }
  } catch {
    // localStorage 不可用时静默忽略，token 仅在内存中有效
  }
}

/**
 * 生成安全的随机 owner token（hex 编码）。
 * 在浏览器和 jsdom 环境中使用 crypto.getRandomValues。
 */
function generateOwnerToken(): string {
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
    const bytes = new Uint8Array(OWNER_TOKEN_BYTES);
    globalThis.crypto.getRandomValues(bytes);
    return toHex(bytes);
  }
  // 回退：伪随机（仅在不支持 crypto 的环境中触发）
  let hex = "";
  for (let i = 0; i < OWNER_TOKEN_BYTES; i++) {
    hex += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0");
  }
  return hex;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}
