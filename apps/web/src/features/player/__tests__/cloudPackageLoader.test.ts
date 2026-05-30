import { describe, expect, it, vi } from "vitest";
import {
  sha256Blob,
  type PackageLoadError,
  type RecordingIndexes,
  type RecordingPackageV1,
} from "@/shared/recording-schema";
import { canonicalStringify, sha256Hex } from "@/shared/util/hash";
import type { CloudPlaybackDescriptor, CloudRecordingRepository } from "@/features/cloud/types";
import { createCloudPackageLoader } from "../cloudPackageLoader";
import { buildReplayIndex } from "../replayIndex";

type DescriptorRepository = Pick<
  CloudRecordingRepository,
  "getPlaybackDescriptor" | "getSharedPlaybackDescriptor"
>;

describe("createCloudPackageLoader", () => {
  it("loads a ready cloud recording into a PackageLoadResult", async () => {
    const mediaBlob = new Blob(["media"], { type: "video/webm" });
    const parts = await makePackageParts({ mediaBlob, includeIndexes: true });
    const repository = makeRepository({ ok: true, value: makeDescriptor() });
    const loader = createCloudPackageLoader({
      repository,
      fetch: makeAssetFetch({
        "https://assets.example.com/manifest.json": jsonResponse(parts.manifest),
        "https://assets.example.com/meta.json": jsonResponse(parts.meta),
        "https://assets.example.com/events.json": jsonResponse(parts.events),
        "https://assets.example.com/snapshots.json": jsonResponse(parts.snapshots),
        "https://assets.example.com/indexes.json": jsonResponse(parts.indexes),
        "https://assets.example.com/media.webm": await blobResponse(mediaBlob),
      }),
    });

    const result = await loader.load("rec-1");

    expect(repository.getPlaybackDescriptor).toHaveBeenCalledWith("rec-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.package.meta.title).toBe("Cloud Demo");
      expect(result.package.indexes).toEqual(parts.indexes);
      expect(result.mediaBlob).not.toBeNull();
      expect(await readBlobText(result.mediaBlob!)).toBe("media");
      expect(result.warnings).toEqual([]);
    }
  });

  it("uses the shared playback descriptor lookup for share links", async () => {
    const parts = await makePackageParts({ includeIndexes: false });
    const repository = makeRepository({
      ok: true,
      value: makeDescriptor({ indexesUrl: null, mediaUrl: null }),
    });
    const loader = createCloudPackageLoader({
      repository,
      descriptorSource: "share",
      fetch: makeAssetFetch({
        "https://assets.example.com/manifest.json": jsonResponse(parts.manifest),
        "https://assets.example.com/meta.json": jsonResponse(parts.meta),
        "https://assets.example.com/events.json": jsonResponse(parts.events),
        "https://assets.example.com/snapshots.json": jsonResponse(parts.snapshots),
      }),
    });

    const result = await loader.load("share-token");

    expect(repository.getSharedPlaybackDescriptor).toHaveBeenCalledWith("share-token");
    expect(repository.getPlaybackDescriptor).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("returns a load error with cloud request context when descriptor lookup fails", async () => {
    const loader = createCloudPackageLoader({
      repository: makeRepository({
        ok: false,
        error: { code: "not-found", message: "recording not found", requestId: "req-1" },
      }),
      fetch: makeAssetFetch({}),
    });

    const result = await loader.load("missing-rec");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expectInvalidManifestMessage(result.error, "not-found");
      expectInvalidManifestMessage(result.error, "req-1");
    }
  });

  it("fails when a required JSON asset download returns a non-2xx response", async () => {
    const parts = await makePackageParts();
    const loader = createCloudPackageLoader({
      repository: makeRepository({ ok: true, value: makeDescriptor({ indexesUrl: null }) }),
      fetch: makeAssetFetch({
        "https://assets.example.com/manifest.json": new Response("nope", {
          status: 500,
          statusText: "Server Error",
        }),
        "https://assets.example.com/meta.json": jsonResponse(parts.meta),
        "https://assets.example.com/events.json": jsonResponse(parts.events),
        "https://assets.example.com/snapshots.json": jsonResponse(parts.snapshots),
      }),
    });

    const result = await loader.load("rec-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expectInvalidManifestMessage(result.error, "manifest");
      expectInvalidManifestMessage(result.error, "500");
    }
  });

  it("fails when a required JSON asset is malformed", async () => {
    const parts = await makePackageParts();
    const loader = createCloudPackageLoader({
      repository: makeRepository({ ok: true, value: makeDescriptor({ indexesUrl: null }) }),
      fetch: makeAssetFetch({
        "https://assets.example.com/manifest.json": jsonResponse(parts.manifest),
        "https://assets.example.com/meta.json": new Response("{", { status: 200 }),
        "https://assets.example.com/events.json": jsonResponse(parts.events),
        "https://assets.example.com/snapshots.json": jsonResponse(parts.snapshots),
      }),
    });

    const result = await loader.load("rec-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expectInvalidManifestMessage(result.error, "meta");
      expectInvalidManifestMessage(result.error, "json parse failed");
    }
  });

  it("loads successfully when indexesUrl is null", async () => {
    const parts = await makePackageParts({ includeIndexes: false });
    const loader = createCloudPackageLoader({
      repository: makeRepository({ ok: true, value: makeDescriptor({ indexesUrl: null, mediaUrl: null }) }),
      fetch: makeAssetFetch({
        "https://assets.example.com/manifest.json": jsonResponse(parts.manifest),
        "https://assets.example.com/meta.json": jsonResponse(parts.meta),
        "https://assets.example.com/events.json": jsonResponse(parts.events),
        "https://assets.example.com/snapshots.json": jsonResponse(parts.snapshots),
      }),
    });

    const result = await loader.load("rec-1");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.package.indexes).toBeUndefined();
  });

  it("rebuilds a playable replay index from a descriptor that has no indexes asset", async () => {
    const parts = await makePackageParts({ includeIndexes: false });
    const loader = createCloudPackageLoader({
      repository: makeRepository({ ok: true, value: makeDescriptor({ indexesUrl: null, mediaUrl: null }) }),
      fetch: makeAssetFetch({
        "https://assets.example.com/manifest.json": jsonResponse(parts.manifest),
        "https://assets.example.com/meta.json": jsonResponse(parts.meta),
        "https://assets.example.com/events.json": jsonResponse(parts.events),
        "https://assets.example.com/snapshots.json": jsonResponse(parts.snapshots),
      }),
    });

    const result = await loader.load("rec-1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No indexes asset was served, yet the player can rebuild the lookup
    // structures it needs from the package's events/snapshots at runtime.
    expect(result.package.indexes).toBeUndefined();
    const index = buildReplayIndex(result.package);
    expect(index.eventsBySeq).toHaveLength(parts.events.length);
    expect(index.snapshotsByTime).toHaveLength(parts.snapshots.length);
    expect(index.eventsByType.get("content-change")).toHaveLength(1);
  });

  it("keeps JSON playback available with a media-missing warning when mediaUrl is null", async () => {
    const expectedMedia = new Blob(["media"], { type: "video/webm" });
    const parts = await makePackageParts({ mediaBlob: expectedMedia });
    const loader = createCloudPackageLoader({
      repository: makeRepository({ ok: true, value: makeDescriptor({ indexesUrl: null, mediaUrl: null }) }),
      fetch: makeAssetFetch({
        "https://assets.example.com/manifest.json": jsonResponse(parts.manifest),
        "https://assets.example.com/meta.json": jsonResponse(parts.meta),
        "https://assets.example.com/events.json": jsonResponse(parts.events),
        "https://assets.example.com/snapshots.json": jsonResponse(parts.snapshots),
      }),
    });

    const result = await loader.load("rec-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mediaBlob).toBeNull();
      expect(result.warnings).toContainEqual({ code: "media-missing", blobId: "cloud-media" });
    }
  });

  it("keeps JSON playback available when a declared media asset cannot be downloaded", async () => {
    const expectedMedia = new Blob(["media"], { type: "video/webm" });
    const parts = await makePackageParts({ mediaBlob: expectedMedia });
    const loader = createCloudPackageLoader({
      repository: makeRepository({ ok: true, value: makeDescriptor({ indexesUrl: null }) }),
      fetch: makeAssetFetch({
        "https://assets.example.com/manifest.json": jsonResponse(parts.manifest),
        "https://assets.example.com/meta.json": jsonResponse(parts.meta),
        "https://assets.example.com/events.json": jsonResponse(parts.events),
        "https://assets.example.com/snapshots.json": jsonResponse(parts.snapshots),
        "https://assets.example.com/media.webm": new Response("missing media", {
          status: 404,
          statusText: "Not Found",
        }),
      }),
    });

    const result = await loader.load("rec-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mediaBlob).toBeNull();
      expect(result.warnings).toContainEqual({ code: "media-missing", blobId: "cloud-media" });
    }
  });

  it("preserves checksum mismatch failures from the shared package verifier", async () => {
    const parts = await makePackageParts();
    const changedEvent = { ...parts.events[0], timestampMs: 999 };
    const loader = createCloudPackageLoader({
      repository: makeRepository({ ok: true, value: makeDescriptor({ indexesUrl: null, mediaUrl: null }) }),
      fetch: makeAssetFetch({
        "https://assets.example.com/manifest.json": jsonResponse(parts.manifest),
        "https://assets.example.com/meta.json": jsonResponse(parts.meta),
        "https://assets.example.com/events.json": jsonResponse([changedEvent]),
        "https://assets.example.com/snapshots.json": jsonResponse(parts.snapshots),
      }),
    });

    const result = await loader.load("rec-1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toEqual({ code: "checksum-mismatch", target: "events" });
  });
});

async function makePackageParts(input: { mediaBlob?: Blob; includeIndexes?: boolean } = {}) {
  const events: RecordingPackageV1["events"] = [
    {
      id: "e-1",
      seq: 1,
      timestampMs: 100,
      source: "editor",
      track: "main",
      type: "content-change",
      payload: {
        fileId: "main",
        version: 1,
        code: "console.log('cloud')",
        contentHash: "hash-1",
        language: "javascript",
        changeReason: "input",
        changeCount: 1,
        flushedBy: "debounce",
      },
    },
  ];
  const snapshots: RecordingPackageV1["snapshots"] = [
    {
      id: "snap-1",
      timestampMs: 0,
      eventSeq: 1,
      state: {
        editor: {
          code: "console.log('cloud')",
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
          microphoneEnabled: Boolean(input.mediaBlob),
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
  const mediaSha256 = input.mediaBlob ? await sha256Blob(input.mediaBlob) : undefined;
  const manifest: RecordingPackageV1["manifest"] = {
    packageId: "pkg-cloud-1",
    schemaVersion: "0.1.0",
    status: "complete",
    createdAt: "2026-05-29T00:00:00.000Z",
    completedAt: "2026-05-29T00:01:00.000Z",
    checksums: {
      eventsSha256: await sha256Hex(canonicalStringify(events)),
      snapshotsSha256: await sha256Hex(canonicalStringify(snapshots)),
      ...(mediaSha256 ? { mediaSha256 } : {}),
    },
  };
  const meta: RecordingPackageV1["meta"] = {
    id: "rec-1",
    title: "Cloud Demo",
    createdAt: "2026-05-29T00:00:00.000Z",
    durationMs: 1000,
    appVersion: "0.0.0",
    ownerId: null,
    creatorInfo: null,
    initialLanguage: "javascript",
    initialFontSize: 14,
    initialTheme: "dark",
    mediaCapability: {
      audio: input.mediaBlob ? "available" : "not-found",
      camera: "not-found",
      selectedAudioDeviceId: null,
      selectedCameraDeviceId: null,
    },
  };
  const indexes: RecordingIndexes | undefined = input.includeIndexes === false
    ? undefined
    : {
        generatedAt: "2026-05-29T00:01:00.000Z",
        eventsByType: { "content-change": [1] } as RecordingIndexes["eventsByType"],
        snapshotSeqsByTime: [1],
        markers: [],
      };
  return { manifest, meta, events, snapshots, indexes };
}

function makeDescriptor(overrides: Partial<CloudPlaybackDescriptor> = {}): CloudPlaybackDescriptor {
  return {
    id: "rec-1",
    title: "Cloud Demo",
    durationMs: 1000,
    schemaVersion: "0.1.0",
    manifestUrl: "https://assets.example.com/manifest.json",
    metaUrl: "https://assets.example.com/meta.json",
    eventsUrl: "https://assets.example.com/events.json",
    snapshotsUrl: "https://assets.example.com/snapshots.json",
    indexesUrl: "https://assets.example.com/indexes.json",
    mediaUrl: "https://assets.example.com/media.webm",
    thumbnailUrl: null,
    expiresAt: "2026-05-29T00:10:00.000Z",
    ...overrides,
  };
}

function makeRepository(
  result: Awaited<ReturnType<DescriptorRepository["getPlaybackDescriptor"]>>,
): DescriptorRepository {
  return {
    getPlaybackDescriptor: vi.fn().mockResolvedValue(result),
    getSharedPlaybackDescriptor: vi.fn().mockResolvedValue(result),
  };
}

function makeAssetFetch(responses: Record<string, Response>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const response = responses[url];
    if (!response) return new Response("missing test response", { status: 404, statusText: "Not Found" });
    return response;
  }) as typeof fetch;
}

function jsonResponse(value: unknown): Response {
  return new Response(canonicalStringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function expectInvalidManifestMessage(error: PackageLoadError, text: string): void {
  expect(error.code).toBe("invalid-manifest");
  if (error.code !== "invalid-manifest") throw new Error("expected invalid-manifest");
  expect(error.message).toContain(text);
}

async function blobResponse(blob: Blob): Promise<Response> {
  return new Response(await blob.arrayBuffer(), {
    status: 200,
    headers: { "content-type": blob.type },
  });
}

function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("failed to read blob"));
    reader.readAsText(blob);
  });
}
