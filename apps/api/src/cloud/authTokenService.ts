import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { CloudResult } from "./types.js";

/**
 * AuthTokenService — 短期签名 access token 的签发与校验。
 *
 * 设计（见 issue #231，技术方案「登录体系」待确认问题，保持匿名设备身份）：
 * - 长期 refresh token = 前端持久化的设备 token（仅发往 /api/auth/token）。
 * - 短期 access token = `payload.signature`，payload 为 base64url(JSON {ownerId, iat, exp})，
 *   signature 为 HMAC-SHA256(payload, 服务端密钥) 的 base64url。
 * - ownerId 直接取自 refresh token，使既有录制归属保持稳定。
 * - 不引入账号/密码/OAuth；仅做令牌轮换这一安全加固。
 */

export const DEFAULT_ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const MIN_REFRESH_TOKEN_LENGTH = 8;
const MAX_REFRESH_TOKEN_LENGTH = 512;

export type AccessTokenPayload = {
  ownerId: string;
  /** issued-at, epoch ms */
  iat: number;
  /** expires-at, epoch ms */
  exp: number;
};

export type IssuedAccessToken = {
  accessToken: string;
  expiresAt: number;
  tokenType: "Bearer";
};

export type AuthTokenService = {
  /** 用长期 refresh token（设备 token）换取短期 access token。 */
  issueFromRefreshToken(refreshToken: string, nowMs?: number): CloudResult<IssuedAccessToken>;
  /** 校验 access token 签名与过期，返回 ownerId。 */
  verifyAccessToken(accessToken: string, nowMs?: number): CloudResult<AccessTokenPayload>;
};

export type AuthTokenServiceOptions = {
  /** HMAC 密钥；缺省时进程内随机生成（满足 Demo，重启后旧 token 失效）。 */
  secret?: string;
  /** access token 存活时长，默认 15 分钟。 */
  accessTokenTtlMs?: number;
  /** 时间源，便于测试。 */
  now?: () => number;
};

export function createAuthTokenService(options: AuthTokenServiceOptions = {}): AuthTokenService {
  const secret = options.secret && options.secret.length > 0
    ? options.secret
    : randomBytes(32).toString("hex");
  const ttlMs = options.accessTokenTtlMs ?? DEFAULT_ACCESS_TOKEN_TTL_MS;
  const now = options.now ?? (() => Date.now());

  const sign = (payloadSegment: string): string =>
    createHmac("sha256", secret).update(payloadSegment).digest("base64url");

  return {
    issueFromRefreshToken(refreshToken, nowMs) {
      const trimmed = typeof refreshToken === "string" ? refreshToken.trim() : "";
      if (
        trimmed.length < MIN_REFRESH_TOKEN_LENGTH ||
        trimmed.length > MAX_REFRESH_TOKEN_LENGTH
      ) {
        return {
          ok: false,
          error: { code: "unauthorized", message: "invalid refresh token" },
        };
      }
      const issuedAt = nowMs ?? now();
      const expiresAt = issuedAt + ttlMs;
      const payload: AccessTokenPayload = { ownerId: trimmed, iat: issuedAt, exp: expiresAt };
      const payloadSegment = encodePayload(payload);
      const accessToken = `${payloadSegment}.${sign(payloadSegment)}`;
      return { ok: true, value: { accessToken, expiresAt, tokenType: "Bearer" } };
    },

    verifyAccessToken(accessToken, nowMs) {
      const token = typeof accessToken === "string" ? accessToken.trim() : "";
      const dotIndex = token.indexOf(".");
      if (dotIndex <= 0 || dotIndex === token.length - 1) {
        return unauthorized();
      }
      const payloadSegment = token.slice(0, dotIndex);
      const signatureSegment = token.slice(dotIndex + 1);
      const expectedSignature = sign(payloadSegment);
      if (!constantTimeEquals(signatureSegment, expectedSignature)) {
        return unauthorized();
      }
      const payload = decodePayload(payloadSegment);
      if (!payload) return unauthorized();
      if ((nowMs ?? now()) >= payload.exp) {
        return { ok: false, error: { code: "unauthorized", message: "access token expired" } };
      }
      return { ok: true, value: payload };
    },
  };
}

function encodePayload(payload: AccessTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(segment: string): AccessTokenPayload | null {
  try {
    const json = Buffer.from(segment, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as AccessTokenPayload).ownerId === "string" &&
      (parsed as AccessTokenPayload).ownerId.length > 0 &&
      Number.isFinite((parsed as AccessTokenPayload).iat) &&
      Number.isFinite((parsed as AccessTokenPayload).exp)
    ) {
      return parsed as AccessTokenPayload;
    }
    return null;
  } catch {
    return null;
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

function unauthorized(): CloudResult<never> {
  return { ok: false, error: { code: "unauthorized", message: "invalid access token" } };
}
