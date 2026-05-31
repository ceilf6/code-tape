import assert from "node:assert/strict";
import test from "node:test";
import { canonicalStringify, sha256Hex } from "@code-tape/recording-schema/hash";
import { RECORDING_SCHEMA_VERSION, type RecordingPackageV1 } from "@code-tape/recording-schema";
import { createCloudRecordingService } from "../../cloud/cloudRecordingService.js";
import { createAuthTokenService } from "../../cloud/authTokenService.js";
import { createMemoryMetadataRepository } from "../../cloud/memoryMetadataRepository.js";
import { buildLocalDevObjectUrl, createLocalDevObjectStorage } from "../../cloud/localDevObjectStorage.js";
import { createMemoryObjectStorage } from "../../cloud/memoryObjectStorage.js";
import { createApiHandler } from "../createApiHandler.js";
import { createCloudApiHandler } from "../cloudApiHandler.js";
import { createLocalDevObjectStorageHandler } from "../localDevObjectStorageHandler.js";
import type { MetadataRepository } from "../../cloud/metadataRepository.js";
import type { CloudRecordingAssetRecord, CloudRecordingRecord, RecordingAssetKind, RecordingStatus } from "../../cloud/types.js";

const NON_PLAYABLE_RECORDING_STATUSES = [
  "uploading",
  "processing",
  "failed",
  "soft_deleted",
  "purging",
  "deleted",
] as const satisfies readonly Exclude<RecordingStatus, "ready">[];

function createTestApiHandler(
  objectStorage: ReturnType<typeof createMemoryObjectStorage> | ReturnType<typeof createLocalDevObjectStorage>,
  createRequestId: () => string,
) {
  const service = createCloudRecordingService({
    metadata: createMemoryMetadataRepository(),
    objectStorage,
  });
  const cloud = createCloudApiHandler({ service, createRequestId });
  if ("claimPendingUploadTarget" in objectStorage) {
    return createApiHandler({
      cloud,
      objectStorage: createLocalDevObjectStorageHandler(objectStorage),
    });
  }
  return cloud;
}

test("POST /api/recordings/upload-sessions returns upload targets with request id", async () => {
  const objectStorage = createLocalDevObjectStorage({ publicBaseUrl: "http://localhost" });
  const handler = createTestApiHandler(objectStorage, () => "req-test-1");

  const response = await handler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: JSON.stringify(await makeCreateSessionRequest(await makePackage())),
    }),
  );
  const body = (await response.json()) as {
    sessionId: string;
    uploadTargets: Array<{ method: string; url: string }>;
  };

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-request-id"), "req-test-1");
  assert.ok(body.sessionId);
  assert.equal(body.uploadTargets[0]?.method, "PUT");
  assert.match(body.uploadTargets[0]?.url ?? "", /^http:\/\/localhost\/dev\/object-storage\/uploads\//u);
});

test("cloud API returns the unified error shape when owner token is missing", async () => {
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-test-2",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(await makeCreateSessionRequest(await makePackage())),
    }),
  );
  const body = (await response.json()) as {
    error: { code: string; message: string; requestId: string };
  };

  assert.equal(response.status, 401);
  assert.deepEqual(body, {
    error: {
      code: "unauthorized",
      message: "missing owner token",
      requestId: "req-test-2",
    },
  });
});

test("GET /api/recordings returns ready recordings for the current owner sorted by createdAt desc", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-ready-old", ownerId: "owner-1", status: "ready", createdAt: "2026-05-27T00:00:00.000Z" });
  await seedRecording(metadata, { id: "rec-ready-new", ownerId: "owner-1", status: "ready", createdAt: "2026-05-28T00:00:00.000Z", hasAudio: true });
  await seedRecording(metadata, { id: "rec-uploading", ownerId: "owner-1", status: "uploading", createdAt: "2026-05-29T00:00:00.000Z" });
  await seedRecording(metadata, { id: "rec-processing", ownerId: "owner-1", status: "processing" });
  await seedRecording(metadata, { id: "rec-failed", ownerId: "owner-1", status: "failed" });
  await seedRecording(metadata, { id: "rec-soft-deleted", ownerId: "owner-1", status: "soft_deleted" });
  await seedRecording(metadata, { id: "rec-purging", ownerId: "owner-1", status: "purging" });
  await seedRecording(metadata, { id: "rec-deleted", ownerId: "owner-1", status: "deleted" });
  await seedRecording(metadata, { id: "rec-other-owner", ownerId: "owner-2", status: "ready" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata,
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-list",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings", {
      method: "GET",
      headers: { "x-owner-token": "owner-1" },
    }),
  );
  const body = (await response.json()) as {
    items: Array<Record<string, unknown>>;
    nextCursor: string | null;
  };

  assert.equal(response.status, 200);
  assert.deepEqual(body.items.map((item) => item.id), ["rec-ready-new", "rec-ready-old"]);
  assert.equal(body.nextCursor, null);
  assert.deepEqual(Object.keys(body.items[0]!).sort(), [
    "createdAt",
    "durationMs",
    "hasAudio",
    "hasCamera",
    "id",
    "initialLanguage",
    "thumbnailUrl",
    "title",
    "visibility",
  ]);
  assert.equal(body.items[0]!.thumbnailUrl, null);
  assert.equal(body.items[0]!.visibility, "private");
  assert.equal(body.items[0]!.hasAudio, true);
});

test("GET /api/recordings paginates ready recordings without skipping the first page", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-ready-old", ownerId: "owner-1", status: "ready", createdAt: "2026-05-27T00:00:00.000Z" });
  await seedRecording(metadata, { id: "rec-ready-new", ownerId: "owner-1", status: "ready", createdAt: "2026-05-28T00:00:00.000Z" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata,
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-list-page",
  });

  const firstResponse = await handler(
    new Request("http://localhost/api/recordings?limit=1", {
      method: "GET",
      headers: { "x-owner-token": "owner-1" },
    }),
  );
  const firstBody = (await firstResponse.json()) as {
    items: Array<Record<string, unknown>>;
    nextCursor: string | null;
  };

  assert.equal(firstResponse.status, 200);
  assert.deepEqual(firstBody.items.map((item) => item.id), ["rec-ready-new"]);
  assert.equal(firstBody.nextCursor, "rec-ready-new");

  const secondResponse = await handler(
    new Request(`http://localhost/api/recordings?limit=1&cursor=${firstBody.nextCursor}`, {
      method: "GET",
      headers: { "x-owner-token": "owner-1" },
    }),
  );
  const secondBody = (await secondResponse.json()) as {
    items: Array<Record<string, unknown>>;
    nextCursor: string | null;
  };

  assert.equal(secondResponse.status, 200);
  assert.deepEqual(secondBody.items.map((item) => item.id), ["rec-ready-old"]);
  assert.equal(secondBody.nextCursor, null);
});

test("GET /api/recordings returns an empty list for owners with no ready recordings", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-processing", ownerId: "owner-1", status: "processing" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata,
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-empty-list",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings", {
      method: "GET",
      headers: { "x-owner-token": "owner-1" },
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { items: [], nextCursor: null });
});

test("GET /api/recordings requires owner token", async () => {
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-list-owner-token",
  });

  const response = await handler(new Request("http://localhost/api/recordings", { method: "GET" }));
  const body = (await response.json()) as { error: { code: string; message: string; requestId: string } };

  assert.equal(response.status, 401);
  assert.deepEqual(body, {
    error: {
      code: "unauthorized",
      message: "missing owner token",
      requestId: "req-list-owner-token",
    },
  });
});

for (const status of ["uploading", "processing", "ready", "failed"] as const) {
  test(`GET /api/recordings/:recordingId returns ${status} detail for the current owner`, async () => {
    const metadata = createMemoryMetadataRepository();
    await seedRecording(metadata, {
      id: `rec-${status}`,
      ownerId: "owner-1",
      status,
      failureCode: status === "failed" ? "invalid-manifest" : null,
      failureMessage: status === "failed" ? "manifest was invalid" : null,
    });
    const handler = createCloudApiHandler({
      service: createCloudRecordingService({
        metadata,
        objectStorage: createMemoryObjectStorage(),
      }),
      createRequestId: () => `req-detail-${status}`,
    });

    const response = await handler(
      new Request(`http://localhost/api/recordings/rec-${status}`, {
        method: "GET",
        headers: { "x-owner-token": "owner-1" },
      }),
    );
    const body = (await response.json()) as {
      recording: Record<string, unknown>;
      assets: Array<Record<string, unknown>>;
    };

    assert.equal(response.status, 200);
    assert.equal(body.recording.id, `rec-${status}`);
    assert.equal(body.recording.status, status);
    assert.equal(body.recording.localPackageId, `local-rec-${status}`);
    assert.deepEqual(body.assets, []);
    if (status === "failed") {
      assert.equal(body.recording.failureCode, "invalid-manifest");
      assert.equal(body.recording.failureMessage, "manifest was invalid");
    }
  });
}

test("GET /api/recordings/:recordingId returns recording and asset summaries envelope", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, {
    id: "rec-ready",
    ownerId: "owner-1",
    status: "ready",
    assets: [
      {
        id: "asset-manifest",
        recordingId: "rec-ready",
        kind: "manifest",
        objectKey: "recordings/rec-ready/package/manifest.json",
        sha256: "a".repeat(64),
        sizeBytes: 123,
        mimeType: "application/json",
        uploadedAt: "2026-05-27T00:00:00.000Z",
        validatedAt: "2026-05-27T00:00:01.000Z",
      },
    ],
  });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata,
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-detail-envelope",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-ready", {
      method: "GET",
      headers: { "x-owner-token": "owner-1" },
    }),
  );
  const body = (await response.json()) as {
    recording: Record<string, unknown>;
    assets: Array<Record<string, unknown>>;
  };

  assert.equal(response.status, 200);
  assert.equal(body.recording.id, "rec-ready");
  assert.deepEqual(body.assets, [
    {
      kind: "manifest",
      sizeBytes: 123,
      mimeType: "application/json",
      validatedAt: "2026-05-27T00:00:01.000Z",
    },
  ]);
});

test("GET /api/recordings/:recordingId returns 404 for other owners and hidden statuses", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-owner-2", ownerId: "owner-2", status: "ready" });
  await seedRecording(metadata, { id: "rec-soft-deleted", ownerId: "owner-1", status: "soft_deleted" });
  await seedRecording(metadata, { id: "rec-purging", ownerId: "owner-1", status: "purging" });
  await seedRecording(metadata, { id: "rec-deleted", ownerId: "owner-1", status: "deleted" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata,
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-detail-not-found",
  });

  for (const id of ["rec-owner-2", "rec-soft-deleted", "rec-purging", "rec-deleted", "rec-missing"]) {
    const response = await handler(
      new Request(`http://localhost/api/recordings/${id}`, {
        method: "GET",
        headers: { "x-owner-token": "owner-1" },
      }),
    );
    const body = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(response.status, 404);
    assert.deepEqual(body.error, {
      code: "not-found",
      message: "recording not found",
      requestId: "req-detail-not-found",
    });
  }
});

test("GET /api/recordings/:recordingId/playback returns playback descriptor for ready recordings", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createLocalDevObjectStorage({ publicBaseUrl: "http://localhost" });
  await seedRecordingWithAssets(metadata, {
    id: "rec-ready-playback",
    ownerId: "owner-1",
    status: "ready",
    hasAudio: true,
    hasCamera: true,
  }, ["manifest", "meta", "events", "snapshots", "indexes", "media", "thumbnail"]);
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage }),
    createRequestId: () => "req-playback-ready",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-ready-playback/playback", {
      method: "GET",
      headers: { "x-owner-token": "owner-1" },
    }),
  );
  const body = (await response.json()) as {
    id: string;
    title: string;
    durationMs: number;
    schemaVersion: string;
    manifestUrl: string;
    metaUrl: string;
    eventsUrl: string;
    snapshotsUrl: string;
    indexesUrl: string | null;
    mediaUrl: string | null;
    thumbnailUrl: string | null;
    expiresAt: string;
  };

  assert.equal(response.status, 200);
  assert.equal(body.id, "rec-ready-playback");
  assert.equal(body.title, "Recording rec-ready-playback");
  assert.equal(body.durationMs, 12345);
  assert.equal(body.schemaVersion, RECORDING_SCHEMA_VERSION);
  assert.equal(body.manifestUrl, buildLocalDevObjectUrl("http://localhost", "recordings/rec-ready-playback/package/manifest.json"));
  assert.equal(body.metaUrl, buildLocalDevObjectUrl("http://localhost", "recordings/rec-ready-playback/package/meta.json"));
  assert.equal(body.eventsUrl, buildLocalDevObjectUrl("http://localhost", "recordings/rec-ready-playback/package/events.json"));
  assert.equal(body.snapshotsUrl, buildLocalDevObjectUrl("http://localhost", "recordings/rec-ready-playback/package/snapshots.json"));
  assert.equal(body.indexesUrl, buildLocalDevObjectUrl("http://localhost", "recordings/rec-ready-playback/package/indexes.json"));
  assert.equal(body.mediaUrl, buildLocalDevObjectUrl("http://localhost", "recordings/rec-ready-playback/media/media.webm"));
  assert.equal(body.thumbnailUrl, buildLocalDevObjectUrl("http://localhost", "recordings/rec-ready-playback/thumbnails/poster.webp"));
  assert.match(body.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
});

test("GET /api/recordings/:recordingId/playback returns 404 for ready recordings missing required JSON assets", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createLocalDevObjectStorage({ publicBaseUrl: "http://localhost" });
  await seedRecordingWithAssets(metadata, {
    id: "rec-missing-snapshots",
    ownerId: "owner-1",
    status: "ready",
    hasAudio: false,
    hasCamera: false,
  }, ["manifest", "meta", "events"]);
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage }),
    createRequestId: () => "req-playback-missing-json",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-missing-snapshots/playback", {
      method: "GET",
      headers: { "x-owner-token": "owner-1" },
    }),
  );
  const body = (await response.json()) as { error: { code: string; message: string } };

  assert.equal(response.status, 404);
  assert.deepEqual(body.error, {
    code: "not-found",
    message: "playback descriptor not available",
    requestId: "req-playback-missing-json",
  });
});

test("GET /api/recordings/:recordingId/playback returns 404 for non-ready or owner-mismatched recordings", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecordingWithAssets(metadata, {
    id: "rec-owner-2-playback",
    ownerId: "owner-2",
    status: "ready",
    hasAudio: false,
    hasCamera: false,
  }, ["manifest", "meta", "events", "snapshots"]);
  for (const status of NON_PLAYABLE_RECORDING_STATUSES) {
    await seedRecordingWithAssets(metadata, {
      id: `rec-${status}-playback`,
      ownerId: "owner-1",
      status,
      hasAudio: false,
      hasCamera: false,
    }, ["manifest", "meta", "events", "snapshots"]);
  }
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage: createMemoryObjectStorage() }),
    createRequestId: () => "req-playback-not-found",
  });

  const notFoundPlaybackPaths = [
    "http://localhost/api/recordings/rec-owner-2-playback/playback",
    ...NON_PLAYABLE_RECORDING_STATUSES.map(
      (status) => `http://localhost/api/recordings/rec-${status}-playback/playback`,
    ),
  ];

  for (const path of notFoundPlaybackPaths) {
    const response = await handler(
      new Request(path, {
        method: "GET",
        headers: { "x-owner-token": "owner-1" },
      }),
    );
    const body = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(response.status, 404);
    assert.deepEqual(body.error, {
      code: "not-found",
      message: "recording not found",
      requestId: "req-playback-not-found",
    });
  }
});

test("GET /api/recordings/:recordingId/playback returns null for optional media/indexes when missing", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createLocalDevObjectStorage({ publicBaseUrl: "http://localhost" });
  await seedRecordingWithAssets(metadata, {
    id: "rec-no-media-no-indexes",
    ownerId: "owner-1",
    status: "ready",
    hasAudio: false,
    hasCamera: false,
  }, ["manifest", "meta", "events", "snapshots"]);
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage }),
    createRequestId: () => "req-playback-optional-null",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-no-media-no-indexes/playback", {
      method: "GET",
      headers: { "x-owner-token": "owner-1" },
    }),
  );
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.indexesUrl, null);
  assert.equal(body.mediaUrl, null);
  assert.equal(body.thumbnailUrl, null);
});

test("GET /api/recordings/:recordingId/playback requires owner token", async () => {
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-playback-owner-token",
  });

  const response = await handler(new Request("http://localhost/api/recordings/rec-1/playback", { method: "GET" }));
  const body = (await response.json()) as { error: { code: string; message: string; requestId: string } };

  assert.equal(response.status, 401);
  assert.deepEqual(body, {
    error: {
      code: "unauthorized",
      message: "missing owner token",
      requestId: "req-playback-owner-token",
    },
  });
});

test("POST /api/recordings/:recordingId/share-links creates a timestamped unlisted link for a ready owner recording", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecordingWithAssets(metadata, {
    id: "rec-share-ready",
    ownerId: "owner-1",
    status: "ready",
  }, ["manifest", "meta", "events", "snapshots"]);
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata,
      objectStorage: createMemoryObjectStorage(),
      now: () => new Date("2026-05-29T00:00:00.000Z"),
    }),
    createRequestId: () => "req-share-create",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-share-ready/share-links", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: JSON.stringify({ expiresAt: null, startTimeMs: 4_200 }),
    }),
  );
  const body = (await response.json()) as { url: string; expiresAt: string | null };
  const detailResponse = await handler(
    new Request("http://localhost/api/recordings/rec-share-ready", {
      method: "GET",
      headers: { "x-owner-token": "owner-1" },
    }),
  );
  const detailBody = (await detailResponse.json()) as {
    recording: { visibility: string };
  };

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-request-id"), "req-share-create");
  assert.match(body.url, /^\/s\/[A-Za-z0-9_-]+\?t=4200$/u);
  assert.equal(body.expiresAt, null);
  assert.equal(detailResponse.status, 200);
  assert.equal(detailBody.recording.visibility, "unlisted");
});

test("POST /api/recordings/:recordingId/share-links rejects parseable non-ISO expiresAt strings", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecordingWithAssets(metadata, {
    id: "rec-share-non-iso-expiry",
    ownerId: "owner-1",
    status: "ready",
  }, ["manifest", "meta", "events", "snapshots"]);
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata,
      objectStorage: createMemoryObjectStorage(),
      now: () => new Date("2026-05-29T00:00:00.000Z"),
    }),
    createRequestId: () => "req-share-non-iso-expiry",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-share-non-iso-expiry/share-links", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: JSON.stringify({ expiresAt: "May 30, 2026" }),
    }),
  );
  const body = (await response.json()) as { error: { code: string; message: string; requestId: string } };

  assert.equal(response.status, 400);
  assert.deepEqual(body, {
    error: {
      code: "bad-request",
      message: "expiresAt must be an ISO date string or null",
      requestId: "req-share-non-iso-expiry",
    },
  });
});

test("GET /api/share/:token/playback returns a shared playback descriptor without owner token", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createLocalDevObjectStorage({ publicBaseUrl: "http://localhost" });
  await seedRecordingWithAssets(metadata, {
    id: "rec-shared-playback",
    ownerId: "owner-1",
    status: "ready",
    hasAudio: true,
  }, ["manifest", "meta", "events", "snapshots", "media"]);
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata,
      objectStorage,
      now: () => new Date("2026-05-29T00:00:00.000Z"),
    }),
    createRequestId: () => "req-shared-playback",
  });

  const shareResponse = await handler(
    new Request("http://localhost/api/recordings/rec-shared-playback/share-links", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: JSON.stringify({ startTimeMs: 12_000 }),
    }),
  );
  const shareBody = (await shareResponse.json()) as { url: string };
  const token = shareBody.url.split("/s/")[1]!.split("?")[0]!;

  const response = await handler(
    new Request(`http://localhost/api/share/${token}/playback`, { method: "GET" }),
  );
  const body = (await response.json()) as { id: string; mediaUrl: string | null };

  assert.equal(shareResponse.status, 201);
  assert.equal(response.status, 200);
  assert.equal(body.id, "rec-shared-playback");
  assert.equal(body.mediaUrl, buildLocalDevObjectUrl("http://localhost", "recordings/rec-shared-playback/media/media.webm"));
});

test("GET /api/share/:token/playback returns the same 404 for random and malformed tokens", async () => {
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-shared-invalid",
  });

  const randomTokenResponse = await handler(
    new Request("http://localhost/api/share/not-a-real-token/playback", { method: "GET" }),
  );
  const malformedTokenResponse = await handler(
    new Request("http://localhost/api/share/%E0%A4%A/playback", { method: "GET" }),
  );
  const randomTokenBody = (await randomTokenResponse.json()) as {
    error: { code: string; message: string; requestId: string };
  };
  const malformedTokenBody = (await malformedTokenResponse.json()) as {
    error: { code: string; message: string; requestId: string };
  };

  assert.equal(randomTokenResponse.status, 404);
  assert.equal(malformedTokenResponse.status, 404);
  assert.deepEqual(randomTokenBody, {
    error: {
      code: "not-found",
      message: "share link not found",
      requestId: "req-shared-invalid",
    },
  });
  assert.deepEqual(malformedTokenBody, randomTokenBody);
});

test("POST /api/recordings/:recordingId/share-links returns 404 for owner mismatch and non-ready recordings", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecordingWithAssets(metadata, {
    id: "rec-share-other-owner",
    ownerId: "owner-2",
    status: "ready",
  }, ["manifest", "meta", "events", "snapshots"]);
  await seedRecordingWithAssets(metadata, {
    id: "rec-share-processing",
    ownerId: "owner-1",
    status: "processing",
  }, ["manifest", "meta", "events", "snapshots"]);
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata,
      objectStorage: createMemoryObjectStorage(),
      now: () => new Date("2026-05-29T00:00:00.000Z"),
    }),
    createRequestId: () => "req-share-not-found",
  });

  for (const id of ["rec-share-other-owner", "rec-share-processing", "rec-share-missing"]) {
    const response = await handler(
      new Request(`http://localhost/api/recordings/${id}/share-links`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-owner-token": "owner-1",
        },
        body: JSON.stringify({}),
      }),
    );
    const body = (await response.json()) as { error: { code: string; message: string; requestId: string } };

    assert.equal(response.status, 404);
    assert.deepEqual(body, {
      error: {
        code: "not-found",
        message: "recording not found",
        requestId: "req-share-not-found",
      },
    });
  }
});

test("GET /api/share/:token/playback returns 404 after the share expires or the recording is deleted", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecordingWithAssets(metadata, {
    id: "rec-share-expiring",
    ownerId: "owner-1",
    status: "ready",
  }, ["manifest", "meta", "events", "snapshots"]);
  await seedRecordingWithAssets(metadata, {
    id: "rec-share-deleted",
    ownerId: "owner-1",
    status: "ready",
  }, ["manifest", "meta", "events", "snapshots"]);
  let now = new Date("2026-05-29T00:00:00.000Z");
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata,
      objectStorage: createMemoryObjectStorage(),
      now: () => now,
    }),
    createRequestId: () => "req-shared-expired",
  });

  const expiringShare = await handler(
    new Request("http://localhost/api/recordings/rec-share-expiring/share-links", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: JSON.stringify({ expiresAt: "2026-05-30T00:00:00.000Z" }),
    }),
  );
  const deletedShare = await handler(
    new Request("http://localhost/api/recordings/rec-share-deleted/share-links", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: JSON.stringify({}),
    }),
  );
  const expiringToken = ((await expiringShare.json()) as { url: string }).url.split("/s/")[1]!;
  const deletedToken = ((await deletedShare.json()) as { url: string }).url.split("/s/")[1]!;

  now = new Date("2026-05-31T00:00:00.000Z");
  const expiredResponse = await handler(
    new Request(`http://localhost/api/share/${expiringToken}/playback`, { method: "GET" }),
  );

  now = new Date("2026-05-29T00:01:00.000Z");
  const deleteResponse = await handler(
    new Request("http://localhost/api/recordings/rec-share-deleted", {
      method: "DELETE",
      headers: { "x-owner-token": "owner-1" },
    }),
  );
  const deletedPlaybackResponse = await handler(
    new Request(`http://localhost/api/share/${deletedToken}/playback`, { method: "GET" }),
  );

  assert.equal(expiringShare.status, 201);
  assert.equal(deletedShare.status, 201);
  assert.equal(deleteResponse.status, 200);
  assert.equal(expiredResponse.status, 404);
  assert.equal(deletedPlaybackResponse.status, 404);
});

test("GET /api/recordings/:recordingId requires owner token", async () => {
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-detail-owner-token",
  });

  const response = await handler(new Request("http://localhost/api/recordings/rec-1", { method: "GET" }));
  const body = (await response.json()) as { error: { code: string; message: string; requestId: string } };

  assert.equal(response.status, 401);
  assert.deepEqual(body, {
    error: {
      code: "unauthorized",
      message: "missing owner token",
      requestId: "req-detail-owner-token",
    },
  });
});

test("GET /api/recordings/:recordingId returns unified error for malformed path encoding", async () => {
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-detail-malformed-path",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/%E0%A4%A", {
      method: "GET",
      headers: { "x-owner-token": "owner-1" },
    }),
  );
  const body = (await response.json()) as {
    error: { code: string; message: string; requestId: string };
  };

  assert.equal(response.status, 400);
  assert.deepEqual(body, {
    error: {
      code: "bad-request",
      message: "recordingId path segment is malformed",
      requestId: "req-detail-malformed-path",
    },
  });
});

for (const input of [
  { name: "empty", body: undefined },
  { name: "malformed JSON", body: '{"idempotencyKey":' },
  { name: "non-object JSON", body: JSON.stringify(["not", "an", "object"]) },
  {
    name: "missing assets",
    body: JSON.stringify({
      idempotencyKey: "idem-http-1",
      localPackageId: "pkg-1",
      title: "Cloud API demo",
      schemaVersion: RECORDING_SCHEMA_VERSION,
      durationMs: 1000,
      initialLanguage: "javascript",
      hasAudio: false,
      hasCamera: false,
    }),
  },
  {
    name: "non-array assets",
    body: JSON.stringify({
      ...(await makeCreateSessionRequest(await makePackage())),
      assets: "not-assets",
    }),
  },
  {
    name: "invalid asset field types",
    body: JSON.stringify({
      ...(await makeCreateSessionRequest(await makePackage())),
      assets: [{ kind: "manifest", sha256: 123, sizeBytes: "bad", mimeType: null }],
    }),
  },
  {
    name: "unknown asset kind",
    body: await makeCreateSessionBody((request) => ({
      ...request,
      assets: request.assets.map((asset) =>
        asset.kind === "manifest" ? { ...asset, kind: "trace" } : asset,
      ),
    })),
  },
  {
    name: "invalid asset checksum",
    body: await makeCreateSessionBody((request) => ({
      ...request,
      assets: request.assets.map((asset) =>
        asset.kind === "manifest" ? { ...asset, sha256: "sha256-placeholder" } : asset,
      ),
    })),
  },
  {
    name: "invalid asset size",
    body: await makeCreateSessionBody((request) => ({
      ...request,
      assets: request.assets.map((asset) =>
        asset.kind === "manifest" ? { ...asset, sizeBytes: -1 } : asset,
      ),
    })),
  },
  {
    name: "empty asset mime type",
    body: await makeCreateSessionBody((request) => ({
      ...request,
      assets: request.assets.map((asset) =>
        asset.kind === "manifest" ? { ...asset, mimeType: " " } : asset,
      ),
    })),
  },
] as const) {
  test(`cloud API returns the unified error shape for ${input.name} upload-session bodies`, async () => {
    const handler = createCloudApiHandler({
      service: createCloudRecordingService({
        metadata: createMemoryMetadataRepository(),
        objectStorage: createMemoryObjectStorage(),
      }),
      createRequestId: () => `req-${input.name}`,
    });

    const response = await handler(
      new Request("http://localhost/api/recordings/upload-sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-owner-token": "owner-1",
        },
        body: input.body,
      }),
    );
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };

    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      error: {
        code: "bad-request",
        message: "request body must be a valid JSON object",
        requestId: `req-${input.name}`,
      },
    });
  });
}

test("cloud API rejects duplicate upload-session asset kinds with the unified error shape", async () => {
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-duplicate-kind",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: await makeCreateSessionBody((request) => ({
        ...request,
        assets: [...request.assets, { ...request.assets[0]! }],
      })),
    }),
  );
  const body = (await response.json()) as {
    error: { code: string; message: string; requestId: string };
  };

  assert.equal(response.status, 422);
  assert.deepEqual(body, {
    error: {
      code: "invalid-manifest",
      message: "duplicate asset kind: manifest",
      requestId: "req-duplicate-kind",
    },
  });
});

for (const input of [
  {
    name: "blank idempotency key",
    body: await makeCreateSessionBody((request) => ({ ...request, idempotencyKey: " " })),
    message: "idempotencyKey must be 1 to 128 characters",
  },
  {
    name: "oversized idempotency key",
    body: await makeCreateSessionBody((request) => ({
      ...request,
      idempotencyKey: "i".repeat(129),
    })),
    message: "idempotencyKey must be 1 to 128 characters",
  },
  {
    name: "blank local package id",
    body: await makeCreateSessionBody((request) => ({ ...request, localPackageId: " " })),
    message: "localPackageId must be 1 to 128 characters",
  },
  {
    name: "oversized local package id",
    body: await makeCreateSessionBody((request) => ({
      ...request,
      localPackageId: "p".repeat(129),
    })),
    message: "localPackageId must be 1 to 128 characters",
  },
  {
    name: "negative duration",
    body: await makeCreateSessionBody((request) => ({ ...request, durationMs: -1 })),
    message: "durationMs must be a non-negative safe integer",
  },
  {
    name: "fractional duration",
    body: await makeCreateSessionBody((request) => ({ ...request, durationMs: 1.5 })),
    message: "durationMs must be a non-negative safe integer",
  },
  {
    name: "unsafe duration",
    body: await makeCreateSessionBody((request) => ({
      ...request,
      durationMs: Number.MAX_SAFE_INTEGER + 1,
    })),
    message: "durationMs must be a non-negative safe integer",
  },
  {
    name: "unsupported initial language",
    body: await makeCreateSessionBody((request) => ({ ...request, initialLanguage: "ruby" })),
    message: "initialLanguage must be one of javascript, typescript, python",
  },
] as const) {
  test(`cloud API rejects ${input.name} upload-session scalars with the unified error shape`, async () => {
    const handler = createCloudApiHandler({
      service: createCloudRecordingService({
        metadata: createMemoryMetadataRepository(),
        objectStorage: createMemoryObjectStorage(),
      }),
      createRequestId: () => `req-${input.name}`,
    });

    const response = await handler(
      new Request("http://localhost/api/recordings/upload-sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-owner-token": "owner-1",
        },
        body: input.body,
      }),
    );
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };

    assert.equal(response.status, 422);
    assert.deepEqual(body, {
      error: {
        code: "invalid-manifest",
        message: input.message,
        requestId: `req-${input.name}`,
      },
    });
  });
}

test("cloud API rejects idempotency key reuse with a different upload-session body", async () => {
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-idempotency-conflict",
  });
  const request = await makeCreateSessionRequest(await makePackage());
  const first = await handler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: JSON.stringify(request),
    }),
  );

  const second = await handler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: JSON.stringify({ ...request, localPackageId: "pkg-other" }),
    }),
  );
  const body = (await second.json()) as {
    error: { code: string; message: string; requestId: string };
  };

  assert.equal(first.status, 201);
  assert.equal(second.status, 409);
  assert.deepEqual(body, {
    error: {
      code: "upload-session-conflict",
      message: "idempotency key reused with a different upload request",
      requestId: "req-idempotency-conflict",
    },
  });
});

test("cloud API does not return upload targets after an upload session is completed", async () => {
  const service = createCloudRecordingService({
    metadata: createMemoryMetadataRepository(),
    objectStorage: createMemoryObjectStorage(),
  });
  const handler = createCloudApiHandler({
    service,
    createRequestId: () => "req-completed-idempotency",
  });
  const request = await makeCreateSessionRequest(await makePackage());
  const first = await handler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: JSON.stringify(request),
    }),
  );
  const firstBody = (await first.json()) as { sessionId: string };
  const completed = await service.completeUpload({
    ownerId: "owner-1",
    sessionId: firstBody.sessionId,
    input: { uploadedAssets: request.assets },
  });

  const retry = await handler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: JSON.stringify(request),
    }),
  );
  const body = (await retry.json()) as {
    error: { code: string; message: string; requestId: string };
  };

  assert.equal(first.status, 201);
  assert.equal(completed.ok, true);
  assert.equal(retry.status, 409);
  assert.deepEqual(body, {
    error: {
      code: "upload-session-conflict",
      message: "upload session is not open",
      requestId: "req-completed-idempotency",
    },
  });
});

// === POST /api/recordings/upload-sessions/:sessionId/complete 端点测试 ===

test("POST .../complete 首次调用返回 recordingId 与 processing 状态", async () => {
  const service = createCloudRecordingService({
    metadata: createMemoryMetadataRepository(),
    objectStorage: createMemoryObjectStorage(),
  });
  const handler = createCloudApiHandler({
    service,
    createRequestId: () => "req-complete-success",
  });
  const pkg = await makePackage();

  // 先创建上传会话
  const createResp = await handler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: JSON.stringify(await makeCreateSessionRequest(pkg)),
    }),
  );
  const createBody = (await createResp.json()) as { sessionId: string; recordingId: string };
  assert.equal(createResp.status, 201);

  // 调用 complete 端点
  const response = await handler(
    new Request(
      `http://localhost/api/recordings/upload-sessions/${createBody.sessionId}/complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-owner-token": "owner-1",
        },
        body: await makeCompleteBody(pkg),
      },
    ),
  );
  const body = (await response.json()) as {
    recordingId: string;
    status: string;
  };

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-request-id"), "req-complete-success");
  assert.equal(body.recordingId, createBody.recordingId);
  assert.equal(body.status, "processing");
});

test("POST .../complete 重复调用保持幂等，不退回状态", async () => {
  const service = createCloudRecordingService({
    metadata: createMemoryMetadataRepository(),
    objectStorage: createMemoryObjectStorage(),
  });
  const handler = createCloudApiHandler({
    service,
    createRequestId: () => "req-complete-idempotent",
  });
  const pkg = await makePackage();

  // 创建会话 + 首次 complete
  const createResp = await handler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: JSON.stringify(await makeCreateSessionRequest(pkg)),
    }),
  );
  const createBody = (await createResp.json()) as { sessionId: string; recordingId: string };
  const completeUrl = `http://localhost/api/recordings/upload-sessions/${createBody.sessionId}/complete`;
  const completeBody = await makeCompleteBody(pkg);

  const first = await handler(
    new Request(completeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: completeBody,
    }),
  );
  const firstJson = (await first.json()) as { recordingId: string; status: string };

  const second = await handler(
    new Request(completeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: completeBody,
    }),
  );
  const secondJson = (await second.json()) as { recordingId: string; status: string };

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(secondJson.recordingId, firstJson.recordingId);
  // 幂等：第二次返回当前 recording 状态（processing），不会回退
  assert.equal(secondJson.status, "processing");
});

test("POST .../complete 缺少 owner token 返回统一的 401 错误结构", async () => {
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-complete-no-owner",
  });

  const response = await handler(
    new Request(
      "http://localhost/api/recordings/upload-sessions/fake-session-id/complete",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uploadedAssets: [] }),
      },
    ),
  );
  const body = (await response.json()) as {
    error: { code: string; message: string; requestId: string };
  };

  assert.equal(response.status, 401);
  assert.deepEqual(body, {
    error: {
      code: "unauthorized",
      message: "missing owner token",
      requestId: "req-complete-no-owner",
    },
  });
});

// 非法请求体 → 400 测试矩阵
for (const input of [
  { name: "空 body", id: "empty", body: undefined },
  { name: "畸形 JSON", id: "malformed", body: '{"uploadedAssets":' },
  { name: "非对象 JSON", id: "non-object", body: JSON.stringify(["not", "an", "object"]) },
  {
    name: "缺失 uploadedAssets",
    id: "missing-assets",
    body: JSON.stringify({}),
  },
  {
    name: "uploadedAssets 非数组",
    id: "non-array-assets",
    body: JSON.stringify({ uploadedAssets: "not-an-array" }),
  },
  {
    name: "asset 字段类型错误",
    id: "bad-fields",
    body: JSON.stringify({
      uploadedAssets: [{ kind: "manifest", sha256: 123, sizeBytes: "bad" }],
    }),
  },
  {
    name: "顶层额外字段",
    id: "top-extra-key",
    body: JSON.stringify({
      uploadedAssets: [
        { kind: "manifest", sha256: "f".repeat(64), sizeBytes: 100 },
      ],
      extraField: "should-be-rejected",
    }),
  },
  {
    name: "asset 内额外字段",
    id: "asset-extra-key",
    body: JSON.stringify({
      uploadedAssets: [
        {
          kind: "manifest",
          sha256: "f".repeat(64),
          sizeBytes: 100,
          mimeType: "should-be-rejected",
        },
      ],
    }),
  },
] as const) {
  test(`POST .../complete 对 ${input.name} 返回统一的 400 错误结构`, async () => {
    const handler = createCloudApiHandler({
      service: createCloudRecordingService({
        metadata: createMemoryMetadataRepository(),
        objectStorage: createMemoryObjectStorage(),
      }),
      createRequestId: () => `req-complete-${input.id}`,
    });

    const response = await handler(
      new Request(
        "http://localhost/api/recordings/upload-sessions/fake-session-id/complete",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-owner-token": "owner-1",
          },
          body: input.body,
        },
      ),
    );
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };

    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      error: {
        code: "bad-request",
        message: "request body must be a valid JSON object",
        requestId: `req-complete-${input.id}`,
      },
    });
  });
}

test("POST .../complete owner 不匹配返回 403 forbidden", async () => {
  const metadata = createMemoryMetadataRepository();
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata,
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-complete-forbidden",
  });
  const pkg = await makePackage();

  // 以 owner-1 创建会话
  const createResp = await handler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: JSON.stringify(await makeCreateSessionRequest(pkg)),
    }),
  );
  const createBody = (await createResp.json()) as { sessionId: string };

  // 以 owner-2 尝试 complete
  const response = await handler(
    new Request(
      `http://localhost/api/recordings/upload-sessions/${createBody.sessionId}/complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-owner-token": "owner-2",
        },
        body: await makeCompleteBody(pkg),
      },
    ),
  );
  const body = (await response.json()) as {
    error: { code: string; message: string; requestId: string };
  };

  assert.equal(response.status, 403);
  assert.deepEqual(body, {
    error: {
      code: "forbidden",
      message: "upload session owner mismatch",
      requestId: "req-complete-forbidden",
    },
  });
});

test("POST .../complete session 不存在返回 404 not-found", async () => {
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-complete-not-found",
  });

  const response = await handler(
    new Request(
      "http://localhost/api/recordings/upload-sessions/nonexistent-session/complete",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-owner-token": "owner-1",
        },
        body: JSON.stringify({ uploadedAssets: [] }),
      },
    ),
  );
  const body = (await response.json()) as {
    error: { code: string; message: string; requestId: string };
  };

  assert.equal(response.status, 404);
  assert.deepEqual(body, {
    error: {
      code: "not-found",
      message: "upload session not found",
      requestId: "req-complete-not-found",
    },
  });
});

test("POST .../complete session 过期返回 410 upload-session-expired", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createMemoryObjectStorage();
  const t1 = Date.parse("2026-05-27T00:00:00.000Z");

  // 在时间点 t1 创建会话（TTL = 30 分钟）
  const createService = createCloudRecordingService({
    metadata,
    objectStorage,
    now: () => new Date(t1),
  });
  const createHandler = createCloudApiHandler({
    service: createService,
    createRequestId: () => "req-expired-create",
  });
  const pkg = await makePackage();
  const createResp = await createHandler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: JSON.stringify(await makeCreateSessionRequest(pkg)),
    }),
  );
  const createBody = (await createResp.json()) as { sessionId: string };
  assert.equal(createResp.status, 201);

  // 时间推进 31 分钟，会话已过期
  const t2 = Date.parse("2026-05-27T00:31:00.000Z");
  const expiredService = createCloudRecordingService({
    metadata,
    objectStorage,
    now: () => new Date(t2),
  });
  const expiredHandler = createCloudApiHandler({
    service: expiredService,
    createRequestId: () => "req-complete-expired",
  });

  const response = await expiredHandler(
    new Request(
      `http://localhost/api/recordings/upload-sessions/${createBody.sessionId}/complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-owner-token": "owner-1",
        },
        body: await makeCompleteBody(pkg),
      },
    ),
  );
  const body = (await response.json()) as {
    error: { code: string; message: string; requestId: string };
  };

  assert.equal(response.status, 410);
  assert.deepEqual(body, {
    error: {
      code: "upload-session-expired",
      message: "upload session expired",
      requestId: "req-complete-expired",
    },
  });
});

test("POST .../complete session 非 open 且非 completed 返回 409 conflict", async () => {
  const metadata = createMemoryMetadataRepository();
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata,
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-complete-conflict",
  });
  const pkg = await makePackage();
  const createReq = await makeCreateSessionRequest(pkg);
  const sessionId = "sess-conflict-1";
  const recordingId = "rec-conflict-1";

  // 直接向元数据仓库插入一条 status = "failed" 的 session（非 open 且非 completed）
  await metadata.createUpload({
    recording: {
      id: recordingId,
      ownerId: "owner-1",
      localPackageId: createReq.localPackageId,
      title: createReq.title,
      schemaVersion: createReq.schemaVersion,
      status: "uploading",
      visibility: "private",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z",
      completedAt: null,
      deletedAt: null,
      durationMs: createReq.durationMs,
      initialLanguage: createReq.initialLanguage,
      hasAudio: createReq.hasAudio,
      hasCamera: createReq.hasCamera,
      totalSizeBytes: 0,
      eventCount: null,
      snapshotCount: null,
      failureCode: null,
      failureMessage: null,
    },
    assets: createReq.assets.map((asset, i) => ({
      id: `asset-conflict-${i}`,
      recordingId,
      kind: asset.kind,
      objectKey: `key-conflict-${i}`,
      sha256: asset.sha256,
      sizeBytes: asset.sizeBytes,
      mimeType: asset.mimeType,
      uploadedAt: null,
      validatedAt: null,
    })),
    session: {
      id: sessionId,
      recordingId,
      ownerId: "owner-1",
      status: "failed", // 非 open 且非 completed → 触发 409
      expiresAt: "2026-05-28T00:00:00.000Z", // 远未过期
      idempotencyKey: "idem-conflict-1",
      createdAt: "2026-05-27T00:00:00.000Z",
      completedAt: null,
    },
  });

  const response = await handler(
    new Request(
      `http://localhost/api/recordings/upload-sessions/${sessionId}/complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-owner-token": "owner-1",
        },
        body: await makeCompleteBody(pkg),
      },
    ),
  );
  const body = (await response.json()) as {
    error: { code: string; message: string; requestId: string };
  };

  assert.equal(response.status, 409);
  assert.deepEqual(body, {
    error: {
      code: "upload-session-conflict",
      message: "upload session is not open",
      requestId: "req-complete-conflict",
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/recordings/:recordingId — rename
// ─────────────────────────────────────────────────────────────────────────────

test("PATCH /api/recordings/:recordingId renames a ready recording for the owner", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-ready", ownerId: "owner-1", status: "ready" });
  const objectStorage = createMemoryObjectStorage();
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage }),
    createRequestId: () => "req-rename",
  });

  // Seed an object in storage to verify rename doesn't touch it
  await objectStorage.putObject({
    key: "recordings/rec-ready/package/meta.json",
    body: new TextEncoder().encode(JSON.stringify({ title: "Old Title" })),
    contentType: "application/json",
  });
  const objectBefore = await objectStorage.getObject("recordings/rec-ready/package/meta.json");

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-ready", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-owner-token": "owner-1" },
      body: JSON.stringify({ title: "New Title" }),
    }),
  );
  const body = (await response.json()) as { id: string; title: string; updatedAt: string };

  assert.equal(response.status, 200);
  assert.equal(body.id, "rec-ready");
  assert.equal(body.title, "New Title");
  assert.ok(body.updatedAt);

  // Verify the detail endpoint returns the new title
  const detailResponse = await handler(
    new Request("http://localhost/api/recordings/rec-ready", {
      method: "GET",
      headers: { "x-owner-token": "owner-1" },
    }),
  );
  const detailBody = (await detailResponse.json()) as { recording: { title: string } };
  assert.equal(detailBody.recording.title, "New Title");

  // Verify object storage was NOT modified (metadata-only update)
  const objectAfter = await objectStorage.getObject("recordings/rec-ready/package/meta.json");
  assert.deepEqual(objectAfter, objectBefore, "rename must not rewrite object storage");
});

test("PATCH /api/recordings/:recordingId trims whitespace from title", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-ready", ownerId: "owner-1", status: "ready" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage: createMemoryObjectStorage() }),
    createRequestId: () => "req-trim",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-ready", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-owner-token": "owner-1" },
      body: JSON.stringify({ title: "   Trimmed Title   " }),
    }),
  );
  const body = (await response.json()) as { title: string };

  assert.equal(response.status, 200);
  assert.equal(body.title, "Trimmed Title");
});

test("PATCH /api/recordings/:recordingId rejects empty title", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-ready", ownerId: "owner-1", status: "ready" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage: createMemoryObjectStorage() }),
    createRequestId: () => "req-empty-title",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-ready", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-owner-token": "owner-1" },
      body: JSON.stringify({ title: "" }),
    }),
  );
  const body = (await response.json()) as { error: { code: string; message: string; requestId: string } };

  assert.equal(response.status, 400);
  assert.deepEqual(body, {
    error: {
      code: "bad-request",
      message: "title must be 1 to 80 characters",
      requestId: "req-empty-title",
    },
  });
});

test("PATCH /api/recordings/:recordingId rejects whitespace-only title", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-ready", ownerId: "owner-1", status: "ready" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage: createMemoryObjectStorage() }),
    createRequestId: () => "req-ws-title",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-ready", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-owner-token": "owner-1" },
      body: JSON.stringify({ title: "   " }),
    }),
  );
  const body = (await response.json()) as { error: { code: string } };

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "bad-request");
});

test("PATCH /api/recordings/:recordingId rejects title exceeding 80 characters", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-ready", ownerId: "owner-1", status: "ready" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage: createMemoryObjectStorage() }),
    createRequestId: () => "req-long-title",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-ready", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-owner-token": "owner-1" },
      body: JSON.stringify({ title: "a".repeat(81) }),
    }),
  );
  const body = (await response.json()) as { error: { code: string } };

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "bad-request");
});

test("PATCH /api/recordings/:recordingId accepts an 80 Unicode code point title", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-ready", ownerId: "owner-1", status: "ready" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage: createMemoryObjectStorage() }),
    createRequestId: () => "req-unicode-title",
  });
  const title = "🔥".repeat(80);

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-ready", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-owner-token": "owner-1" },
      body: JSON.stringify({ title }),
    }),
  );
  const body = (await response.json()) as { title: string };

  assert.equal(response.status, 200);
  assert.equal(body.title, title);
});

test("PATCH /api/recordings/:recordingId rejects an 81 Unicode code point title", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-ready", ownerId: "owner-1", status: "ready" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage: createMemoryObjectStorage() }),
    createRequestId: () => "req-long-unicode-title",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-ready", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-owner-token": "owner-1" },
      body: JSON.stringify({ title: "🔥".repeat(81) }),
    }),
  );
  const body = (await response.json()) as { error: { code: string; message: string } };

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "bad-request");
  assert.equal(body.error.message, "title must be 1 to 80 characters");
});

test("PATCH /api/recordings/:recordingId rejects non-string title", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-ready", ownerId: "owner-1", status: "ready" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage: createMemoryObjectStorage() }),
    createRequestId: () => "req-bad-title",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-ready", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-owner-token": "owner-1" },
      body: JSON.stringify({ title: 123 }),
    }),
  );
  const body = (await response.json()) as { error: { code: string } };

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "bad-request");
});

test("PATCH /api/recordings/:recordingId rejects missing title", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-ready", ownerId: "owner-1", status: "ready" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage: createMemoryObjectStorage() }),
    createRequestId: () => "req-missing-title",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-ready", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-owner-token": "owner-1" },
      body: JSON.stringify({}),
    }),
  );
  const body = (await response.json()) as {
    error: { code: string; message: string; requestId: string };
  };

  assert.equal(response.status, 400);
  assert.deepEqual(body, {
    error: {
      code: "bad-request",
      message: "title is required",
      requestId: "req-missing-title",
    },
  });
});

test("PATCH /api/recordings/:recordingId reports non-string title with a specific error", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-ready", ownerId: "owner-1", status: "ready" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage: createMemoryObjectStorage() }),
    createRequestId: () => "req-bad-title-message",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-ready", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-owner-token": "owner-1" },
      body: JSON.stringify({ title: 123 }),
    }),
  );
  const body = (await response.json()) as {
    error: { code: string; message: string; requestId: string };
  };

  assert.equal(response.status, 400);
  assert.deepEqual(body, {
    error: {
      code: "bad-request",
      message: "title must be a string",
      requestId: "req-bad-title-message",
    },
  });
});

test("PATCH /api/recordings/:recordingId rejects extra fields in body", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-ready", ownerId: "owner-1", status: "ready" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage: createMemoryObjectStorage() }),
    createRequestId: () => "req-extra",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-ready", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-owner-token": "owner-1" },
      body: JSON.stringify({ title: "New Title", extra: "field" }),
    }),
  );
  const body = (await response.json()) as { error: { code: string } };

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "bad-request");
});

test("PATCH /api/recordings/:recordingId rejects empty body without title", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-ready", ownerId: "owner-1", status: "ready" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage: createMemoryObjectStorage() }),
    createRequestId: () => "req-empty-body",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-ready", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-owner-token": "owner-1" },
      body: JSON.stringify({}),
    }),
  );
  const body = (await response.json()) as { error: { code: string; message: string } };

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "bad-request");
  assert.equal(body.error.message, "title is required");
});

test("PATCH /api/recordings/:recordingId reports unknown fields with a specific error", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-ready", ownerId: "owner-1", status: "ready" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage: createMemoryObjectStorage() }),
    createRequestId: () => "req-extra-message",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-ready", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-owner-token": "owner-1" },
      body: JSON.stringify({ title: "New Title", extra: "field" }),
    }),
  );
  const body = (await response.json()) as {
    error: { code: string; message: string; requestId: string };
  };

  assert.equal(response.status, 400);
  assert.deepEqual(body, {
    error: {
      code: "bad-request",
      message: "unknown field: extra",
      requestId: "req-extra-message",
    },
  });
});

test("PATCH /api/recordings/:recordingId returns 404 for non-owner", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-ready", ownerId: "owner-1", status: "ready" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage: createMemoryObjectStorage() }),
    createRequestId: () => "req-notowner",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-ready", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-owner-token": "owner-2" },
      body: JSON.stringify({ title: "Hacked Title" }),
    }),
  );
  const body = (await response.json()) as { error: { code: string } };

  assert.equal(response.status, 404);
  assert.equal(body.error.code, "not-found");
});

test("PATCH /api/recordings/:recordingId returns 404 for soft_deleted recording", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-deleted", ownerId: "owner-1", status: "soft_deleted" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage: createMemoryObjectStorage() }),
    createRequestId: () => "req-deleted",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-deleted", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-owner-token": "owner-1" },
      body: JSON.stringify({ title: "New Title" }),
    }),
  );
  const body = (await response.json()) as { error: { code: string } };

  assert.equal(response.status, 404);
  assert.equal(body.error.code, "not-found");
});

test("PATCH /api/recordings/:recordingId returns 404 for purging and deleted recordings", async () => {
  for (const status of ["purging", "deleted"] as const) {
    const metadata = createMemoryMetadataRepository();
    await seedRecording(metadata, { id: `rec-${status}`, ownerId: "owner-1", status });
    const handler = createCloudApiHandler({
      service: createCloudRecordingService({ metadata, objectStorage: createMemoryObjectStorage() }),
      createRequestId: () => `req-patch-${status}`,
    });

    const response = await handler(
      new Request(`http://localhost/api/recordings/rec-${status}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-owner-token": "owner-1" },
        body: JSON.stringify({ title: "New Title" }),
      }),
    );
    const body = (await response.json()) as { error: { code: string } };

    assert.equal(response.status, 404, `expected 404 for ${status} recording`);
    assert.equal(body.error.code, "not-found");
  }
});

test("PATCH /api/recordings/:recordingId requires owner token", async () => {
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-no-token",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-ready", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "New Title" }),
    }),
  );
  const body = (await response.json()) as { error: { code: string } };

  assert.equal(response.status, 401);
  assert.equal(body.error.code, "unauthorized");
});

for (const status of ["uploading", "processing", "failed"] as const) {
  test(`PATCH /api/recordings/:recordingId renames ${status} recording`, async () => {
    const metadata = createMemoryMetadataRepository();
    await seedRecording(metadata, { id: `rec-${status}`, ownerId: "owner-1", status });
    const handler = createCloudApiHandler({
      service: createCloudRecordingService({ metadata, objectStorage: createMemoryObjectStorage() }),
      createRequestId: () => `req-rename-${status}`,
    });

    const response = await handler(
      new Request(`http://localhost/api/recordings/rec-${status}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-owner-token": "owner-1" },
        body: JSON.stringify({ title: "Renamed" }),
      }),
    );

    assert.equal(response.status, 200);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/recordings/:recordingId — soft delete
// ─────────────────────────────────────────────────────────────────────────────

test("DELETE /api/recordings/:recordingId soft-deletes a ready recording", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-ready", ownerId: "owner-1", status: "ready" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage: createMemoryObjectStorage() }),
    createRequestId: () => "req-delete",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-ready", {
      method: "DELETE",
      headers: { "x-owner-token": "owner-1" },
    }),
  );
  const body = (await response.json()) as { id: string; status: string; deletedAt: string };

  assert.equal(response.status, 200);
  assert.equal(body.id, "rec-ready");
  assert.equal(body.status, "soft_deleted");
  assert.ok(body.deletedAt);

  // Verify the recording is no longer in the list
  const listResponse = await handler(
    new Request("http://localhost/api/recordings", {
      method: "GET",
      headers: { "x-owner-token": "owner-1" },
    }),
  );
  const listBody = (await listResponse.json()) as { items: Array<{ id: string }> };
  assert.deepEqual(listBody.items.map((item) => item.id), []);

  // Verify the detail endpoint returns 404
  const detailResponse = await handler(
    new Request("http://localhost/api/recordings/rec-ready", {
      method: "GET",
      headers: { "x-owner-token": "owner-1" },
    }),
  );
  assert.equal(detailResponse.status, 404);
});

test("DELETE /api/recordings/:recordingId is idempotent on soft_deleted recording", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-deleted", ownerId: "owner-1", status: "soft_deleted" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage: createMemoryObjectStorage() }),
    createRequestId: () => "req-idempotent",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-deleted", {
      method: "DELETE",
      headers: { "x-owner-token": "owner-1" },
    }),
  );
  const body = (await response.json()) as { id: string; status: string; deletedAt: string };

  // Already soft_deleted by same owner → idempotent success response
  assert.equal(response.status, 200);
  assert.equal(body.id, "rec-deleted");
  assert.equal(body.status, "soft_deleted");
  assert.ok(body.deletedAt);
});

test("DELETE /api/recordings/:recordingId handles soft_deleted with null deletedAt and persists it", async () => {
  const metadata = createMemoryMetadataRepository();
  // Seed a soft_deleted recording, then manually set deletedAt to null (dirty data)
  await seedRecording(metadata, { id: "rec-null-deleted", ownerId: "owner-1", status: "soft_deleted" });
  const recording = await metadata.getRecording("rec-null-deleted");
  await metadata.updateRecording({ ...recording!, deletedAt: null });

  const handler = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage: createMemoryObjectStorage() }),
    createRequestId: () => "req-null-deleted",
  });

  // First DELETE: should generate and persist a deletedAt
  const response1 = await handler(
    new Request("http://localhost/api/recordings/rec-null-deleted", {
      method: "DELETE",
      headers: { "x-owner-token": "owner-1" },
    }),
  );
  const body1 = (await response1.json()) as { id: string; status: string; deletedAt: string };
  assert.equal(response1.status, 200);
  assert.equal(body1.status, "soft_deleted");
  assert.ok(body1.deletedAt);
  assert.equal(typeof body1.deletedAt, "string");

  // Verify metadata was actually persisted
  const persisted = await metadata.getRecording("rec-null-deleted");
  assert.equal(persisted!.deletedAt, body1.deletedAt);

  // Second DELETE: should return the same persisted deletedAt, not a new one
  const response2 = await handler(
    new Request("http://localhost/api/recordings/rec-null-deleted", {
      method: "DELETE",
      headers: { "x-owner-token": "owner-1" },
    }),
  );
  const body2 = (await response2.json()) as { id: string; status: string; deletedAt: string };
  assert.equal(response2.status, 200);
  assert.equal(body2.deletedAt, body1.deletedAt, "repeated DELETE must return the same persisted deletedAt");
});

test("DELETE /api/recordings/:recordingId repeated delete preserves deletedAt and does not mutate state", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-ready", ownerId: "owner-1", status: "ready" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage: createMemoryObjectStorage() }),
    createRequestId: () => "req-repeat-del",
  });

  // First delete
  const first = await handler(
    new Request("http://localhost/api/recordings/rec-ready", {
      method: "DELETE",
      headers: { "x-owner-token": "owner-1" },
    }),
  );
  const firstBody = (await first.json()) as { id: string; status: string; deletedAt: string };
  assert.equal(first.status, 200);

  // Second delete — idempotent success with same deletedAt
  const second = await handler(
    new Request("http://localhost/api/recordings/rec-ready", {
      method: "DELETE",
      headers: { "x-owner-token": "owner-1" },
    }),
  );
  const secondBody = (await second.json()) as { id: string; status: string; deletedAt: string };
  assert.equal(second.status, 200);
  assert.equal(secondBody.id, firstBody.id);
  assert.equal(secondBody.status, "soft_deleted");
  assert.equal(secondBody.deletedAt, firstBody.deletedAt);
});

test("DELETE /api/recordings/:recordingId returns 404 for purging and deleted recordings", async () => {
  for (const status of ["purging", "deleted"] as const) {
    const metadata = createMemoryMetadataRepository();
    await seedRecording(metadata, { id: `rec-${status}`, ownerId: "owner-1", status });
    const handler = createCloudApiHandler({
      service: createCloudRecordingService({ metadata, objectStorage: createMemoryObjectStorage() }),
      createRequestId: () => `req-del-${status}`,
    });

    const response = await handler(
      new Request(`http://localhost/api/recordings/rec-${status}`, {
        method: "DELETE",
        headers: { "x-owner-token": "owner-1" },
      }),
    );
    const body = (await response.json()) as { error: { code: string } };

    assert.equal(response.status, 404, `expected 404 for ${status} recording`);
    assert.equal(body.error.code, "not-found");
  }
});

test("DELETE /api/recordings/:recordingId returns 404 for non-owner", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-ready", ownerId: "owner-1", status: "ready" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage: createMemoryObjectStorage() }),
    createRequestId: () => "req-notowner-del",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-ready", {
      method: "DELETE",
      headers: { "x-owner-token": "owner-2" },
    }),
  );
  const body = (await response.json()) as { error: { code: string } };

  assert.equal(response.status, 404);
  assert.equal(body.error.code, "not-found");
});

test("DELETE /api/recordings/:recordingId returns 404 for non-existent recording", async () => {
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-nf",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-nonexistent", {
      method: "DELETE",
      headers: { "x-owner-token": "owner-1" },
    }),
  );
  const body = (await response.json()) as { error: { code: string } };

  assert.equal(response.status, 404);
  assert.equal(body.error.code, "not-found");
});

test("DELETE /api/recordings/:recordingId requires owner token", async () => {
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-no-token-del",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/rec-ready", {
      method: "DELETE",
    }),
  );
  const body = (await response.json()) as { error: { code: string } };

  assert.equal(response.status, 401);
  assert.equal(body.error.code, "unauthorized");
});

for (const status of ["uploading", "processing", "failed"] as const) {
  test(`DELETE /api/recordings/:recordingId soft-deletes ${status} recording`, async () => {
    const metadata = createMemoryMetadataRepository();
    await seedRecording(metadata, { id: `rec-${status}`, ownerId: "owner-1", status });
    const handler = createCloudApiHandler({
      service: createCloudRecordingService({ metadata, objectStorage: createMemoryObjectStorage() }),
      createRequestId: () => `req-delete-${status}`,
    });

    const response = await handler(
      new Request(`http://localhost/api/recordings/rec-${status}`, {
        method: "DELETE",
        headers: { "x-owner-token": "owner-1" },
      }),
    );
    const body = (await response.json()) as { status: string };

    assert.equal(response.status, 200);
    assert.equal(body.status, "soft_deleted");
  });
}

test("DELETE /api/recordings/:recordingId does not affect other owners' recordings", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-owner1", ownerId: "owner-1", status: "ready" });
  await seedRecording(metadata, { id: "rec-owner2", ownerId: "owner-2", status: "ready" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage: createMemoryObjectStorage() }),
    createRequestId: () => "req-isolate",
  });

  // owner-1 deletes their own recording
  const deleteResponse = await handler(
    new Request("http://localhost/api/recordings/rec-owner1", {
      method: "DELETE",
      headers: { "x-owner-token": "owner-1" },
    }),
  );
  assert.equal(deleteResponse.status, 200);

  // owner-2's recording should still be accessible
  const detailResponse = await handler(
    new Request("http://localhost/api/recordings/rec-owner2", {
      method: "GET",
      headers: { "x-owner-token": "owner-2" },
    }),
  );
  assert.equal(detailResponse.status, 200);
});

test("DELETE uploading recording then POST complete returns 404 and does not revive", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createMemoryObjectStorage();
  const service = createCloudRecordingService({ metadata, objectStorage });
  const handler = createCloudApiHandler({
    service,
    createRequestId: () => "req-delete-then-complete",
  });
  const pkg = await makePackage();

  // Create upload session
  const createResp = await handler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-owner-token": "owner-1" },
      body: JSON.stringify(await makeCreateSessionRequest(pkg)),
    }),
  );
  const createBody = (await createResp.json()) as { sessionId: string; recordingId: string };
  assert.equal(createResp.status, 201);

  // Delete the uploading recording
  const deleteResp = await handler(
    new Request(`http://localhost/api/recordings/${createBody.recordingId}`, {
      method: "DELETE",
      headers: { "x-owner-token": "owner-1" },
    }),
  );
  assert.equal(deleteResp.status, 200);

  // Now try to complete — should fail with 404 and not revive the recording
  const completeResp = await handler(
    new Request(
      `http://localhost/api/recordings/upload-sessions/${createBody.sessionId}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-owner-token": "owner-1" },
        body: await makeCompleteBody(pkg),
      },
    ),
  );
  assert.equal(completeResp.status, 404);

  // Verify recording is still soft_deleted
  const detailResp = await handler(
    new Request(`http://localhost/api/recordings/${createBody.recordingId}`, {
      method: "GET",
      headers: { "x-owner-token": "owner-1" },
    }),
  );
  assert.equal(detailResp.status, 404);

  // Also verify via metadata directly
  const recording = await metadata.getRecording(createBody.recordingId);
  assert.equal(recording?.status, "soft_deleted");
});

test("POST /api/auth/token issues a Bearer access token from a refresh token", async () => {
  const handler = createAuthEnabledHandler(() => "req-auth-1");
  const response = await handler(
    new Request("http://localhost/api/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "device-token-aaaaaaaa" }),
    }),
  );
  const body = (await response.json()) as {
    accessToken: string;
    expiresAt: number;
    tokenType: string;
  };
  assert.equal(response.status, 200);
  assert.equal(body.tokenType, "Bearer");
  assert.ok(body.accessToken.includes("."));
  assert.ok(body.expiresAt > Date.now());
});

test("POST /api/auth/token rejects a missing refresh token", async () => {
  const handler = createAuthEnabledHandler(() => "req-auth-2");
  const response = await handler(
    new Request("http://localhost/api/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  assert.equal(response.status, 400);
});

test("GET /api/recordings accepts a valid Bearer access token", async () => {
  const handler = createAuthEnabledHandler(() => "req-auth-3");
  const tokenResp = await handler(
    new Request("http://localhost/api/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "device-token-aaaaaaaa" }),
    }),
  );
  const { accessToken } = (await tokenResp.json()) as { accessToken: string };

  const response = await handler(
    new Request("http://localhost/api/recordings", {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  );
  assert.equal(response.status, 200);
});

test("GET /api/recordings rejects a tampered Bearer token", async () => {
  const handler = createAuthEnabledHandler(() => "req-auth-4");
  const response = await handler(
    new Request("http://localhost/api/recordings", {
      method: "GET",
      headers: { authorization: "Bearer not.a.validtoken" },
    }),
  );
  assert.equal(response.status, 401);
});

test("GET /api/recordings still accepts the legacy x-owner-token header", async () => {
  const handler = createAuthEnabledHandler(() => "req-auth-5");
  const response = await handler(
    new Request("http://localhost/api/recordings", {
      method: "GET",
      headers: { "x-owner-token": "owner-1" },
    }),
  );
  assert.equal(response.status, 200);
});

test("POST /api/auth/token works even when auth is not explicitly injected", async () => {
  // 不显式注入 auth：handler 应默认构造 auth service，使 token 端点始终可用，
  // 避免新前端在缺省装配点拿到 404。
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-auth-default",
  });
  const tokenResp = await handler(
    new Request("http://localhost/api/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "device-token-default" }),
    }),
  );
  const body = (await tokenResp.json()) as { accessToken: string; tokenType: string };
  assert.equal(tokenResp.status, 200);
  assert.equal(body.tokenType, "Bearer");

  // 用拿到的 token 访问业务端点应成功。
  const listResp = await handler(
    new Request("http://localhost/api/recordings", {
      method: "GET",
      headers: { authorization: `Bearer ${body.accessToken}` },
    }),
  );
  assert.equal(listResp.status, 200);
});

function createAuthEnabledHandler(createRequestId: () => string) {
  const service = createCloudRecordingService({
    metadata: createMemoryMetadataRepository(),
    objectStorage: createMemoryObjectStorage(),
  });
  return createCloudApiHandler({
    service,
    auth: createAuthTokenService({ secret: "test-secret" }),
    createRequestId,
  });
}

async function makeCompleteBody(pkg: RecordingPackageV1): Promise<string> {
  const req = await makeCreateSessionRequest(pkg);
  return JSON.stringify({
    uploadedAssets: req.assets.map(({ kind, sha256, sizeBytes }) => ({
      kind,
      sha256,
      sizeBytes,
    })),
  });
}

async function seedRecording(
  metadata: MetadataRepository,
  input: {
    id: string;
    ownerId: string;
    status: RecordingStatus;
    createdAt?: string;
    hasAudio?: boolean;
    hasCamera?: boolean;
    failureCode?: CloudRecordingRecord["failureCode"];
    failureMessage?: string | null;
    assets?: CloudRecordingAssetRecord[];
  },
): Promise<void> {
  const createdAt = input.createdAt ?? "2026-05-27T00:00:00.000Z";
  const deletedAt = input.status === "soft_deleted" ? createdAt : null;
  await metadata.createUpload({
    recording: {
      id: input.id,
      ownerId: input.ownerId,
      localPackageId: `local-${input.id}`,
      title: `Recording ${input.id}`,
      schemaVersion: RECORDING_SCHEMA_VERSION,
      status: input.status,
      visibility: "private",
      createdAt,
      updatedAt: createdAt,
      completedAt: input.status === "ready" ? createdAt : null,
      deletedAt,
      durationMs: 12_345,
      initialLanguage: "javascript",
      hasAudio: input.hasAudio ?? false,
      hasCamera: input.hasCamera ?? false,
      totalSizeBytes: 1024,
      eventCount: 7,
      snapshotCount: 2,
      failureCode: input.failureCode ?? null,
      failureMessage: input.failureMessage ?? null,
    },
    assets: input.assets ?? [],
    session: {
      id: `session-${input.id}`,
      recordingId: input.id,
      ownerId: input.ownerId,
      status: "completed",
      expiresAt: "2026-05-28T00:00:00.000Z",
      idempotencyKey: `idem-${input.id}`,
      createdAt,
      completedAt: createdAt,
    },
  });
}

async function seedRecordingWithAssets(
  metadata: MetadataRepository,
  input: {
    id: string;
    ownerId: string;
    status: RecordingStatus;
    createdAt?: string;
    hasAudio?: boolean;
    hasCamera?: boolean;
    failureCode?: CloudRecordingRecord["failureCode"];
    failureMessage?: string | null;
  },
  kinds: Array<RecordingAssetKind>,
): Promise<void> {
  const createdAt = input.createdAt ?? "2026-05-27T00:00:00.000Z";
  const assets: CloudRecordingAssetRecord[] = kinds.map((kind) => {
    const nameByKind: Record<RecordingAssetKind, string> = {
      manifest: "package/manifest.json",
      meta: "package/meta.json",
      events: "package/events.json",
      snapshots: "package/snapshots.json",
      indexes: "package/indexes.json",
      media: "media/media.webm",
      thumbnail: "thumbnails/poster.webp",
    };
    return {
      id: `asset-${input.id}-${kind}`,
      recordingId: input.id,
      kind,
      objectKey: `recordings/${input.id}/${nameByKind[kind]}`,
      sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      sizeBytes: 123,
      mimeType: kind === "media" ? "video/webm" : kind === "thumbnail" ? "image/webp" : "application/json",
      uploadedAt: createdAt,
      validatedAt: createdAt,
    };
  });

  await metadata.createUpload({
    recording: {
      id: input.id,
      ownerId: input.ownerId,
      localPackageId: `local-${input.id}`,
      title: `Recording ${input.id}`,
      schemaVersion: RECORDING_SCHEMA_VERSION,
      status: input.status,
      visibility: "private",
      createdAt,
      updatedAt: createdAt,
      completedAt: input.status === "ready" ? createdAt : null,
      deletedAt: input.status === "soft_deleted" ? createdAt : null,
      durationMs: 12_345,
      initialLanguage: "javascript",
      hasAudio: input.hasAudio ?? false,
      hasCamera: input.hasCamera ?? false,
      totalSizeBytes: 1024,
      eventCount: 7,
      snapshotCount: 2,
      failureCode: input.failureCode ?? null,
      failureMessage: input.failureMessage ?? null,
    },
    assets,
    session: {
      id: `session-${input.id}`,
      recordingId: input.id,
      ownerId: input.ownerId,
      status: "completed",
      expiresAt: "2026-05-28T00:00:00.000Z",
      idempotencyKey: `idem-${input.id}`,
      createdAt,
      completedAt: createdAt,
    },
  });
}

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
      title: "Cloud API demo",
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

async function makeCreateSessionRequest(pkg: RecordingPackageV1) {
  return {
    idempotencyKey: "idem-http-1",
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

async function makeCreateSessionBody(
  mutate: (request: Awaited<ReturnType<typeof makeCreateSessionRequest>>) => unknown,
) {
  return JSON.stringify(mutate(await makeCreateSessionRequest(await makePackage())));
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
