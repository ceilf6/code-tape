/*
 * CloudRecordingRepository 测试
 *
 * 覆盖：
 * - 成功上传完整流程（create session → PUT assets → complete → detail 查询）
 * - upload asset PUT 失败
 * - complete API 失败
 * - 录制 status 为 failed
 * - 无媒体录制上传
 * - 上传进度回调断言
 * - 网络/API 错误可展示，不吞异常
 * - owner token 持久化与数据隔离
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordingPackageV1 } from "@code-tape/recording-schema";
import type {
  CloudRecordingRepository,
  CreateUploadSessionRequest,
  UploadTarget,
  UploadProgress,
  CloudRecordingDetail,
  CloudRecordingDetailResponse,
  CloudRecordingListItem,
  CloudPlaybackDescriptor,
  ListRecordingsResponse,
} from "../types";
import { createCloudRecordingRepository } from "../cloudRecordingRepository";

// ─────────────────────────────────────────────────────────────
// 测试辅助工厂函数
// ─────────────────────────────────────────────────────────────

/** 构造一份最简 CreateUploadSessionRequest */
function makeCreateSessionRequest(overrides: Partial<CreateUploadSessionRequest> = {}): CreateUploadSessionRequest {
  return {
    idempotencyKey: "test-key-1",
    localPackageId: "local-pkg-1",
    title: "Test Recording",
    schemaVersion: "0.1.0",
    durationMs: 5000,
    initialLanguage: "javascript",
    hasAudio: true,
    hasCamera: true,
    assets: [
      { kind: "manifest", sha256: "a".repeat(64), sizeBytes: 256, mimeType: "application/json" },
      { kind: "meta", sha256: "b".repeat(64), sizeBytes: 512, mimeType: "application/json" },
      { kind: "events", sha256: "c".repeat(64), sizeBytes: 2048, mimeType: "application/json" },
      { kind: "snapshots", sha256: "d".repeat(64), sizeBytes: 1024, mimeType: "application/json" },
      { kind: "media", sha256: "e".repeat(64), sizeBytes: 50000, mimeType: "video/webm" },
    ],
    ...overrides,
  };
}

/** 构造 mock UploadTarget */
function makeUploadTarget(kind: string, url?: string): UploadTarget {
  return {
    kind: kind as UploadTarget["kind"],
    method: "PUT",
    url: url ?? `https://storage.example.com/recordings/rec-1/${kind}`,
    headers: { "content-type": "application/octet-stream", "x-amz-acl": "private" },
    maxSizeBytes: 100_000,
  };
}

/** 构造 session 响应 */
function makeSessionResponse(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "upl_1",
    recordingId: "rec_1",
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    uploadTargets: [
      makeUploadTarget("manifest"),
      makeUploadTarget("meta"),
      makeUploadTarget("events"),
      makeUploadTarget("snapshots"),
      makeUploadTarget("media"),
    ],
    ...overrides,
  };
}

/** 创建测试用的 Blob */
function makeBlob(content = "test content", type = "application/json"): Blob {
  return new Blob([content], { type });
}

function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("failed to read blob"));
    reader.readAsText(blob);
  });
}

/** 构造最小 RecordingPackageV1 用于 uploadPackage 测试 */
function makeMinimalPackage(opts: { hasMedia: boolean }): RecordingPackageV1 {
  return {
    schemaVersion: "0.1.0",
    manifest: {
      packageId: "pkg-test-1",
      schemaVersion: "0.1.0",
      status: "complete",
      createdAt: "2026-05-29T00:00:00.000Z",
      completedAt: "2026-05-29T00:05:00.000Z",
      checksums: {
        eventsSha256: "aa".repeat(32),
        snapshotsSha256: "bb".repeat(32),
      },
    },
    meta: {
      id: "meta-1",
      title: "Test Package",
      createdAt: "2026-05-29T00:00:00.000Z",
      durationMs: 5000,
      appVersion: "1.0.0",
      ownerId: null,
      creatorInfo: { displayName: "tester", source: "local" },
      initialLanguage: "javascript",
      initialFontSize: 14,
      initialTheme: "dark",
      mediaCapability: {
        audio: opts.hasMedia ? "available" : "not-found",
        camera: opts.hasMedia ? "available" : "not-found",
        selectedAudioDeviceId: null,
        selectedCameraDeviceId: null,
      },
    },
    events: [{
      id: "e-1",
      seq: 1,
      timestampMs: 100,
      source: "editor",
      track: "main",
      type: "content-change",
      payload: {
        fileId: "main",
        version: 1,
        code: "console.log(1)",
        contentHash: "h1",
        language: "javascript",
        changeReason: "input",
        changeCount: 1,
        flushedBy: "debounce",
      },
    }],
    snapshots: [{
      id: "snap-1",
      timestampMs: 0,
      eventSeq: 1,
      state: {
        editor: {
          code: "console.log(1)",
          language: "javascript",
          cursor: null,
          selection: null,
          scrollTop: 0,
          scrollLeft: 0,
        },
        status: "idle",
      },
    }],
    media: opts.hasMedia
      ? { blobId: "media-1", mimeType: "video/webm", durationMs: 5000, sizeBytes: 100, timelineOffsetMs: 0, hasAudio: true, hasCamera: true }
      : null,
  } as unknown as RecordingPackageV1;
}

/** 构造一份 CloudRecordingDetail 测试数据 */
function makeDetail(overrides: Partial<CloudRecordingDetail> = {}): CloudRecordingDetail {
  return {
    id: "rec_1",
    title: "Test Recording",
    durationMs: 5000,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:01:00.000Z",
    initialLanguage: "javascript",
    hasAudio: true,
    hasCamera: true,
    status: "processing",
    localPackageId: "local-pkg-1",
    schemaVersion: "0.1.0",
    visibility: "private",
    completedAt: null,
    totalSizeBytes: 53840,
    eventCount: null,
    snapshotCount: null,
    failureCode: null,
    failureMessage: null,
    ...overrides,
  };
}

/** 构造一份 GET /api/recordings/:id 响应 envelope */
function makeDetailResponse(
  overrides: Partial<CloudRecordingDetail> = {},
): CloudRecordingDetailResponse {
  return {
    recording: makeDetail(overrides),
    assets: [
      {
        kind: "manifest",
        sizeBytes: 256,
        mimeType: "application/json",
        validatedAt: "2026-05-29T00:00:01.000Z",
      },
    ],
  };
}

/** 构造一份 CloudRecordingListItem 测试数据 */
function makeListItem(overrides: Partial<CloudRecordingListItem> = {}): CloudRecordingListItem {
  return {
    id: "rec_1",
    title: "Test Recording",
    createdAt: "2026-05-29T00:00:00.000Z",
    durationMs: 5000,
    initialLanguage: "javascript",
    hasAudio: true,
    hasCamera: true,
    thumbnailUrl: null,
    visibility: "private",
    ...overrides,
  };
}

function makeListResponse(
  items: CloudRecordingListItem[] = [makeListItem()],
  nextCursor: string | null = null,
): ListRecordingsResponse {
  return { items, nextCursor };
}

function makePlaybackDescriptor(
  overrides: Partial<CloudPlaybackDescriptor> = {},
): CloudPlaybackDescriptor {
  return {
    id: "rec_1",
    title: "Test Recording",
    durationMs: 5000,
    schemaVersion: "0.1.0",
    manifestUrl: "https://storage.example.com/rec_1/manifest.json",
    metaUrl: "https://storage.example.com/rec_1/meta.json",
    eventsUrl: "https://storage.example.com/rec_1/events.json",
    snapshotsUrl: "https://storage.example.com/rec_1/snapshots.json",
    indexesUrl: null,
    mediaUrl: "https://storage.example.com/rec_1/media.webm",
    thumbnailUrl: null,
    expiresAt: "2026-05-29T00:05:00.000Z",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// fetch mock 工具
// ─────────────────────────────────────────────────────────────

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Headers({ "content-type": "application/json", ...headers }),
    json: async () => body,
  } as Response);
}

function mockFetchReject(error: Error) {
  vi.mocked(fetch).mockRejectedValueOnce(error);
}

// ─────────────────────────────────────────────────────────────
// XMLHttpRequest mock 工具
// ─────────────────────────────────────────────────────────────

interface MockXhr {
  upload: { onprogress: ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  ontimeout: (() => void) | null;
  open: ReturnType<typeof vi.fn>;
  setRequestHeader: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  status: number;
  statusText: string;
}

/** 创建可控的 mock XMLHttpRequest */
function createMockXhr(): { xhr: MockXhr; instance: XMLHttpRequest } {
  const xhr: MockXhr = {
    upload: { onprogress: null },
    onload: null,
    onerror: null,
    ontimeout: null,
    open: vi.fn(),
    setRequestHeader: vi.fn(),
    send: vi.fn(function (this: MockXhr) {
      queueMicrotask(() => {
        if (this.onload) this.onload();
      });
    }),
    status: 200,
    statusText: "OK",
  };
  return { xhr, instance: xhr as unknown as XMLHttpRequest };
}

// ─────────────────────────────────────────────────────────────
// 清理与设置
// ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.restoreAllMocks();
  try {
    localStorage.removeItem("code-tape-cloud-owner-token");
  } catch {
    // ignore
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────
// 辅助：创建带 mock fetch 的 repository
// ─────────────────────────────────────────────────────────────

function setupRepo(): CloudRecordingRepository {
  if (!vi.isMockFunction(globalThis.fetch)) {
    vi.stubGlobal("fetch", vi.fn());
  }
  return createCloudRecordingRepository();
}

// ─────────────────────────────────────────────────────────────
// 测试用例
// ─────────────────────────────────────────────────────────────

describe("CloudRecordingRepository", () => {
  // ───────────────────────────────────────────────────────
  // owner token
  // ───────────────────────────────────────────────────────

  describe("getOwnerToken", () => {
    it("首次调用生成随机 hex token 并持久化到 localStorage", () => {
      const repo = setupRepo();
      const token = repo.getOwnerToken();
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      expect(localStorage.getItem("code-tape-cloud-owner-token")).toBe(token);
    });

    it("再次调用返回已持久化的同一 token", () => {
      const repo = setupRepo();
      const first = repo.getOwnerToken();
      const second = repo.getOwnerToken();
      expect(second).toBe(first);
    });

    it("localStorage 不可用时同一 repo 实例多次调用返回同一 token", () => {
      // 模拟 localStorage 完全不可用
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("localStorage disabled");
      });
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("localStorage disabled");
      });

      const repo = createCloudRecordingRepository();
      const first = repo.getOwnerToken();
      const second = repo.getOwnerToken();
      expect(second).toBe(first);
      expect(first).toMatch(/^[a-f0-9]{64}$/);
    });

    it("已持久化 token 为非 hex 脏值时忽略并重新生成合法 token", () => {
      localStorage.setItem("code-tape-cloud-owner-token", "z".repeat(64));

      const repo = setupRepo();
      const token = repo.getOwnerToken();

      expect(token).toMatch(/^[a-f0-9]{64}$/);
      expect(token).not.toBe("z".repeat(64));
      expect(localStorage.getItem("code-tape-cloud-owner-token")).toBe(token);
    });

    it("不同 repository 实例共享同一持久化 token", () => {
      const repo1 = setupRepo();
      const token = repo1.getOwnerToken();
      const repo2 = createCloudRecordingRepository();
      expect(repo2.getOwnerToken()).toBe(token);
    });
  });

  // ───────────────────────────────────────────────────────
  // createUploadSession
  // ───────────────────────────────────────────────────────

  describe("createUploadSession", () => {
    it("成功创建上传会话并返回 upload targets", async () => {
      const repo = setupRepo();
      const sessionRes = makeSessionResponse();
      mockFetch(201, sessionRes);

      const result = await repo.createUploadSession(makeCreateSessionRequest());
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.sessionId).toBe("upl_1");
      expect(result.value.recordingId).toBe("rec_1");
      expect(result.value.uploadTargets).toHaveLength(5);
      expect(result.value.uploadTargets[0].method).toBe("PUT");
    });

    it("在请求中携带 x-owner-token 头", async () => {
      const repo = setupRepo();
      mockFetch(201, makeSessionResponse());

      await repo.createUploadSession(makeCreateSessionRequest());
      const callArgs = vi.mocked(fetch).mock.calls[0];
      const reqInit = callArgs[1] as RequestInit;
      expect(reqInit.headers).toBeDefined();
      const headers = reqInit.headers as Record<string, string>;
      expect(headers["x-owner-token"]).toBe(repo.getOwnerToken());
    });

    it("API 返回错误时返回 ok: false 及结构化错误", async () => {
      const repo = setupRepo();
      mockFetch(422, {
        error: { code: "unsupported-schema", message: "unsupported schemaVersion" },
      }, { "x-request-id": "req-err-1" });

      const result = await repo.createUploadSession(makeCreateSessionRequest());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("unsupported-schema");
      expect(result.error.message).toBe("unsupported schemaVersion");
      expect(result.error.requestId).toBe("req-err-1");
    });

    it("网络断开时返回 network-error", async () => {
      const repo = setupRepo();
      mockFetchReject(new Error("Failed to fetch"));

      const result = await repo.createUploadSession(makeCreateSessionRequest());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("network-error");
      expect(result.error.message).toContain("Failed to fetch");
    });

    it("缺少 owner token 时返回 unauthorized", async () => {
      const repo = setupRepo();
      mockFetch(401, {
        error: { code: "unauthorized", message: "missing owner token" },
      });

      const result = await repo.createUploadSession(makeCreateSessionRequest());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("unauthorized");
    });
  });

  // ───────────────────────────────────────────────────────
  // completeUpload
  // ───────────────────────────────────────────────────────

  describe("completeUpload", () => {
    it("成功 complete 返回 processing 状态", async () => {
      const repo = setupRepo();
      mockFetch(200, { recordingId: "rec_1", status: "processing" });

      const result = await repo.completeUpload("upl_1", {
        uploadedAssets: [
          { kind: "manifest", sha256: "a".repeat(64), sizeBytes: 256 },
          { kind: "meta", sha256: "b".repeat(64), sizeBytes: 512 },
          { kind: "events", sha256: "c".repeat(64), sizeBytes: 2048 },
          { kind: "snapshots", sha256: "d".repeat(64), sizeBytes: 1024 },
          { kind: "media", sha256: "e".repeat(64), sizeBytes: 50000 },
        ],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.recordingId).toBe("rec_1");
      expect(result.value.status).toBe("processing");
    });

    it("complete 时 session 过期返回 upload-session-expired", async () => {
      const repo = setupRepo();
      mockFetch(410, {
        error: { code: "upload-session-expired", message: "upload session expired" },
      });

      const result = await repo.completeUpload("upl_expired", {
        uploadedAssets: [
          { kind: "manifest", sha256: "a".repeat(64), sizeBytes: 256 },
          { kind: "meta", sha256: "b".repeat(64), sizeBytes: 512 },
          { kind: "events", sha256: "c".repeat(64), sizeBytes: 2048 },
          { kind: "snapshots", sha256: "d".repeat(64), sizeBytes: 1024 },
        ],
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("upload-session-expired");
    });

    it("网络错误时返回 network-error 且不吞异常", async () => {
      const repo = setupRepo();
      mockFetchReject(new Error("Network timeout"));

      const result = await repo.completeUpload("upl_1", {
        uploadedAssets: [
          { kind: "manifest", sha256: "a".repeat(64), sizeBytes: 256 },
          { kind: "meta", sha256: "b".repeat(64), sizeBytes: 512 },
          { kind: "events", sha256: "c".repeat(64), sizeBytes: 2048 },
          { kind: "snapshots", sha256: "d".repeat(64), sizeBytes: 1024 },
        ],
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("network-error");
      expect(typeof result.error.message).toBe("string");
      expect(result.error.message.length).toBeGreaterThan(0);
    });
  });

  // ───────────────────────────────────────────────────────
  // get（查询录制详情）
  // ───────────────────────────────────────────────────────

  describe("get", () => {
    it("返回 processing 状态的录制详情", async () => {
      const repo = setupRepo();
      mockFetch(200, makeDetailResponse({ status: "processing" }));

      const result = await repo.get("rec_1");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.recording.status).toBe("processing");
      expect(result.value.recording.id).toBe("rec_1");
      expect(result.value.recording.hasAudio).toBe(true);
      expect(result.value.assets[0]).toMatchObject({
        kind: "manifest",
        mimeType: "application/json",
      });
    });

    it("worker 校验通过后返回 ready 状态", async () => {
      const repo = setupRepo();
      mockFetch(200, makeDetailResponse({
        status: "ready",
        eventCount: 10,
        snapshotCount: 2,
      }));

      const result = await repo.get("rec_1");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.recording.status).toBe("ready");
    });

    it("校验失败返回 failed 状态及 failureCode", async () => {
      const repo = setupRepo();
      mockFetch(200, makeDetailResponse({
        status: "failed",
        failureCode: "checksum-mismatch",
        failureMessage: "media checksum does not match",
      }));

      const result = await repo.get("rec_1");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.recording.status).toBe("failed");
      expect(result.value.recording.failureCode).toBe("checksum-mismatch");
      expect(result.value.recording.failureMessage).toBe("media checksum does not match");
    });

    it("录制不存在返回 not-found", async () => {
      const repo = setupRepo();
      mockFetch(404, {
        error: { code: "not-found", message: "recording not found" },
      });

      const result = await repo.get("rec_nonexistent");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("not-found");
    });
  });

  // ───────────────────────────────────────────────────────
  // list（查询录制列表）
  // ───────────────────────────────────────────────────────

  describe("list", () => {
    it("返回当前 owner 的 ready 录制列表", async () => {
      const repo = setupRepo();
      mockFetch(200, makeListResponse());

      const result = await repo.list();
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.items).toHaveLength(1);
      expect(result.value.nextCursor).toBe(null);
      expect(result.value.items[0].id).toBe("rec_1");
      expect(result.value.items[0].thumbnailUrl).toBe(null);
      expect(result.value.items[0].visibility).toBe("private");
    });

    it("支持按 cursor/limit 请求分页列表", async () => {
      const repo = setupRepo();
      mockFetch(200, makeListResponse([makeListItem({ id: "rec_1" })], "rec_1"));

      const result = await repo.list({ cursor: "prev_rec", limit: 1 });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.items.map((item) => item.id)).toEqual(["rec_1"]);
      expect(result.value.nextCursor).toBe("rec_1");
      expect(fetch).toHaveBeenCalledWith(
        "/api/recordings?cursor=prev_rec&limit=1",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("不同 owner 数据隔离（不同 token 查询到不同列表）", async () => {
      const repo1 = setupRepo();
      mockFetch(200, makeListResponse([makeListItem({ id: "rec_a", title: "A" })]));

      const result1 = await repo1.list();
      expect(result1.ok).toBe(true);
      if (!result1.ok) throw new Error("expected ok");
      expect(result1.value.items).toHaveLength(1);

      // 换一个 token（模拟不同 owner） → 空列表
      localStorage.removeItem("code-tape-cloud-owner-token");
      const repo2 = createCloudRecordingRepository();

      mockFetch(200, makeListResponse([]));
      const result2 = await repo2.list();
      expect(result2.ok).toBe(true);
      if (!result2.ok) throw new Error("expected ok");
      expect(result2.value.items).toHaveLength(0);
    });
  });

  // ───────────────────────────────────────────────────────
  // getPlaybackDescriptor（云端播放描述）
  // ───────────────────────────────────────────────────────

  describe("getPlaybackDescriptor", () => {
    it("返回 ready 录制的 playback descriptor", async () => {
      const repo = setupRepo();
      mockFetch(200, makePlaybackDescriptor({ indexesUrl: "https://storage.example.com/rec_1/indexes.json" }));

      const result = await repo.getPlaybackDescriptor("rec_1");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value).toMatchObject({
        id: "rec_1",
        manifestUrl: "https://storage.example.com/rec_1/manifest.json",
        indexesUrl: "https://storage.example.com/rec_1/indexes.json",
      });
      expect(fetch).toHaveBeenCalledWith(
        "/api/recordings/rec_1/playback",
        expect.objectContaining({
          method: "GET",
          headers: { "x-owner-token": repo.getOwnerToken() },
        }),
      );
    });

    it("playback descriptor 错误时保留结构化错误和 requestId", async () => {
      const repo = setupRepo();
      mockFetch(404, {
        error: { code: "not-found", message: "recording not found" },
      }, { "x-request-id": "req-playback-1" });

      const result = await repo.getPlaybackDescriptor("rec_missing");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("not-found");
      expect(result.error.message).toBe("recording not found");
      expect(result.error.requestId).toBe("req-playback-1");
    });
  });

  // ───────────────────────────────────────────────────────
  // share links（云端分享）
  // ───────────────────────────────────────────────────────

  describe("share links", () => {
    it("creates a share link with owner token and timestamp payload", async () => {
      const repo = setupRepo();
      mockFetch(201, { url: "/s/share-token?t=4200", expiresAt: null });

      const result = await repo.createShareLink("rec_1", { startTimeMs: 4_200 });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.url).toBe("/s/share-token?t=4200");
      expect(result.value.expiresAt).toBe(null);
      expect(fetch).toHaveBeenCalledWith(
        "/api/recordings/rec_1/share-links",
        expect.objectContaining({
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-owner-token": repo.getOwnerToken(),
          },
          body: JSON.stringify({ startTimeMs: 4_200 }),
        }),
      );
    });

    it("loads shared playback descriptor without owner token", async () => {
      const repo = setupRepo();
      mockFetch(200, makePlaybackDescriptor({ id: "rec_shared" }));

      const result = await repo.getSharedPlaybackDescriptor("share token");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.id).toBe("rec_shared");
      expect(fetch).toHaveBeenCalledWith(
        "/api/share/share%20token/playback",
        expect.objectContaining({
          method: "GET",
        }),
      );
      const [, init] = vi.mocked(fetch).mock.calls[0];
      expect((init as RequestInit).headers).toBeUndefined();
    });

    it("returns structured errors when share link creation fails", async () => {
      const repo = setupRepo();
      mockFetch(404, {
        error: { code: "not-found", message: "recording not found" },
      }, { "x-request-id": "req-share-1" });

      const result = await repo.createShareLink("rec_missing", {});

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("not-found");
      expect(result.error.message).toBe("recording not found");
      expect(result.error.requestId).toBe("req-share-1");
    });
  });

  // ───────────────────────────────────────────────────────
  // rename（云端重命名）
  // ───────────────────────────────────────────────────────

  describe("rename", () => {
    it("PATCH 录制标题并复用 owner token", async () => {
      const repo = setupRepo();
      mockFetch(200, {
        id: "rec_1",
        title: "New Title",
        updatedAt: "2026-05-29T00:02:00.000Z",
      });

      const result = await repo.rename("rec_1", "  New Title  ");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value).toBeUndefined();
      expect(fetch).toHaveBeenCalledWith(
        "/api/recordings/rec_1",
        expect.objectContaining({
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "x-owner-token": repo.getOwnerToken(),
          },
          body: JSON.stringify({ title: "  New Title  " }),
        }),
      );
    });

    it("rename 非法标题时返回后端结构化错误", async () => {
      const repo = setupRepo();
      mockFetch(400, {
        error: { code: "bad-request", message: "title is required" },
      }, { "x-request-id": "req-rename-1" });

      const result = await repo.rename("rec_1", "");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("bad-request");
      expect(result.error.message).toBe("title is required");
      expect(result.error.requestId).toBe("req-rename-1");
    });
  });

  // ───────────────────────────────────────────────────────
  // remove（云端软删除）
  // ───────────────────────────────────────────────────────

  describe("remove", () => {
    it("DELETE 录制并忽略 soft delete 响应细节", async () => {
      const repo = setupRepo();
      mockFetch(200, {
        id: "rec_1",
        status: "soft_deleted",
        deletedAt: "2026-05-29T00:03:00.000Z",
      });

      const result = await repo.remove("rec_1");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value).toBeUndefined();
      expect(fetch).toHaveBeenCalledWith(
        "/api/recordings/rec_1",
        expect.objectContaining({
          method: "DELETE",
          headers: { "x-owner-token": repo.getOwnerToken() },
        }),
      );
    });

    it("remove 录制不存在时返回 not-found", async () => {
      const repo = setupRepo();
      mockFetch(404, {
        error: { code: "not-found", message: "recording not found" },
      });

      const result = await repo.remove("rec_missing");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("not-found");
    });
  });

  // ───────────────────────────────────────────────────────
  // uploadAsset（PUT 上传 + 进度回调）
  // ───────────────────────────────────────────────────────

  describe("uploadAsset", () => {
    it("成功上传并触发进度回调（按字节汇报）", async () => {
      const repo = setupRepo();
      const target = makeUploadTarget("manifest");
      const blob = makeBlob("x".repeat(1000));

      const progressEvents: UploadProgress[] = [];
      const { instance: mockXhr } = createMockXhr();
      vi.spyOn(globalThis, "XMLHttpRequest").mockImplementation(() => mockXhr);

      const uploadPromise = repo.uploadAsset(target, blob, (p) => {
        progressEvents.push({ ...p });
      });

      const xhrInstance = (globalThis.XMLHttpRequest as unknown as ReturnType<typeof vi.fn>).mock.results[0].value as MockXhr;
      const progressEvent = new ProgressEvent("progress", { lengthComputable: true, loaded: 500, total: 1000 });
      if (xhrInstance.upload.onprogress) xhrInstance.upload.onprogress(progressEvent);
      if (xhrInstance.onload) xhrInstance.onload();

      const result = await uploadPromise;
      expect(result.ok).toBe(true);

      expect(progressEvents.length).toBeGreaterThanOrEqual(1);
      expect(progressEvents[0].bytesUploaded).toBe(0);
      expect(progressEvents[0].totalBytes).toBe(1000);
      expect(progressEvents[0].currentAssetKind).toBe("manifest");

      // onload 补发最终字节数后，最后一次进度应到达 100%
      const last = progressEvents[progressEvents.length - 1];
      expect(last.bytesUploaded).toBe(last.totalBytes);
    });

    it("PUT 失败返回 network-error 并保留错误信息", async () => {
      const repo = setupRepo();
      const target = makeUploadTarget("media");
      const blob = makeBlob("media content");

      const { instance: mockXhr } = createMockXhr();
      mockXhr.send = vi.fn(function (this: MockXhr) {
        queueMicrotask(() => {
          if (this.onerror) this.onerror();
        });
      });
      vi.spyOn(globalThis, "XMLHttpRequest").mockImplementation(() => mockXhr);

      const result = await repo.uploadAsset(target, blob);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("network-error");
      expect(result.error.message).toContain("asset upload failed");
    });

    it("上传超时返回 network-error 并保留超时信息", async () => {
      const repo = setupRepo();
      const target = makeUploadTarget("media");
      const blob = makeBlob("media content");

      const { instance: mockXhr } = createMockXhr();
      mockXhr.send = vi.fn(function (this: MockXhr) {
        queueMicrotask(() => {
          if (this.ontimeout) this.ontimeout();
        });
      });
      vi.spyOn(globalThis, "XMLHttpRequest").mockImplementation(() => mockXhr);

      const result = await repo.uploadAsset(target, blob, undefined, 100);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("network-error");
      expect(result.error.message).toContain("timed out");
    });

    it("上传失败不影响调用方继续本地播放（repository 不抛异常）", async () => {
      const repo = setupRepo();
      const target = makeUploadTarget("events");
      const blob = makeBlob("events content");

      const { instance: mockXhr } = createMockXhr();
      mockXhr.send = vi.fn(function (this: MockXhr) {
        queueMicrotask(() => {
          if (this.onerror) this.onerror();
        });
      });
      vi.spyOn(globalThis, "XMLHttpRequest").mockImplementation(() => mockXhr);

      const result = await repo.uploadAsset(target, blob);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(typeof result.error.message).toBe("string");
      expect(result.error.message.length).toBeGreaterThan(0);
    });
  });

  // ───────────────────────────────────────────────────────
  // 完整上传流程集成
  // ───────────────────────────────────────────────────────

  describe("完整上传流程", () => {
    it("create session → PUT assets → complete → get status（processing → ready）", async () => {
      const repo = setupRepo();

      // 1. create session
      mockFetch(201, makeSessionResponse());
      const sessionResult = await repo.createUploadSession(makeCreateSessionRequest());
      expect(sessionResult.ok).toBe(true);
      if (!sessionResult.ok) throw new Error("expected ok");
      const { sessionId, uploadTargets, recordingId } = sessionResult.value;

      // 2. upload assets
      for (const target of uploadTargets) {
        const { instance: mockXhr } = createMockXhr();
        vi.spyOn(globalThis, "XMLHttpRequest").mockImplementation(() => mockXhr);
        const putResult = await repo.uploadAsset(target, makeBlob());
        expect(putResult.ok).toBe(true);
      }

      // 3. complete
      mockFetch(200, { recordingId, status: "processing" });
      const completeResult = await repo.completeUpload(sessionId, {
        uploadedAssets: uploadTargets.map((t) => ({
          kind: t.kind,
          sha256: "a".repeat(64),
          sizeBytes: 1000,
        })),
      });
      expect(completeResult.ok).toBe(true);
      if (!completeResult.ok) throw new Error("expected ok");
      expect(completeResult.value.status).toBe("processing");

      // 4. get → processing
      mockFetch(200, makeDetailResponse({ id: recordingId, status: "processing" }));
      const detail1 = await repo.get(recordingId);
      expect(detail1.ok).toBe(true);
      if (!detail1.ok) throw new Error("expected ok");
      expect(detail1.value.recording.status).toBe("processing");

      // 5. get → ready
      mockFetch(200, makeDetailResponse({ id: recordingId, status: "ready" }));
      const detail2 = await repo.get(recordingId);
      expect(detail2.ok).toBe(true);
      if (!detail2.ok) throw new Error("expected ok");
      expect(detail2.value.recording.status).toBe("ready");
    });
  });

  // ───────────────────────────────────────────────────────
  // 无媒体录制
  // ───────────────────────────────────────────────────────

  describe("无媒体录制上传", () => {
    it("无 media 资产的录制包也能成功上传", async () => {
      const repo = setupRepo();
      const request = makeCreateSessionRequest({
        hasAudio: false,
        hasCamera: false,
        assets: [
          { kind: "manifest", sha256: "a".repeat(64), sizeBytes: 256, mimeType: "application/json" },
          { kind: "meta", sha256: "b".repeat(64), sizeBytes: 512, mimeType: "application/json" },
          { kind: "events", sha256: "c".repeat(64), sizeBytes: 2048, mimeType: "application/json" },
          { kind: "snapshots", sha256: "d".repeat(64), sizeBytes: 1024, mimeType: "application/json" },
        ],
      });

      const sessionRes = makeSessionResponse({
        uploadTargets: [
          makeUploadTarget("manifest"),
          makeUploadTarget("meta"),
          makeUploadTarget("events"),
          makeUploadTarget("snapshots"),
        ],
      });
      mockFetch(201, sessionRes);

      const result = await repo.createUploadSession(request);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.uploadTargets).toHaveLength(4);
      expect(result.value.uploadTargets.find((t) => t.kind === "media")).toBeUndefined();
    });
  });

  // ───────────────────────────────────────────────────────
  // uploadPackage（一步上传完整 RecordingPackageV1）
  // ───────────────────────────────────────────────────────

  describe("uploadPackage", () => {
    it("使用 RecordingPackageV1 完整上传（含媒体）并返回 recordingId", async () => {
      const repo = setupRepo();
      const mediaBlob = new Blob(["fake-webm-data"], { type: "video/webm" });

      // 1. create session
      mockFetch(201, makeSessionResponse());

      // 2. upload assets（每资产一个 XHR mock）
      const mockXhrs: MockXhr[] = [];
      for (let i = 0; i < 5; i++) {
        const { xhr, instance } = createMockXhr();
        mockXhrs.push(xhr);
        vi.spyOn(globalThis, "XMLHttpRequest").mockImplementationOnce(() => instance);
      }

      // 3. complete
      mockFetch(200, { recordingId: "rec_1", status: "processing" });

      const pkg = makeMinimalPackage({ hasMedia: true });
      const result = await repo.uploadPackage(pkg, { media: mediaBlob });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.recordingId).toBe("rec_1");
      expect(result.value.status).toBe("processing");
    });

    it("无媒体录制包也能成功上传", async () => {
      const repo = setupRepo();

      mockFetch(201, makeSessionResponse({
        uploadTargets: [
          makeUploadTarget("manifest"),
          makeUploadTarget("meta"),
          makeUploadTarget("events"),
          makeUploadTarget("snapshots"),
        ],
      }));

      for (let i = 0; i < 4; i++) {
        const { instance } = createMockXhr();
        vi.spyOn(globalThis, "XMLHttpRequest").mockImplementationOnce(() => instance);
      }

      mockFetch(200, { recordingId: "rec_1", status: "processing" });

      const pkg = makeMinimalPackage({ hasMedia: false });
      const result = await repo.uploadPackage(pkg, {});

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.status).toBe("processing");
    });

    it("含媒体 package 缺少 media blob 时不调用 create session，并返回可展示错误", async () => {
      const repo = setupRepo();
      const fetchSpy = vi.mocked(fetch);

      const pkg = makeMinimalPackage({ hasMedia: true });
      const result = await repo.uploadPackage(pkg, {});

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("network-error");
      expect(result.error.message).toContain("media blob");
      // 不应调用 fetch（即没有创建 session）
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("大媒体上传过程中透传单资产字节进度到外部 onProgress", async () => {
      const repo = setupRepo();
      const mediaBlob = new Blob(["x".repeat(10000)]);

      mockFetch(201, makeSessionResponse());

      // 用一个统一 mock 捕获每个被创建的 XHR，send 为 no-op 由测试手动推进
      const xhrMocks: MockXhr[] = [];
      vi.spyOn(globalThis, "XMLHttpRequest").mockImplementation(() => {
        const { xhr, instance } = createMockXhr();
        xhr.send = vi.fn();
        xhrMocks.push(xhr);
        return instance;
      });

      mockFetch(200, { recordingId: "rec_1", status: "processing" });

      const progressEvents: UploadProgress[] = [];
      const pkg = makeMinimalPackage({ hasMedia: true });
      const uploadPromise = repo.uploadPackage(pkg, { media: mediaBlob }, {
        onProgress: (p) => progressEvents.push({ ...p }),
      });

      // 等待 buildPackageAssetDefs (SHA hash) + createUploadSession 到达第一个 uploadAsset
      await vi.waitFor(() => {
        expect(xhrMocks.length).toBeGreaterThanOrEqual(1);
      }, { timeout: 10000 });

      // 资产 1 (manifest)：触发 XHR 中间进度，然后 onload 完成
      xhrMocks[0].upload.onprogress?.(
        new ProgressEvent("progress", { lengthComputable: true, loaded: 150, total: 500 }),
      );
      xhrMocks[0].onload?.();
      await vi.waitFor(() => {
        expect(xhrMocks.length).toBeGreaterThanOrEqual(2);
      }, { timeout: 5000 });

      // 资产 2 (meta)：触发 XHR 中间进度，然后 onload 完成
      xhrMocks[1].upload.onprogress?.(
        new ProgressEvent("progress", { lengthComputable: true, loaded: 200, total: 300 }),
      );
      xhrMocks[1].onload?.();
      await vi.waitFor(() => {
        expect(xhrMocks.length).toBeGreaterThanOrEqual(3);
      }, { timeout: 5000 });

      // 完成剩余资产（不再触发中间进度）
      for (let i = 2; i < 5; i++) {
        xhrMocks[i].onload?.();
        if (i < 4) {
          await vi.waitFor(() => {
            expect(xhrMocks.length).toBeGreaterThanOrEqual(i + 2);
          }, { timeout: 5000 });
        }
      }

      const result = await uploadPromise;
      expect(result.ok).toBe(true);

      // 所有 progress 事件的 totalBytes 都是全局总量（非资产局部 blob.size）
      const totalSet = new Set(progressEvents.map((e) => e.totalBytes));
      expect(totalSet.size).toBe(1);

      // bytesUploaded 单调不减（跨资产进度正确累加，不会因切换资产而跳回 0）
      for (let i = 1; i < progressEvents.length; i++) {
        expect(progressEvents[i].bytesUploaded).toBeGreaterThanOrEqual(progressEvents[i - 1].bytesUploaded);
      }

      // 能收到来自不同资产的进度事件（证明中间进度已透传，而非仅在资产完成后回调）
      const kinds = new Set(progressEvents.map((e) => e.currentAssetKind));
      expect(kinds.size).toBeGreaterThanOrEqual(2);

      // 最终进度到达 100%（onload 补发 blob.size 确保 UI 不会停在非 100%）
      const globalTotal = [...totalSet][0];
      const lastEvent = progressEvents[progressEvents.length - 1];
      expect(lastEvent.bytesUploaded).toBe(globalTotal);
    }, 15000);

    it("crypto.subtle.digest 失败时返回 CloudResult 错误而非 reject", async () => {
      const repo = setupRepo();
      const mediaBlob = new Blob(["fake-webm-data"], { type: "video/webm" });

      mockFetch(201, makeSessionResponse());

      // mock crypto.subtle.digest 失败
      vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValueOnce(new Error("crypto unavailable"));

      const pkg = makeMinimalPackage({ hasMedia: true });
      const result = await repo.uploadPackage(pkg, { media: mediaBlob });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("network-error");
      expect(result.error.message).toContain("prepare upload assets failed");
      expect(result.error.message).toContain("crypto unavailable");
    });

    it("create session 失败时透传错误", async () => {
      const repo = setupRepo();
      mockFetch(422, { error: { code: "unsupported-schema", message: "bad schema" } });

      const pkg = makeMinimalPackage({ hasMedia: false });
      const result = await repo.uploadPackage(pkg, {});

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("unsupported-schema");
    });

    it("上传的 manifest 资产直接来自 pkg.manifest，不裁剪可选字段", async () => {
      const repo = setupRepo();
      const mediaBlob = new Blob(["fake-webm-data"], { type: "video/webm" });
      const pkg = makeMinimalPackage({ hasMedia: true });
      (pkg.manifest as unknown as Record<string, unknown>).futureOptional = {
        chapterCount: 2,
      };

      mockFetch(201, makeSessionResponse());

      const mockXhrs: MockXhr[] = [];
      for (let i = 0; i < 5; i++) {
        const { xhr, instance } = createMockXhr();
        mockXhrs.push(xhr);
        vi.spyOn(globalThis, "XMLHttpRequest").mockImplementationOnce(() => instance);
      }

      mockFetch(200, { recordingId: "rec_1", status: "processing" });

      const result = await repo.uploadPackage(pkg, { media: mediaBlob });

      expect(result.ok).toBe(true);
      const uploadedJsonAssets = await Promise.all(
        mockXhrs.map(async (xhr) => {
          const blob = xhr.send.mock.calls[0]?.[0] as Blob;
          const text = await readBlobText(blob);
          try {
            return JSON.parse(text) as Record<string, unknown>;
          } catch {
            return null;
          }
        }),
      );
      const uploadedManifest = uploadedJsonAssets.find(
        (asset) => asset?.packageId === pkg.manifest.packageId,
      );
      expect(uploadedManifest).toEqual(pkg.manifest);
    });
  });

  // ───────────────────────────────────────────────────────
  // pollUntilReady（状态轮询）
  // ───────────────────────────────────────────────────────

  describe("pollUntilReady", () => {
    it("processing 多次后变为 ready 时返回", async () => {
      const repo = setupRepo();

      // 前两次返回 processing，第三次返回 ready
      mockFetch(200, makeDetailResponse({ status: "processing" }));
      mockFetch(200, makeDetailResponse({ status: "processing" }));
      mockFetch(200, makeDetailResponse({ status: "ready", eventCount: 10 }));

      const result = await repo.pollUntilReady("rec_1", { intervalMs: 10 });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.recording.status).toBe("ready");
    }, 5000);

    it("变为 failed 时立即返回", async () => {
      const repo = setupRepo();
      mockFetch(200, makeDetailResponse({ status: "failed", failureCode: "checksum-mismatch" }));

      const result = await repo.pollUntilReady("rec_1", { intervalMs: 10 });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.recording.status).toBe("failed");
      expect(result.value.recording.failureCode).toBe("checksum-mismatch");
    }, 5000);

    it("get 调用失败时立即返回错误", async () => {
      const repo = setupRepo();
      mockFetch(404, { error: { code: "not-found", message: "not found" } });

      const result = await repo.pollUntilReady("rec_1", { intervalMs: 10 });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("not-found");
    }, 5000);

    it("超时后返回 timeout 错误", async () => {
      const repo = setupRepo();

      // 一直返回 processing（足够多次以覆盖 timeoutMs 内的所有轮询）
      for (let i = 0; i < 20; i++) {
        mockFetch(200, makeDetailResponse({ status: "processing" }));
      }

      const result = await repo.pollUntilReady("rec_1", { intervalMs: 10, timeoutMs: 50 });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("network-error");
      expect(result.error.message).toContain("timed out");
    }, 5000);
  });
});
