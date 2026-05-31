import type { CloudRecordingService } from "../cloud/cloudRecordingService.js";
import { createAuthTokenService, type AuthTokenService } from "../cloud/authTokenService.js";
import { parseIsoUtcInstantMs } from "../cloud/isoDate.js";
import { RECORDING_ASSET_KINDS } from "../cloud/types.js";
import type {
  CloudApiError,
  CloudApiErrorCode,
  CloudResult,
  CompleteUploadSessionRequest,
  CreateShareLinkRequest,
  CreateUploadSessionRequest,
  RecordingAssetKind,
  RenameRecordingRequest,
} from "../cloud/types.js";

export type CloudApiHandler = (request: Request) => Promise<Response>;

const STATUS_BY_ERROR: Record<CloudApiErrorCode, number> = {
  "bad-request": 400,
  unauthorized: 401,
  forbidden: 403,
  "not-found": 404,
  "upload-session-expired": 410,
  "upload-session-conflict": 409,
  "unsupported-schema": 422,
  "invalid-manifest": 422,
  "invalid-event": 422,
  "checksum-mismatch": 422,
  "quota-exceeded": 413,
  "media-type-not-supported": 415,
  "rate-limited": 429,
};
const RECORDING_ASSET_KIND_SET = new Set<string>(RECORDING_ASSET_KINDS);
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
// POST .../complete 请求体严格字段白名单：只允许这些 key
const COMPLETE_TOP_KEYS = new Set(["uploadedAssets"]);
const COMPLETE_ASSET_KEYS = new Set(["kind", "sha256", "sizeBytes"]);
const SHARE_TOP_KEYS = new Set(["expiresAt", "startTimeMs"]);

export function createCloudApiHandler(deps: {
  service: CloudRecordingService;
  auth?: AuthTokenService;
  createRequestId?: () => string;
}): CloudApiHandler {
  const createRequestId = deps.createRequestId ?? (() => crypto.randomUUID());
  // auth 始终可用：未显式注入时默认构造（密钥取自 CODE_TAPE_AUTH_SECRET，缺省进程内随机），
  // 保证 /api/auth/token 端点对所有装配点都存在，避免新客户端因缺省 auth 而拿到 404。
  const auth = deps.auth ?? createAuthTokenService({ secret: process.env.CODE_TAPE_AUTH_SECRET });
  const resolveOwnerId = (request: Request): string | null => readOwnerId(request, auth);

  return async (request: Request): Promise<Response> => {
    const requestId = createRequestId();
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/auth/token") {
      const parsed = await readJsonObject(request);
      if (!parsed.ok) return jsonError({ ...parsed.error, requestId }, requestId);
      const refreshToken = parsed.value.refreshToken;
      if (typeof refreshToken !== "string") {
        return jsonError(
          { code: "bad-request", message: "refreshToken must be a string", requestId },
          requestId,
        );
      }
      const issued = auth.issueFromRefreshToken(refreshToken);
      if (!issued.ok) return jsonError({ ...issued.error, requestId }, requestId);
      return jsonResponse(issued.value, 200, requestId);
    }

    if (request.method === "GET" && url.pathname === "/api/recordings") {
      const ownerId = resolveOwnerId(request);
      if (!ownerId) {
        return jsonError(
          { code: "unauthorized", message: "missing owner token", requestId },
          requestId,
        );
      }
      const listParams = parseListRecordingsQuery(url.searchParams);
      if (!listParams.ok) return jsonError({ ...listParams.error, requestId }, requestId);
      const result = await deps.service.listRecordings({ ownerId, ...listParams.value });
      if (!result.ok) return jsonError({ ...result.error, requestId }, requestId);
      return jsonResponse(result.value, 200, requestId);
    }

    const playbackMatch = url.pathname.match(/^\/api\/recordings\/([^/]+)\/playback$/);
    if (request.method === "GET" && playbackMatch) {
      const ownerId = resolveOwnerId(request);
      if (!ownerId) {
        return jsonError(
          { code: "unauthorized", message: "missing owner token", requestId },
          requestId,
        );
      }
      const recordingId = safeDecodePathSegment(playbackMatch[1]!);
      if (!recordingId.ok) {
        return jsonError({ ...recordingId.error, requestId }, requestId);
      }
      const result = await deps.service.getPlaybackDescriptor({
        ownerId,
        recordingId: recordingId.value,
      });
      if (!result.ok) return jsonError({ ...result.error, requestId }, requestId);
      return jsonResponse(result.value, 200, requestId);
    }

    const sharedPlaybackMatch = url.pathname.match(/^\/api\/share\/([^/]+)\/playback$/);
    if (request.method === "GET" && sharedPlaybackMatch) {
      const token = safeDecodePathSegment(sharedPlaybackMatch[1]!, "share token");
      if (!token.ok) {
        return jsonError(
          { code: "not-found", message: "share link not found", requestId },
          requestId,
        );
      }
      const result = await deps.service.getSharedPlaybackDescriptor({ token: token.value });
      if (!result.ok) return jsonError({ ...result.error, requestId }, requestId);
      return jsonResponse(result.value, 200, requestId);
    }

    const shareLinkMatch = url.pathname.match(/^\/api\/recordings\/([^/]+)\/share-links$/);
    if (request.method === "POST" && shareLinkMatch) {
      const ownerId = resolveOwnerId(request);
      if (!ownerId) {
        return jsonError(
          { code: "unauthorized", message: "missing owner token", requestId },
          requestId,
        );
      }
      const recordingId = safeDecodePathSegment(shareLinkMatch[1]!);
      if (!recordingId.ok) {
        return jsonError({ ...recordingId.error, requestId }, requestId);
      }
      const parsed = await readJsonObject(request);
      if (!parsed.ok) return jsonError({ ...parsed.error, requestId }, requestId);
      const input = parseCreateShareLinkRequest(parsed.value);
      if (!input.ok) return jsonError({ ...input.error, requestId }, requestId);
      const result = await deps.service.createShareLink({
        ownerId,
        recordingId: recordingId.value,
        input: input.value,
      });
      if (!result.ok) return jsonError({ ...result.error, requestId }, requestId);
      return jsonResponse(result.value, 201, requestId);
    }

    const recordingDetailMatch = url.pathname.match(/^\/api\/recordings\/([^/]+)$/);
    if (request.method === "GET" && recordingDetailMatch) {
      const ownerId = resolveOwnerId(request);
      if (!ownerId) {
        return jsonError(
          { code: "unauthorized", message: "missing owner token", requestId },
          requestId,
        );
      }
      const recordingId = safeDecodePathSegment(recordingDetailMatch[1]!);
      if (!recordingId.ok) {
        return jsonError({ ...recordingId.error, requestId }, requestId);
      }
      const result = await deps.service.getRecording({
        ownerId,
        recordingId: recordingId.value,
      });
      if (!result.ok) return jsonError({ ...result.error, requestId }, requestId);
      return jsonResponse(result.value, 200, requestId);
    }

    if (request.method === "PATCH" && recordingDetailMatch) {
      const ownerId = resolveOwnerId(request);
      if (!ownerId) {
        return jsonError(
          { code: "unauthorized", message: "missing owner token", requestId },
          requestId,
        );
      }
      const recordingId = safeDecodePathSegment(recordingDetailMatch[1]!);
      if (!recordingId.ok) {
        return jsonError({ ...recordingId.error, requestId }, requestId);
      }
      const parsed = await readJsonObject(request);
      if (!parsed.ok) return jsonError({ ...parsed.error, requestId }, requestId);
      const input = parseRenameRecordingRequest(parsed.value);
      if (!input.ok) return jsonError({ ...input.error, requestId }, requestId);
      const result = await deps.service.renameRecording({
        ownerId,
        recordingId: recordingId.value,
        input: input.value,
      });
      if (!result.ok) return jsonError({ ...result.error, requestId }, requestId);
      return jsonResponse(result.value, 200, requestId);
    }

    if (request.method === "DELETE" && recordingDetailMatch) {
      const ownerId = resolveOwnerId(request);
      if (!ownerId) {
        return jsonError(
          { code: "unauthorized", message: "missing owner token", requestId },
          requestId,
        );
      }
      const recordingId = safeDecodePathSegment(recordingDetailMatch[1]!);
      if (!recordingId.ok) {
        return jsonError({ ...recordingId.error, requestId }, requestId);
      }
      const result = await deps.service.deleteRecording({
        ownerId,
        recordingId: recordingId.value,
      });
      if (!result.ok) return jsonError({ ...result.error, requestId }, requestId);
      return jsonResponse(result.value, 200, requestId);
    }

    if (request.method === "POST" && url.pathname === "/api/recordings/upload-sessions") {
      const ownerId = resolveOwnerId(request);
      if (!ownerId) {
        return jsonError(
          { code: "unauthorized", message: "missing owner token", requestId },
          requestId,
        );
      }
      const parsed = await readJsonObject(request);
      if (!parsed.ok) return jsonError({ ...parsed.error, requestId }, requestId);
      const input = parseCreateUploadSessionRequest(parsed.value);
      if (!input.ok) return jsonError({ ...input.error, requestId }, requestId);
      const result = await deps.service.createUploadSession({ ownerId, input: input.value });
      if (!result.ok) return jsonError({ ...result.error, requestId }, requestId);
      return jsonResponse(result.value, 201, requestId);
    }

    // POST /api/recordings/upload-sessions/:sessionId/complete — 上传完成确认
    const completeMatch = url.pathname.match(
      /^\/api\/recordings\/upload-sessions\/([^/]+)\/complete$/,
    );
    if (request.method === "POST" && completeMatch) {
      const sessionId = completeMatch[1]!;
      const ownerId = resolveOwnerId(request);
      if (!ownerId) {
        return jsonError(
          { code: "unauthorized", message: "missing owner token", requestId },
          requestId,
        );
      }
      const parsed = await readJsonObject(request);
      if (!parsed.ok) return jsonError({ ...parsed.error, requestId }, requestId);
      const input = parseCompleteUploadSessionRequest(parsed.value);
      if (!input.ok) return jsonError({ ...input.error, requestId }, requestId);
      const result = await deps.service.completeUpload({ ownerId, sessionId, input: input.value });
      if (!result.ok) return jsonError({ ...result.error, requestId }, requestId);
      return jsonResponse(result.value, 200, requestId);
    }

    return jsonError({ code: "not-found", message: "route not found", requestId }, requestId);
  };
}

async function readJsonObject(
  request: Request,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: CloudApiError }> {
  try {
    const value = (await request.json()) as unknown;
    if (!isJsonObject(value)) {
      return { ok: false, error: badRequestError() };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, error: badRequestError() };
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function badRequestError(message = "request body must be a valid JSON object"): CloudApiError {
  return { code: "bad-request", message };
}

function parseListRecordingsQuery(
  searchParams: URLSearchParams,
): CloudResult<{ cursor?: string; limit?: number }> {
  const cursorParam = searchParams.get("cursor")?.trim();
  const limitParam = searchParams.get("limit");
  if (limitParam === null) {
    return {
      ok: true,
      value: cursorParam ? { cursor: cursorParam } : {},
    };
  }
  if (!/^\d+$/u.test(limitParam)) {
    return { ok: false, error: badRequestError() };
  }
  const limit = Number(limitParam);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return { ok: false, error: badRequestError() };
  }
  return {
    ok: true,
    value: {
      ...(cursorParam ? { cursor: cursorParam } : {}),
      limit,
    },
  };
}

function parseCreateUploadSessionRequest(
  value: Record<string, unknown>,
): CloudResult<CreateUploadSessionRequest> {
  if (
    !isString(value.idempotencyKey) ||
    !isString(value.localPackageId) ||
    !isString(value.title) ||
    !isString(value.schemaVersion) ||
    !isFiniteNumber(value.durationMs) ||
    !isString(value.initialLanguage) ||
    typeof value.hasAudio !== "boolean" ||
    typeof value.hasCamera !== "boolean" ||
    !Array.isArray(value.assets)
  ) {
    return { ok: false, error: badRequestError() };
  }

  const assets: CreateUploadSessionRequest["assets"] = [];
  for (const asset of value.assets) {
    if (
      !isJsonObject(asset) ||
      !isString(asset.kind) ||
      !isRecordingAssetKind(asset.kind) ||
      !isString(asset.sha256) ||
      !SHA256_HEX_PATTERN.test(asset.sha256) ||
      !isPositiveSafeInteger(asset.sizeBytes) ||
      !isString(asset.mimeType) ||
      asset.mimeType.trim().length < 1
    ) {
      return { ok: false, error: badRequestError() };
    }
    assets.push({
      kind: asset.kind,
      sha256: asset.sha256,
      sizeBytes: asset.sizeBytes,
      mimeType: asset.mimeType,
    });
  }

  return {
    ok: true,
    value: {
      idempotencyKey: value.idempotencyKey,
      localPackageId: value.localPackageId,
      title: value.title,
      schemaVersion: value.schemaVersion as CreateUploadSessionRequest["schemaVersion"],
      durationMs: value.durationMs,
      initialLanguage: value.initialLanguage as CreateUploadSessionRequest["initialLanguage"],
      hasAudio: value.hasAudio,
      hasCamera: value.hasCamera,
      assets,
    },
  };
}

// POST /api/recordings/upload-sessions/:sessionId/complete 请求体校验
// 严格遵循契约：只接收 uploadedAssets: [{ kind, sha256, sizeBytes }]
function parseCompleteUploadSessionRequest(
  value: Record<string, unknown>,
): CloudResult<CompleteUploadSessionRequest> {
  // 顶层 key 白名单校验：拒绝任何契约外字段
  for (const key of Object.keys(value)) {
    if (!COMPLETE_TOP_KEYS.has(key)) {
      return { ok: false, error: badRequestError() };
    }
  }
  if (!Array.isArray(value.uploadedAssets)) {
    return { ok: false, error: badRequestError() };
  }

  const uploadedAssets: CompleteUploadSessionRequest["uploadedAssets"] = [];
  for (const asset of value.uploadedAssets) {
    if (
      !isJsonObject(asset) ||
      !isString(asset.kind) ||
      !isRecordingAssetKind(asset.kind) ||
      !isString(asset.sha256) ||
      !SHA256_HEX_PATTERN.test(asset.sha256) ||
      !isPositiveSafeInteger(asset.sizeBytes)
    ) {
      return { ok: false, error: badRequestError() };
    }
    // asset 内字段白名单校验：拒绝 kind / sha256 / sizeBytes 之外的字段
    for (const key of Object.keys(asset)) {
      if (!COMPLETE_ASSET_KEYS.has(key)) {
        return { ok: false, error: badRequestError() };
      }
    }
    uploadedAssets.push({
      kind: asset.kind,
      sha256: asset.sha256,
      sizeBytes: asset.sizeBytes,
    });
  }

  return {
    ok: true,
    value: { uploadedAssets },
  };
}

const RENAME_TOP_KEYS = new Set(["title"]);

function parseRenameRecordingRequest(
  value: Record<string, unknown>,
): CloudResult<RenameRecordingRequest> {
  for (const key of Object.keys(value)) {
    if (!RENAME_TOP_KEYS.has(key)) {
      return { ok: false, error: badRequestError(`unknown field: ${key}`) };
    }
  }
  if (!("title" in value)) {
    return { ok: false, error: badRequestError("title is required") };
  }
  if (!isString(value.title)) {
    return { ok: false, error: badRequestError("title must be a string") };
  }
  return { ok: true, value: { title: value.title } };
}

function parseCreateShareLinkRequest(
  value: Record<string, unknown>,
): CloudResult<CreateShareLinkRequest> {
  for (const key of Object.keys(value)) {
    if (!SHARE_TOP_KEYS.has(key)) {
      return { ok: false, error: badRequestError(`unknown field: ${key}`) };
    }
  }

  const input: CreateShareLinkRequest = {};
  if ("expiresAt" in value) {
    if (value.expiresAt === null) {
      input.expiresAt = null;
    } else if (isString(value.expiresAt) && parseIsoUtcInstantMs(value.expiresAt) !== null) {
      input.expiresAt = value.expiresAt;
    } else {
      return {
        ok: false,
        error: badRequestError("expiresAt must be an ISO date string or null"),
      };
    }
  }
  if ("startTimeMs" in value) {
    if (!isPositiveOrZeroSafeInteger(value.startTimeMs)) {
      return {
        ok: false,
        error: badRequestError("startTimeMs must be a non-negative safe integer"),
      };
    }
    input.startTimeMs = value.startTimeMs;
  }
  return { ok: true, value: input };
}

function isRecordingAssetKind(value: string): value is RecordingAssetKind {
  return RECORDING_ASSET_KIND_SET.has(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPositiveOrZeroSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readOwnerId(request: Request, auth: AuthTokenService): string | null {
  // 优先 Authorization: Bearer <accessToken>，验签 + 过期校验后取 ownerId。
  const authorization = request.headers.get("authorization")?.trim();
  if (authorization) {
    const match = /^Bearer\s+(.+)$/iu.exec(authorization);
    if (match) {
      const verified = auth.verifyAccessToken(match[1]!.trim());
      return verified.ok ? verified.value.ownerId : null;
    }
  }
  // 向后兼容：保留旧的 x-owner-token 直传路径（原样作为 ownerId），仅服务旧客户端。
  const token = request.headers.get("x-owner-token")?.trim();
  return token ? token : null;
}

function safeDecodePathSegment(segment: string, label = "recordingId"): CloudResult<string> {
  try {
    return { ok: true, value: decodeURIComponent(segment) };
  } catch {
    return {
      ok: false,
      error: { code: "bad-request", message: `${label} path segment is malformed` },
    };
  }
}

function jsonResponse(body: unknown, status: number, requestId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
    },
  });
}

function jsonError(error: CloudApiError, requestId: string): Response {
  return jsonResponse(
    {
      error: {
        code: error.code,
        message: error.message,
        requestId,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    },
    STATUS_BY_ERROR[error.code],
    requestId,
  );
}
