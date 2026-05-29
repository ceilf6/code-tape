import assert from "node:assert/strict";
import test from "node:test";
import { canonicalStringify, sha256Hex } from "@code-tape/recording-schema/hash";
import {
  RECORDING_SCHEMA_VERSION,
  type RecordingPackageV1,
} from "@code-tape/recording-schema";
import { createCloudRecordingService } from "../cloudRecordingService.js";
import { createMemoryMetadataRepository } from "../memoryMetadataRepository.js";
import { createMemoryObjectStorage } from "../memoryObjectStorage.js";
import type { CreateUploadSessionRequest } from "../types.js";

test("createUploadSession is idempotent per owner and idempotency key", async () => {
  const service = createCloudRecordingService({
    metadata: createMemoryMetadataRepository(),
    objectStorage: createMemoryObjectStorage(),
  });
  const pkg = await makePackage();
  const request = await makeCreateSessionRequest(pkg);

  const first = await service.createUploadSession({ ownerId: "owner-1", input: request });
  const second = await service.createUploadSession({ ownerId: "owner-1", input: request });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(second.value.sessionId, first.value.sessionId);
  assert.equal(second.value.recordingId, first.value.recordingId);
  assert.equal(second.value.uploadTargets.length, request.assets.length);
  assert.ok(second.value.uploadTargets.every((target) => target.method === "PUT"));
});

test("createUploadSession keeps one session for concurrent matching idempotency keys", async () => {
  const service = createCloudRecordingService({
    metadata: createMemoryMetadataRepository(),
    objectStorage: createMemoryObjectStorage(),
  });
  const pkg = await makePackage();
  const request = await makeCreateSessionRequest(pkg);

  const [first, second] = await Promise.all([
    service.createUploadSession({ ownerId: "owner-1", input: request }),
    service.createUploadSession({ ownerId: "owner-1", input: request }),
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(second.value.sessionId, first.value.sessionId);
  assert.equal(second.value.recordingId, first.value.recordingId);
  assert.equal(second.value.uploadTargets.length, request.assets.length);
});

test("createUploadSession rejects concurrent idempotency key reuse with different bodies", async () => {
  const service = createCloudRecordingService({
    metadata: createMemoryMetadataRepository(),
    objectStorage: createMemoryObjectStorage(),
  });
  const pkg = await makePackage();
  const request = await makeCreateSessionRequest(pkg);

  const [first, second] = await Promise.all([
    service.createUploadSession({ ownerId: "owner-1", input: request }),
    service.createUploadSession({
      ownerId: "owner-1",
      input: { ...request, title: "Different recording" },
    }),
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.error.code, "upload-session-conflict");
  assert.equal(second.error.message, "idempotency key reused with a different upload request");
});

for (const input of [
  {
    name: "changed local package id",
    makeRequest: (request: CreateUploadSessionRequest): CreateUploadSessionRequest => ({
      ...request,
      localPackageId: "pkg-other",
    }),
  },
  {
    name: "changed asset checksum",
    makeRequest: (request: CreateUploadSessionRequest): CreateUploadSessionRequest => ({
      ...request,
      assets: request.assets.map((asset) =>
        asset.kind === "manifest" ? { ...asset, sha256: "f".repeat(64) } : asset,
      ),
    }),
  },
] as const) {
  test(`createUploadSession rejects idempotency key reuse with ${input.name}`, async () => {
    const service = createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    });
    const pkg = await makePackage();
    const request = await makeCreateSessionRequest(pkg);

    const first = await service.createUploadSession({ ownerId: "owner-1", input: request });
    const second = await service.createUploadSession({
      ownerId: "owner-1",
      input: input.makeRequest(request),
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.error.code, "upload-session-conflict");
    assert.equal(second.error.message, "idempotency key reused with a different upload request");
  });
}

test("createUploadSession does not expose upload targets after the session is completed", async () => {
  const service = createCloudRecordingService({
    metadata: createMemoryMetadataRepository(),
    objectStorage: createMemoryObjectStorage(),
  });
  const pkg = await makePackage();
  const request = await makeCreateSessionRequest(pkg);
  const created = await service.createUploadSession({ ownerId: "owner-1", input: request });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const completed = await service.completeUpload({
    ownerId: "owner-1",
    sessionId: created.value.sessionId,
    input: { uploadedAssets: request.assets },
  });
  const retry = await service.createUploadSession({ ownerId: "owner-1", input: request });

  assert.equal(completed.ok, true);
  assert.equal(retry.ok, false);
  if (retry.ok) return;
  assert.equal(retry.error.code, "upload-session-conflict");
  assert.equal(retry.error.message, "upload session is not open");
});

test("createUploadSession rejects expired idempotency retries without upload targets", async () => {
  let nowMs = Date.parse("2026-05-27T00:00:00.000Z");
  const service = createCloudRecordingService({
    metadata: createMemoryMetadataRepository(),
    objectStorage: createMemoryObjectStorage(),
    now: () => new Date(nowMs),
  });
  const pkg = await makePackage();
  const request = await makeCreateSessionRequest(pkg);
  const created = await service.createUploadSession({ ownerId: "owner-1", input: request });
  assert.equal(created.ok, true);

  nowMs = Date.parse("2026-05-27T00:31:00.000Z");
  const retry = await service.createUploadSession({ ownerId: "owner-1", input: request });

  assert.equal(retry.ok, false);
  if (retry.ok) return;
  assert.equal(retry.error.code, "upload-session-expired");
  assert.equal(retry.error.message, "upload session expired");
});

test("createUploadSession rejects incomplete package asset sets", async () => {
  const service = createCloudRecordingService({
    metadata: createMemoryMetadataRepository(),
    objectStorage: createMemoryObjectStorage(),
  });
  const pkg = await makePackage();
  const request = await makeCreateSessionRequest(pkg);

  const result = await service.createUploadSession({
    ownerId: "owner-1",
    input: {
      ...request,
      assets: request.assets.filter((asset) => asset.kind !== "snapshots"),
    },
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "invalid-manifest");
  assert.match(result.error.message, /snapshots/);
});

for (const input of [
  {
    name: "unsupported asset kind",
    makeRequest: (request: CreateUploadSessionRequest): CreateUploadSessionRequest => ({
      ...request,
      assets: [
        ...request.assets,
        {
          ...request.assets[0]!,
          kind: "trace" as CreateUploadSessionRequest["assets"][number]["kind"],
        },
      ],
    }),
    message: /unsupported asset kind: trace/,
  },
  {
    name: "duplicate asset kind",
    makeRequest: (request: CreateUploadSessionRequest): CreateUploadSessionRequest => ({
      ...request,
      assets: [...request.assets, { ...request.assets[0]! }],
    }),
    message: /duplicate asset kind: manifest/,
  },
  {
    name: "invalid asset checksum",
    makeRequest: (request: CreateUploadSessionRequest): CreateUploadSessionRequest => ({
      ...request,
      assets: request.assets.map((asset) =>
        asset.kind === "manifest" ? { ...asset, sha256: "sha256-placeholder" } : asset,
      ),
    }),
    message: /invalid asset checksum: manifest/,
  },
  {
    name: "invalid asset size",
    makeRequest: (request: CreateUploadSessionRequest): CreateUploadSessionRequest => ({
      ...request,
      assets: request.assets.map((asset) =>
        asset.kind === "manifest" ? { ...asset, sizeBytes: -1 } : asset,
      ),
    }),
    message: /invalid asset size: manifest/,
  },
  {
    name: "empty asset mime type",
    makeRequest: (request: CreateUploadSessionRequest): CreateUploadSessionRequest => ({
      ...request,
      assets: request.assets.map((asset) =>
        asset.kind === "manifest" ? { ...asset, mimeType: " " } : asset,
      ),
    }),
    message: /invalid asset mime type: manifest/,
  },
] as const) {
  test(`createUploadSession rejects ${input.name}`, async () => {
    const service = createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    });
    const pkg = await makePackage();
    const request = await makeCreateSessionRequest(pkg);

    const result = await service.createUploadSession({
      ownerId: "owner-1",
      input: input.makeRequest(request),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "invalid-manifest");
    assert.match(result.error.message, input.message);
  });
}

for (const input of [
  {
    name: "blank idempotency key",
    makeRequest: (request: CreateUploadSessionRequest): CreateUploadSessionRequest => ({
      ...request,
      idempotencyKey: " ",
    }),
    message: /idempotencyKey must be 1 to 128 characters/,
  },
  {
    name: "oversized idempotency key",
    makeRequest: (request: CreateUploadSessionRequest): CreateUploadSessionRequest => ({
      ...request,
      idempotencyKey: "i".repeat(129),
    }),
    message: /idempotencyKey must be 1 to 128 characters/,
  },
  {
    name: "blank local package id",
    makeRequest: (request: CreateUploadSessionRequest): CreateUploadSessionRequest => ({
      ...request,
      localPackageId: " ",
    }),
    message: /localPackageId must be 1 to 128 characters/,
  },
  {
    name: "oversized local package id",
    makeRequest: (request: CreateUploadSessionRequest): CreateUploadSessionRequest => ({
      ...request,
      localPackageId: "p".repeat(129),
    }),
    message: /localPackageId must be 1 to 128 characters/,
  },
  {
    name: "negative duration",
    makeRequest: (request: CreateUploadSessionRequest): CreateUploadSessionRequest => ({
      ...request,
      durationMs: -1,
    }),
    message: /durationMs must be a non-negative safe integer/,
  },
  {
    name: "fractional duration",
    makeRequest: (request: CreateUploadSessionRequest): CreateUploadSessionRequest => ({
      ...request,
      durationMs: 1.5,
    }),
    message: /durationMs must be a non-negative safe integer/,
  },
  {
    name: "unsafe duration",
    makeRequest: (request: CreateUploadSessionRequest): CreateUploadSessionRequest => ({
      ...request,
      durationMs: Number.MAX_SAFE_INTEGER + 1,
    }),
    message: /durationMs must be a non-negative safe integer/,
  },
  {
    name: "unsupported initial language",
    makeRequest: (request: CreateUploadSessionRequest): CreateUploadSessionRequest => ({
      ...request,
      initialLanguage: "ruby" as CreateUploadSessionRequest["initialLanguage"],
    }),
    message: /initialLanguage must be one of javascript, typescript, python/,
  },
] as const) {
  test(`createUploadSession rejects ${input.name}`, async () => {
    const service = createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    });
    const pkg = await makePackage();
    const request = await makeCreateSessionRequest(pkg);

    const result = await service.createUploadSession({
      ownerId: "owner-1",
      input: input.makeRequest(request),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "invalid-manifest");
    assert.match(result.error.message, input.message);
  });
}

test("completeUpload does not regress a completed recording back to processing", async () => {
  const metadata = createMemoryMetadataRepository();
  const service = createCloudRecordingService({
    metadata,
    objectStorage: createMemoryObjectStorage(),
  });
  const pkg = await makePackage();
  const request = await makeCreateSessionRequest(pkg);
  const created = await service.createUploadSession({ ownerId: "owner-1", input: request });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const first = await service.completeUpload({
    ownerId: "owner-1",
    sessionId: created.value.sessionId,
    input: { uploadedAssets: request.assets },
  });
  assert.equal(first.ok, true);
  const processing = await metadata.getRecording(created.value.recordingId);
  assert.ok(processing);
  await metadata.updateRecording({
    ...processing,
    status: "ready",
    completedAt: "2026-05-27T00:02:00.000Z",
    updatedAt: "2026-05-27T00:02:00.000Z",
    eventCount: 0,
    snapshotCount: 0,
  });

  const second = await service.completeUpload({
    ownerId: "owner-1",
    sessionId: created.value.sessionId,
    input: { uploadedAssets: request.assets },
  });
  const recording = await metadata.getRecording(created.value.recordingId);

  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.value.status, "ready");
  assert.equal(recording?.status, "ready");
  assert.equal(recording?.updatedAt, "2026-05-27T00:02:00.000Z");
});

test("completeUpload does not revive a soft-deleted uploading recording", async () => {
  const metadata = createMemoryMetadataRepository();
  const service = createCloudRecordingService({
    metadata,
    objectStorage: createMemoryObjectStorage(),
  });
  const pkg = await makePackage();
  const request = await makeCreateSessionRequest(pkg);
  const created = await service.createUploadSession({ ownerId: "owner-1", input: request });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const deleted = await service.deleteRecording({
    ownerId: "owner-1",
    recordingId: created.value.recordingId,
  });
  assert.equal(deleted.ok, true);

  const completed = await service.completeUpload({
    ownerId: "owner-1",
    sessionId: created.value.sessionId,
    input: { uploadedAssets: request.assets },
  });
  const recording = await metadata.getRecording(created.value.recordingId);

  assert.equal(completed.ok, false);
  if (completed.ok) return;
  assert.equal(completed.error.code, "not-found");
  assert.equal(recording?.status, "soft_deleted");
  assert.equal(recording?.deletedAt, deleted.ok ? deleted.value.deletedAt : null);
});

test("completeUpload hides non-visible recordings before uploaded asset conflicts", async () => {
  const metadata = createMemoryMetadataRepository();
  const service = createCloudRecordingService({
    metadata,
    objectStorage: createMemoryObjectStorage(),
  });
  const pkg = await makePackage();
  const request = await makeCreateSessionRequest(pkg);
  const created = await service.createUploadSession({ ownerId: "owner-1", input: request });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const recording = await metadata.getRecording(created.value.recordingId);
  assert.ok(recording);
  await metadata.updateRecording({
    ...recording,
    status: "deleted",
    deletedAt: "2026-05-27T00:02:00.000Z",
    updatedAt: "2026-05-27T00:02:00.000Z",
  });

  const completed = await service.completeUpload({
    ownerId: "owner-1",
    sessionId: created.value.sessionId,
    input: {
      uploadedAssets: request.assets.map((asset) =>
        asset.kind === "manifest" ? { ...asset, sha256: "f".repeat(64) } : asset,
      ),
    },
  });
  const session = await metadata.getSession(created.value.sessionId);
  const assets = await metadata.listAssets(created.value.recordingId);

  assert.equal(completed.ok, false);
  if (completed.ok) return;
  assert.equal(completed.error.code, "not-found");
  assert.equal(completed.error.message, "recording not found");
  assert.equal(session?.status, "open");
  assert.ok(assets.every((asset) => asset.uploadedAt === null));
});

test("completeUpload retry hides a soft-deleted processing recording", async () => {
  const metadata = createMemoryMetadataRepository();
  const service = createCloudRecordingService({
    metadata,
    objectStorage: createMemoryObjectStorage(),
  });
  const pkg = await makePackage();
  const request = await makeCreateSessionRequest(pkg);
  const created = await service.createUploadSession({ ownerId: "owner-1", input: request });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const completed = await service.completeUpload({
    ownerId: "owner-1",
    sessionId: created.value.sessionId,
    input: { uploadedAssets: request.assets },
  });
  assert.equal(completed.ok, true);

  const deleted = await service.deleteRecording({
    ownerId: "owner-1",
    recordingId: created.value.recordingId,
  });
  assert.equal(deleted.ok, true);

  const retried = await service.completeUpload({
    ownerId: "owner-1",
    sessionId: created.value.sessionId,
    input: { uploadedAssets: request.assets },
  });
  const recording = await metadata.getRecording(created.value.recordingId);

  assert.equal(retried.ok, false);
  if (retried.ok) return;
  assert.equal(retried.error.code, "not-found");
  assert.equal(recording?.status, "soft_deleted");
  assert.equal(recording?.deletedAt, deleted.ok ? deleted.value.deletedAt : null);
});

test("completeUpload returns not-found when delete wins the mark-complete race", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createMemoryObjectStorage();
  let deleteBeforeMark = false;
  const wrappedMetadata = {
    ...metadata,
    async markUploadCompleted(input: Parameters<typeof metadata.markUploadCompleted>[0]) {
      if (deleteBeforeMark) {
        const session = await metadata.getSession(input.sessionId);
        assert.ok(session);
        const recording = await metadata.getRecording(session.recordingId);
        assert.ok(recording);
        await metadata.updateRecording({
          ...recording,
          status: "soft_deleted",
          deletedAt: "2026-05-27T00:02:00.000Z",
          updatedAt: "2026-05-27T00:02:00.000Z",
        });
      }
      await metadata.markUploadCompleted(input);
    },
  };
  const service = createCloudRecordingService({
    metadata: wrappedMetadata,
    objectStorage,
  });
  const pkg = await makePackage();
  const request = await makeCreateSessionRequest(pkg);
  const created = await service.createUploadSession({ ownerId: "owner-1", input: request });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  deleteBeforeMark = true;
  const completed = await service.completeUpload({
    ownerId: "owner-1",
    sessionId: created.value.sessionId,
    input: { uploadedAssets: request.assets },
  });
  const recording = await metadata.getRecording(created.value.recordingId);
  const session = await metadata.getSession(created.value.sessionId);
  const assets = await metadata.listAssets(created.value.recordingId);

  assert.equal(completed.ok, false);
  if (completed.ok) return;
  assert.equal(completed.error.code, "not-found");
  assert.equal(recording?.status, "soft_deleted");
  assert.equal(recording?.deletedAt, "2026-05-27T00:02:00.000Z");
  assert.equal(session?.status, "open");
  assert.ok(assets.every((asset) => asset.uploadedAt === null));
});

for (const terminalStatus of ["purging", "deleted"] as const) {
  test(`completeUpload does not revive ${terminalStatus} when terminal transition wins the mark-complete race`, async () => {
    const metadata = createMemoryMetadataRepository();
    const objectStorage = createMemoryObjectStorage();
    let terminalBeforeMark = false;
    const wrappedMetadata = {
      ...metadata,
      async markUploadCompleted(input: Parameters<typeof metadata.markUploadCompleted>[0]) {
        if (terminalBeforeMark) {
          const session = await metadata.getSession(input.sessionId);
          assert.ok(session);
          const recording = await metadata.getRecording(session.recordingId);
          assert.ok(recording);
          await metadata.updateRecording({
            ...recording,
            status: terminalStatus,
            deletedAt: "2026-05-27T00:02:00.000Z",
            updatedAt: "2026-05-27T00:02:00.000Z",
          });
        }
        await metadata.markUploadCompleted(input);
      },
    };
    const service = createCloudRecordingService({
      metadata: wrappedMetadata,
      objectStorage,
    });
    const pkg = await makePackage();
    const request = await makeCreateSessionRequest(pkg);
    const created = await service.createUploadSession({ ownerId: "owner-1", input: request });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    terminalBeforeMark = true;
    const completed = await service.completeUpload({
      ownerId: "owner-1",
      sessionId: created.value.sessionId,
      input: { uploadedAssets: request.assets },
    });
    const recording = await metadata.getRecording(created.value.recordingId);
    const session = await metadata.getSession(created.value.sessionId);
    const assets = await metadata.listAssets(created.value.recordingId);

    assert.equal(completed.ok, false);
    if (completed.ok) return;
    assert.equal(completed.error.code, "not-found");
    assert.equal(recording?.status, terminalStatus);
    assert.equal(session?.status, "open");
    assert.ok(assets.every((asset) => asset.uploadedAt === null));
  });
}

test("rename preserves validation result when validation wins the rename write race", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createMemoryObjectStorage();
  const baseService = createCloudRecordingService({ metadata, objectStorage });
  const pkg = await makePackage();
  const request = await makeCreateSessionRequest(pkg);
  const created = await baseService.createUploadSession({ ownerId: "owner-1", input: request });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const completed = await baseService.completeUpload({
    ownerId: "owner-1",
    sessionId: created.value.sessionId,
    input: { uploadedAssets: request.assets },
  });
  assert.equal(completed.ok, true);

  let validationBeforeWrite = true;
  const markReady = async () => {
    if (!validationBeforeWrite) return;
    validationBeforeWrite = false;
    const current = await metadata.getRecording(created.value.recordingId);
    assert.ok(current);
    await metadata.updateRecording({
      ...current,
      status: "ready",
      completedAt: "2026-05-27T00:03:00.000Z",
      updatedAt: "2026-05-27T00:03:00.000Z",
      eventCount: 7,
      snapshotCount: 3,
      hasAudio: false,
      hasCamera: false,
      failureCode: null,
      failureMessage: null,
    });
  };
  const wrappedMetadata = {
    ...metadata,
    async updateRecording(recording: Parameters<typeof metadata.updateRecording>[0]) {
      await markReady();
      await metadata.updateRecording(recording);
    },
    async updateRecordingIfStatus(input: Parameters<typeof metadata.updateRecordingIfStatus>[0]) {
      await markReady();
      return metadata.updateRecordingIfStatus(input);
    },
  };
  const service = createCloudRecordingService({
    metadata: wrappedMetadata,
    objectStorage,
    now: () => new Date("2026-05-27T00:04:00.000Z"),
  });

  const renamed = await service.renameRecording({
    ownerId: "owner-1",
    recordingId: created.value.recordingId,
    input: { title: "Renamed after validation" },
  });
  const recording = await metadata.getRecording(created.value.recordingId);

  assert.equal(renamed.ok, true);
  assert.equal(recording?.status, "ready");
  assert.equal(recording?.title, "Renamed after validation");
  assert.equal(recording?.completedAt, "2026-05-27T00:03:00.000Z");
  assert.equal(recording?.eventCount, 7);
  assert.equal(recording?.snapshotCount, 3);
});

for (const terminalStatus of ["purging", "deleted"] as const) {
  test(`delete does not revive ${terminalStatus} when terminal transition wins the delete write race`, async () => {
    const metadata = createMemoryMetadataRepository();
    const objectStorage = createMemoryObjectStorage();
    const service = createCloudRecordingService({ metadata, objectStorage });
    const pkg = await makePackage();
    const request = await makeCreateSessionRequest(pkg);
    const created = await service.createUploadSession({ ownerId: "owner-1", input: request });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    let terminalBeforeWrite = true;
    const markTerminal = async () => {
      if (!terminalBeforeWrite) return;
      terminalBeforeWrite = false;
      const current = await metadata.getRecording(created.value.recordingId);
      assert.ok(current);
      await metadata.updateRecording({
        ...current,
        status: terminalStatus,
        deletedAt: "2026-05-27T00:05:00.000Z",
        updatedAt: "2026-05-27T00:05:00.000Z",
      });
    };
    const wrappedMetadata = {
      ...metadata,
      async updateRecording(recording: Parameters<typeof metadata.updateRecording>[0]) {
        await markTerminal();
        await metadata.updateRecording(recording);
      },
      async updateRecordingIfStatus(input: Parameters<typeof metadata.updateRecordingIfStatus>[0]) {
        await markTerminal();
        return metadata.updateRecordingIfStatus(input);
      },
    };
    const deletingService = createCloudRecordingService({
      metadata: wrappedMetadata,
      objectStorage,
    });

    const deleted = await deletingService.deleteRecording({
      ownerId: "owner-1",
      recordingId: created.value.recordingId,
    });
    const recording = await metadata.getRecording(created.value.recordingId);

    assert.equal(deleted.ok, false);
    if (deleted.ok) return;
    assert.equal(deleted.error.code, "not-found");
    assert.equal(recording?.status, terminalStatus);
  });
}

test("delete returns the persisted deletedAt when dirty soft-delete repair loses the conditional write race", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createMemoryObjectStorage();
  const baseService = createCloudRecordingService({ metadata, objectStorage });
  const pkg = await makePackage();
  const request = await makeCreateSessionRequest(pkg);
  const created = await baseService.createUploadSession({ ownerId: "owner-1", input: request });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const recording = await metadata.getRecording(created.value.recordingId);
  assert.ok(recording);
  await metadata.updateRecording({
    ...recording,
    status: "soft_deleted",
    deletedAt: null,
    updatedAt: "2026-05-27T00:05:00.000Z",
  });

  const persistedDeletedAt = "2026-05-27T00:06:00.000Z";
  let repairBeforeWrite = true;
  const wrappedMetadata = {
    ...metadata,
    async updateRecordingIfStatus(input: Parameters<typeof metadata.updateRecordingIfStatus>[0]) {
      if (repairBeforeWrite && input.expectedStatus === "soft_deleted" && input.patch.deletedAt) {
        repairBeforeWrite = false;
        const current = await metadata.getRecording(input.recordingId);
        assert.ok(current);
        const repaired = { ...current, deletedAt: persistedDeletedAt };
        await metadata.updateRecording(repaired);
        return { status: "status-mismatch" as const, current: repaired };
      }
      return metadata.updateRecordingIfStatus(input);
    },
  };
  const service = createCloudRecordingService({
    metadata: wrappedMetadata,
    objectStorage,
    now: () => new Date("2026-05-27T00:07:00.000Z"),
  });

  const deleted = await service.deleteRecording({
    ownerId: "owner-1",
    recordingId: created.value.recordingId,
  });
  const persisted = await metadata.getRecording(created.value.recordingId);

  assert.equal(deleted.ok, true);
  if (!deleted.ok) return;
  assert.equal(deleted.value.deletedAt, persistedDeletedAt);
  assert.equal(persisted?.deletedAt, persistedDeletedAt);
});

test("delete returns the persisted deletedAt when a concurrent soft-delete wins the delete write race", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createMemoryObjectStorage();
  const baseService = createCloudRecordingService({ metadata, objectStorage });
  const pkg = await makePackage();
  const request = await makeCreateSessionRequest(pkg);
  const created = await baseService.createUploadSession({ ownerId: "owner-1", input: request });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const persistedDeletedAt = "2026-05-27T00:08:00.000Z";
  let softDeleteBeforeWrite = true;
  let repairBeforeWrite = true;
  const wrappedMetadata = {
    ...metadata,
    async updateRecordingIfStatus(input: Parameters<typeof metadata.updateRecordingIfStatus>[0]) {
      if (
        softDeleteBeforeWrite &&
        input.expectedStatus === "uploading" &&
        input.patch.status === "soft_deleted"
      ) {
        softDeleteBeforeWrite = false;
        const current = await metadata.getRecording(input.recordingId);
        assert.ok(current);
        const dirtyDeleted = {
          ...current,
          status: "soft_deleted" as const,
          deletedAt: null,
          updatedAt: "2026-05-27T00:08:00.000Z",
        };
        await metadata.updateRecording(dirtyDeleted);
        return { status: "status-mismatch" as const, current: dirtyDeleted };
      }
      if (repairBeforeWrite && input.expectedStatus === "soft_deleted" && input.patch.deletedAt) {
        repairBeforeWrite = false;
        const current = await metadata.getRecording(input.recordingId);
        assert.ok(current);
        const repaired = { ...current, deletedAt: persistedDeletedAt };
        await metadata.updateRecording(repaired);
        return { status: "status-mismatch" as const, current: repaired };
      }
      return metadata.updateRecordingIfStatus(input);
    },
  };
  const service = createCloudRecordingService({
    metadata: wrappedMetadata,
    objectStorage,
    now: () => new Date("2026-05-27T00:09:00.000Z"),
  });

  const deleted = await service.deleteRecording({
    ownerId: "owner-1",
    recordingId: created.value.recordingId,
  });
  const persisted = await metadata.getRecording(created.value.recordingId);

  assert.equal(deleted.ok, true);
  if (!deleted.ok) return;
  assert.equal(deleted.value.deletedAt, persistedDeletedAt);
  assert.equal(persisted?.deletedAt, persistedDeletedAt);
});

test("createShareLink marks the ready recording as unlisted", async () => {
  const metadata = createMemoryMetadataRepository();
  const service = createCloudRecordingService({
    metadata,
    objectStorage: createMemoryObjectStorage(),
    now: () => new Date("2026-05-29T00:00:00.000Z"),
  });
  const pkg = await makePackage();
  const request = await makeCreateSessionRequest(pkg);
  const created = await service.createUploadSession({ ownerId: "owner-1", input: request });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const recording = await metadata.getRecording(created.value.recordingId);
  assert.ok(recording);
  await metadata.updateRecording({
    ...recording,
    status: "ready",
    updatedAt: "2026-05-29T00:00:00.000Z",
    completedAt: "2026-05-29T00:00:00.000Z",
  });

  const result = await service.createShareLink({
    ownerId: "owner-1",
    recordingId: created.value.recordingId,
    input: {},
  });
  const sharedRecording = await metadata.getRecording(created.value.recordingId);

  assert.equal(result.ok, true);
  assert.equal(sharedRecording?.visibility, "unlisted");
});

test("createShareLink rejects parseable non-ISO expiresAt strings", async () => {
  const metadata = createMemoryMetadataRepository();
  const service = createCloudRecordingService({
    metadata,
    objectStorage: createMemoryObjectStorage(),
    now: () => new Date("2026-05-29T00:00:00.000Z"),
  });
  const pkg = await makePackage();
  const request = await makeCreateSessionRequest(pkg);
  const created = await service.createUploadSession({ ownerId: "owner-1", input: request });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const recording = await metadata.getRecording(created.value.recordingId);
  assert.ok(recording);
  await metadata.updateRecording({
    ...recording,
    status: "ready",
    updatedAt: "2026-05-29T00:00:00.000Z",
    completedAt: "2026-05-29T00:00:00.000Z",
  });

  const result = await service.createShareLink({
    ownerId: "owner-1",
    recordingId: created.value.recordingId,
    input: { expiresAt: "May 30, 2026" },
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "bad-request");
  assert.equal(result.error.message, "expiresAt must be an ISO date string or null");
});

async function makePackage(): Promise<RecordingPackageV1> {
  const events: RecordingPackageV1["events"] = [];
  const snapshots: RecordingPackageV1["snapshots"] = [];
  return {
    schemaVersion: RECORDING_SCHEMA_VERSION,
    manifest: {
      packageId: "pkg-1",
      schemaVersion: RECORDING_SCHEMA_VERSION,
      status: "complete",
      createdAt: "2026-05-27T00:00:00.000Z",
      completedAt: "2026-05-27T00:01:00.000Z",
      checksums: {
        eventsSha256: await sha256Hex(canonicalStringify(events)),
        snapshotsSha256: await sha256Hex(canonicalStringify(snapshots)),
      },
    },
    meta: {
      id: "rec-1",
      title: "Cloud infra demo",
      createdAt: "2026-05-27T00:00:00.000Z",
      durationMs: 1000,
      appVersion: "0.0.0",
      ownerId: null,
      creatorInfo: null,
      initialLanguage: "javascript",
      initialFontSize: 14,
      initialTheme: "dark",
      mediaCapability: {
        audio: "unsupported",
        camera: "unsupported",
        selectedAudioDeviceId: null,
        selectedCameraDeviceId: null,
      },
    },
    events,
    snapshots,
    media: null,
  };
}

async function makeCreateSessionRequest(pkg: RecordingPackageV1): Promise<CreateUploadSessionRequest> {
  return {
    idempotencyKey: "idem-1",
    localPackageId: pkg.manifest.packageId,
    title: pkg.meta.title,
    schemaVersion: pkg.schemaVersion,
    durationMs: pkg.meta.durationMs,
    initialLanguage: pkg.meta.initialLanguage,
    hasAudio: false,
    hasCamera: false,
    assets: await Promise.all([
      asset("manifest", pkg.manifest),
      asset("meta", pkg.meta),
      asset("events", pkg.events),
      asset("snapshots", pkg.snapshots),
    ]),
  };
}

async function asset(kind: "manifest" | "meta" | "events" | "snapshots", value: unknown) {
  const body = canonicalStringify(value);
  return {
    kind,
    sha256: await sha256Hex(body),
    sizeBytes: new TextEncoder().encode(body).byteLength,
    mimeType: "application/json",
  };
}
