import assert from "node:assert/strict";
import test from "node:test";
import { canonicalStringify, sha256Hex } from "@code-tape/recording-schema/hash";
import {
  RECORDING_SCHEMA_VERSION,
  verifyRecordingPackageIntegrity,
  type PackageLoadResult,
  type RecordingPackageV1,
} from "@code-tape/recording-schema";
import { createCloudRecordingService } from "../../cloud/cloudRecordingService.js";
import { createMemoryMetadataRepository } from "../../cloud/memoryMetadataRepository.js";
import { createLocalDevObjectStorage } from "../../cloud/localDevObjectStorage.js";
import { processNextRecordingValidationJob } from "../../cloud/validationWorker.js";
import { createApiHandler } from "../createApiHandler.js";
import { createCloudApiHandler } from "../cloudApiHandler.js";
import { createLocalDevObjectStorageHandler } from "../localDevObjectStorageHandler.js";

const PUBLIC_BASE_URL = "http://localhost";

test("create upload session returns fetchable HTTP upload targets", async () => {
  const objectStorage = createLocalDevObjectStorage({ publicBaseUrl: PUBLIC_BASE_URL });
  const handler = createApiHandler({
    cloud: createCloudApiHandler({
      service: createCloudRecordingService({
        metadata: createMemoryMetadataRepository(),
        objectStorage,
      }),
      createRequestId: () => "req-object-http-1",
    }),
    objectStorage: createLocalDevObjectStorageHandler(objectStorage),
  });

  const createResponse = await handler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: JSON.stringify(await makeCreateSessionRequest(await makePackage())),
    }),
  );
  const body = (await createResponse.json()) as {
    recordingId: string;
    uploadTargets: Array<{ kind: string; url: string; headers: Record<string, string> }>;
  };

  assert.equal(createResponse.status, 201);
  const manifestTarget = body.uploadTargets.find((target) => target.kind === "manifest");
  assert.ok(manifestTarget);
  assert.match(manifestTarget.url, /^http:\/\/localhost\/dev\/object-storage\/uploads\//u);

  const manifestBytes = new TextEncoder().encode(
    canonicalStringify((await makePackage()).manifest),
  );
  const putResponse = await handler(
    new Request(manifestTarget.url, {
      method: "PUT",
      headers: manifestTarget.headers,
      body: manifestBytes,
    }),
  );
  assert.equal(putResponse.status, 204);

  const objectKey = `recordings/${body.recordingId}/package/manifest.json`;
  const stored = await objectStorage.getObject(objectKey);
  assert.ok(stored);
  assert.equal(stored.sizeBytes, manifestBytes.byteLength);
  assert.equal(stored.contentType, "application/json");
});

test("cloud playback center acceptance flow stays ready through upload, playback, rename, share, and delete", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createLocalDevObjectStorage({ publicBaseUrl: PUBLIC_BASE_URL });
  const service = createCloudRecordingService({ metadata, objectStorage });
  const handler = createApiHandler({
    cloud: createCloudApiHandler({
      service,
      createRequestId: () => "req-cloud-acceptance",
    }),
    objectStorage: createLocalDevObjectStorageHandler(objectStorage),
  });
  const pkg = await makePackage({
    packageId: "pkg-cloud-acceptance",
    title: "Two Sum Cloud Demo",
    durationMs: 60_000,
    code: "function twoSum(nums, target) { return [0, 1]; }",
  });
  const createSessionRequest = await makeCreateSessionRequest(pkg, "idem-cloud-acceptance");

  const createResponse = await handler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-main",
      },
      body: JSON.stringify(createSessionRequest),
    }),
  );
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()) as {
    sessionId: string;
    recordingId: string;
    uploadTargets: Array<{ kind: string; url: string; headers: Record<string, string> }>;
  };

  for (const target of created.uploadTargets) {
    const body = assetBody(pkg, target.kind);
    const putResponse = await handler(
      new Request(target.url, {
        method: "PUT",
        headers: target.headers,
        body,
      }),
    );
    assert.equal(putResponse.status, 204, `${target.kind} upload should succeed`);
  }

  const completeResponse = await handler(
    new Request(`http://localhost/api/recordings/upload-sessions/${created.sessionId}/complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-main",
      },
      body: JSON.stringify({
        uploadedAssets: createSessionRequest.assets.map(({ kind, sha256, sizeBytes }) => ({
          kind,
          sha256,
          sizeBytes,
        })),
      }),
    }),
  );
  assert.equal(completeResponse.status, 200);
  assert.deepEqual(await completeResponse.json(), {
    recordingId: created.recordingId,
    status: "processing",
  });

  const validation = await processNextRecordingValidationJob({
    metadata,
    objectStorage,
    now: () => new Date("2026-05-29T00:02:00.000Z"),
  });
  assert.equal(validation.ok, true);
  if (!validation.ok || "reason" in validation) throw new Error("recording should validate");
  assert.equal(validation.recording.status, "ready");
  assert.equal(validation.recording.eventCount, 1);
  assert.equal(validation.recording.snapshotCount, 1);

  const listResponse = await handler(
    new Request("http://localhost/api/recordings", {
      method: "GET",
      headers: { "x-owner-token": "owner-main" },
    }),
  );
  assert.equal(listResponse.status, 200);
  const list = (await listResponse.json()) as { items: Array<{ id: string; title: string }> };
  assert.deepEqual(list.items.map((item) => item.id), [created.recordingId]);
  assert.equal(list.items[0]?.title, "Two Sum Cloud Demo");

  const otherOwnerListResponse = await handler(
    new Request("http://localhost/api/recordings", {
      method: "GET",
      headers: { "x-owner-token": "owner-other" },
    }),
  );
  assert.equal(otherOwnerListResponse.status, 200);
  assert.deepEqual(await otherOwnerListResponse.json(), { items: [], nextCursor: null });

  // Owner isolation must hold for direct-ID access too, not just the list, so a
  // foreign owner who learns the recordingId still cannot read or mutate it
  // (guards against IDOR — issue #174).
  const detailAsOther = await handler(
    new Request(`http://localhost/api/recordings/${created.recordingId}`, {
      method: "GET",
      headers: { "x-owner-token": "owner-other" },
    }),
  );
  assert.equal(detailAsOther.status, 404, "foreign owner detail must be 404");

  const playbackAsOther = await handler(
    new Request(`http://localhost/api/recordings/${created.recordingId}/playback`, {
      method: "GET",
      headers: { "x-owner-token": "owner-other" },
    }),
  );
  assert.equal(playbackAsOther.status, 404, "foreign owner playback must be 404");

  const renameAsOther = await handler(
    new Request(`http://localhost/api/recordings/${created.recordingId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-other",
      },
      body: JSON.stringify({ title: "Hijacked Title" }),
    }),
  );
  assert.equal(renameAsOther.status, 404, "foreign owner rename must be 404");

  const shareAsOther = await handler(
    new Request(`http://localhost/api/recordings/${created.recordingId}/share-links`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-other",
      },
      body: JSON.stringify({ startTimeMs: 1000 }),
    }),
  );
  assert.equal(shareAsOther.status, 404, "foreign owner share-link must be 404");

  const deleteAsOther = await handler(
    new Request(`http://localhost/api/recordings/${created.recordingId}`, {
      method: "DELETE",
      headers: { "x-owner-token": "owner-other" },
    }),
  );
  assert.equal(deleteAsOther.status, 404, "foreign owner delete must be 404");

  // The owner's record must survive every foreign mutation attempt above.
  const ownerDetailAfterForeignAttempts = await handler(
    new Request(`http://localhost/api/recordings/${created.recordingId}`, {
      method: "GET",
      headers: { "x-owner-token": "owner-main" },
    }),
  );
  assert.equal(ownerDetailAfterForeignAttempts.status, 200);
  const ownerDetail = (await ownerDetailAfterForeignAttempts.json()) as {
    recording: { title: string; status: string };
  };
  assert.equal(ownerDetail.recording.title, "Two Sum Cloud Demo");
  assert.equal(ownerDetail.recording.status, "ready");

  const playbackResponse = await handler(
    new Request(`http://localhost/api/recordings/${created.recordingId}/playback`, {
      method: "GET",
      headers: { "x-owner-token": "owner-main" },
    }),
  );
  assert.equal(playbackResponse.status, 200);
  const playback = (await playbackResponse.json()) as {
    title: string;
    schemaVersion: string;
    indexesUrl: string | null;
    manifestUrl: string;
    metaUrl: string;
    eventsUrl: string;
    snapshotsUrl: string;
  };
  assert.equal(playback.title, "Two Sum Cloud Demo");
  assert.equal(playback.indexesUrl, null);
  assert.deepEqual(await readJsonAsset(handler, playback.eventsUrl), pkg.events);
  assert.deepEqual(await readJsonAsset(handler, playback.snapshotsUrl), pkg.snapshots);
  assert.deepEqual(await readJsonAsset(handler, playback.manifestUrl), pkg.manifest);
  assert.deepEqual(await readJsonAsset(handler, playback.metaUrl), pkg.meta);

  // Assemble the real API descriptor output into a package and verify it, the
  // same way CloudPackageLoader.loadFromDescriptor consumes it. This proves the
  // API's descriptor is consumable end-to-end; the authoritative loader behavior
  // (incl. the indexesUrl:null rebuild path) is locked by the real loader test
  // in apps/web (cloudPackageLoader.test.ts). The descriptor exposes no indexes
  // asset, so this also confirms playback loads when `indexes` is absent.
  const loaded = await loadPackageFromDescriptor(handler, playback);
  assert.equal(loaded.ok, true, "cloud playback descriptor should load into a playable package");
  if (!loaded.ok) throw new Error("expected descriptor to load");
  assert.equal(loaded.package.indexes, undefined);
  assert.equal(loaded.package.meta.title, "Two Sum Cloud Demo");
  assert.equal(loaded.package.events.length, pkg.events.length);
  assert.equal(loaded.package.snapshots.length, pkg.snapshots.length);
  assert.deepEqual(loaded.warnings, []);

  const renameResponse = await handler(
    new Request(`http://localhost/api/recordings/${created.recordingId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-main",
      },
      body: JSON.stringify({ title: "Two Sum Cloud Demo Renamed" }),
    }),
  );
  assert.equal(renameResponse.status, 200);
  assert.equal(((await renameResponse.json()) as { title: string }).title, "Two Sum Cloud Demo Renamed");

  const renamedPlaybackResponse = await handler(
    new Request(`http://localhost/api/recordings/${created.recordingId}/playback`, {
      method: "GET",
      headers: { "x-owner-token": "owner-main" },
    }),
  );
  assert.equal(renamedPlaybackResponse.status, 200);
  assert.equal(
    ((await renamedPlaybackResponse.json()) as { title: string }).title,
    "Two Sum Cloud Demo Renamed",
  );

  // Rename must stay consistent across list, detail, and playback (issue #174).
  const renamedListResponse = await handler(
    new Request("http://localhost/api/recordings", {
      method: "GET",
      headers: { "x-owner-token": "owner-main" },
    }),
  );
  assert.equal(renamedListResponse.status, 200);
  const renamedList = (await renamedListResponse.json()) as {
    items: Array<{ id: string; title: string }>;
  };
  assert.equal(renamedList.items[0]?.title, "Two Sum Cloud Demo Renamed");

  const detailResponse = await handler(
    new Request(`http://localhost/api/recordings/${created.recordingId}`, {
      method: "GET",
      headers: { "x-owner-token": "owner-main" },
    }),
  );
  assert.equal(detailResponse.status, 200);
  assert.equal(
    ((await detailResponse.json()) as { recording: { title: string } }).recording.title,
    "Two Sum Cloud Demo Renamed",
  );

  const shareResponse = await handler(
    new Request(`http://localhost/api/recordings/${created.recordingId}/share-links`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-main",
      },
      body: JSON.stringify({ startTimeMs: 42_000 }),
    }),
  );
  assert.equal(shareResponse.status, 201);
  const share = (await shareResponse.json()) as { url: string; expiresAt: string | null };
  assert.match(share.url, /^\/s\/[^?]+\?t=42000$/u);
  assert.equal(share.expiresAt, null);
  const shareToken = new URL(`http://localhost${share.url}`).pathname.split("/s/")[1]!;

  const sharedPlaybackResponse = await handler(
    new Request(`http://localhost/api/share/${shareToken}/playback`, { method: "GET" }),
  );
  assert.equal(sharedPlaybackResponse.status, 200);
  assert.equal(
    ((await sharedPlaybackResponse.json()) as { title: string }).title,
    "Two Sum Cloud Demo Renamed",
  );

  const deleteResponse = await handler(
    new Request(`http://localhost/api/recordings/${created.recordingId}`, {
      method: "DELETE",
      headers: { "x-owner-token": "owner-main" },
    }),
  );
  assert.equal(deleteResponse.status, 200);
  assert.equal(((await deleteResponse.json()) as { status: string }).status, "soft_deleted");

  const listAfterDeleteResponse = await handler(
    new Request("http://localhost/api/recordings", {
      method: "GET",
      headers: { "x-owner-token": "owner-main" },
    }),
  );
  assert.equal(listAfterDeleteResponse.status, 200);
  assert.deepEqual(await listAfterDeleteResponse.json(), { items: [], nextCursor: null });

  const playbackAfterDeleteResponse = await handler(
    new Request(`http://localhost/api/recordings/${created.recordingId}/playback`, {
      method: "GET",
      headers: { "x-owner-token": "owner-main" },
    }),
  );
  assert.equal(playbackAfterDeleteResponse.status, 404);

  const sharedAfterDeleteResponse = await handler(
    new Request(`http://localhost/api/share/${shareToken}/playback`, { method: "GET" }),
  );
  assert.equal(sharedAfterDeleteResponse.status, 404);
});

async function makePackage(
  input: {
    packageId?: string;
    title?: string;
    durationMs?: number;
    code?: string;
  } = {},
): Promise<RecordingPackageV1> {
  const code = input.code ?? "console.log('cloud')";
  const durationMs = input.durationMs ?? 1000;
  const events: RecordingPackageV1["events"] = [
    {
      id: "event-1",
      seq: 1,
      timestampMs: 100,
      source: "editor",
      track: "main",
      type: "content-change",
      payload: {
        fileId: "main",
        version: 1,
        code,
        contentHash: "content-hash-1",
        language: "javascript",
        changeReason: "input",
        changeCount: 1,
        flushedBy: "debounce",
      },
    },
  ];
  const snapshots: RecordingPackageV1["snapshots"] = [
    {
      id: "snapshot-1",
      timestampMs: 0,
      eventSeq: 1,
      state: {
        editor: {
          code,
          language: "javascript",
          cursor: null,
          selection: null,
          scrollTop: 0,
          scrollLeft: 0,
          fontSize: 14,
          theme: "dark",
        },
        pointer: null,
        media: {
          microphoneEnabled: false,
          cameraEnabled: false,
          cameraPosition: { x: 0, y: 0 },
        },
        runtime: {
          status: "idle",
          stdout: [],
          stderr: [],
          previewHtml: null,
          errorMessage: null,
        },
      },
    },
  ];
  return {
    schemaVersion: RECORDING_SCHEMA_VERSION,
    manifest: {
      packageId: input.packageId ?? "pkg-1",
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
      title: input.title ?? "Cloud infra demo",
      createdAt: "2026-05-27T00:00:00.000Z",
      durationMs,
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

async function makeCreateSessionRequest(pkg: RecordingPackageV1, idempotencyKey = "idem-object-http-1") {
  return {
    idempotencyKey,
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

function assetBody(pkg: RecordingPackageV1, kind: string): string {
  switch (kind) {
    case "manifest":
      return canonicalStringify(pkg.manifest);
    case "meta":
      return canonicalStringify(pkg.meta);
    case "events":
      return canonicalStringify(pkg.events);
    case "snapshots":
      return canonicalStringify(pkg.snapshots);
    default:
      throw new Error(`unexpected upload target: ${kind}`);
  }
}

async function readJsonAsset(handler: (request: Request) => Promise<Response>, url: string): Promise<unknown> {
  const response = await handler(new Request(url, { method: "GET" }));
  assert.equal(response.status, 200);
  return response.json();
}

// Mirrors CloudPackageLoader.loadFromDescriptor (apps/web): assemble the package
// from the descriptor's asset URLs and verify integrity. `indexes` stays absent
// when the descriptor exposes no indexesUrl, matching the loader's runtime path.
async function loadPackageFromDescriptor(
  handler: (request: Request) => Promise<Response>,
  descriptor: {
    schemaVersion: string;
    manifestUrl: string;
    metaUrl: string;
    eventsUrl: string;
    snapshotsUrl: string;
    indexesUrl: string | null;
  },
): Promise<PackageLoadResult> {
  const [manifest, meta, events, snapshots, indexes] = await Promise.all([
    readJsonAsset(handler, descriptor.manifestUrl),
    readJsonAsset(handler, descriptor.metaUrl),
    readJsonAsset(handler, descriptor.eventsUrl),
    readJsonAsset(handler, descriptor.snapshotsUrl),
    descriptor.indexesUrl
      ? readJsonAsset(handler, descriptor.indexesUrl)
      : Promise.resolve(undefined),
  ]);
  const pkg = {
    schemaVersion: descriptor.schemaVersion,
    manifest,
    meta,
    events,
    snapshots,
    media: null,
    indexes,
  };
  return verifyRecordingPackageIntegrity(pkg, null);
}
