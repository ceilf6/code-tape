import {
  verifyRecordingPackageIntegrity,
  type PackageLoadError,
  type PackageLoadResult,
  type RecordingEvent,
  type RecordingIndexes,
  type RecordingManifest,
  type RecordingMedia,
  type RecordingMeta,
  type RecordingPackageV1,
  type RecordingSnapshot,
} from "@/shared/recording-schema";
import type {
  CloudApiError,
  CloudPlaybackDescriptor,
  CloudRecordingRepository,
} from "@/features/cloud/types";

export type CloudPackageLoaderOptions = {
  repository: Pick<
    CloudRecordingRepository,
    "getPlaybackDescriptor" | "getSharedPlaybackDescriptor"
  >;
  descriptorSource?: "owner" | "share";
  fetch?: typeof fetch;
};

export type CloudPackageLoader = {
  load(recordingId: string): Promise<PackageLoadResult>;
};

export function createCloudPackageLoader(
  options: CloudPackageLoaderOptions,
): CloudPackageLoader {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);

  return {
    async load(recordingId: string): Promise<PackageLoadResult> {
      if (!fetchImpl) {
        return toInvalidManifest("cloud package fetch is unavailable");
      }

      const descriptor =
        options.descriptorSource === "share"
          ? await options.repository.getSharedPlaybackDescriptor(recordingId)
          : await options.repository.getPlaybackDescriptor(recordingId);
      if (!descriptor.ok) {
        return { ok: false, error: cloudErrorToLoadError(descriptor.error) };
      }

      return loadFromDescriptor(descriptor.value, fetchImpl);
    },
  };
}

async function loadFromDescriptor(
  descriptor: CloudPlaybackDescriptor,
  fetchImpl: typeof fetch,
): Promise<PackageLoadResult> {
  try {
    const [manifest, meta, events, snapshots, indexes] = await Promise.all([
      loadJsonAsset<RecordingManifest>(fetchImpl, "manifest", descriptor.manifestUrl),
      loadJsonAsset<RecordingMeta>(fetchImpl, "meta", descriptor.metaUrl),
      loadJsonAsset<RecordingEvent[]>(fetchImpl, "events", descriptor.eventsUrl),
      loadJsonAsset<RecordingSnapshot[]>(fetchImpl, "snapshots", descriptor.snapshotsUrl),
      descriptor.indexesUrl
        ? loadJsonAsset<RecordingIndexes>(fetchImpl, "indexes", descriptor.indexesUrl)
        : Promise.resolve(undefined),
    ]);
    const mediaBlob = await loadOptionalMedia(fetchImpl, descriptor.mediaUrl);
    const media = buildCloudMedia({ descriptor, manifest, meta, mediaBlob });
    const pkg: RecordingPackageV1 = {
      schemaVersion: descriptor.schemaVersion,
      manifest,
      meta,
      events,
      snapshots,
      media,
      indexes,
    };
    return verifyRecordingPackageIntegrity(pkg, mediaBlob);
  } catch (error) {
    return toInvalidManifest(formatError(error));
  }
}

async function loadJsonAsset<T>(
  fetchImpl: typeof fetch,
  label: string,
  url: string,
): Promise<T> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`${label} download failed: ${response.status} ${response.statusText}`);
  }
  try {
    return JSON.parse(await response.text()) as T;
  } catch (error) {
    throw new Error(`${label} json parse failed: ${formatError(error)}`);
  }
}

async function loadOptionalMedia(
  fetchImpl: typeof fetch,
  url: string | null,
): Promise<Blob | null> {
  if (!url) return null;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    return new Blob([await response.arrayBuffer()], { type: contentType });
  } catch {
    return null;
  }
}

function buildCloudMedia(input: {
  descriptor: CloudPlaybackDescriptor;
  manifest: RecordingManifest;
  meta: RecordingMeta;
  mediaBlob: Blob | null;
}): RecordingMedia | null {
  const shouldDeclareMedia =
    Boolean(input.mediaBlob) ||
    Boolean(input.descriptor.mediaUrl) ||
    Boolean(input.manifest.checksums.mediaSha256);
  if (!shouldDeclareMedia) return null;
  return {
    blobId: "cloud-media",
    mimeType: input.mediaBlob?.type || "video/webm",
    durationMs: input.meta.durationMs,
    sizeBytes: input.mediaBlob?.size ?? 0,
    timelineOffsetMs: 0,
    hasAudio: input.meta.mediaCapability.audio === "available",
    hasCamera: input.meta.mediaCapability.camera === "available",
  };
}

function cloudErrorToLoadError(error: CloudApiError): PackageLoadError {
  const request = error.requestId ? ` requestId=${error.requestId}` : "";
  return {
    code: "invalid-manifest",
    message: `playback descriptor failed: ${error.code}: ${error.message}${request}`,
  };
}

function toInvalidManifest(message: string): PackageLoadResult {
  return { ok: false, error: { code: "invalid-manifest", message } };
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  return "unknown error";
}
