import type { ObjectStorage, PutObjectInput, StoredObject } from "./objectStorage.js";
import type { RecordingAssetKind, UploadTarget } from "./types.js";

export type LocalDevObjectStorageOptions = {
  publicBaseUrl: string;
  createUploadToken?: () => string;
};

export type PendingUploadTarget = {
  objectKey: string;
  mimeType: string;
  maxSizeBytes: number;
  kind: RecordingAssetKind;
};

export type ClaimPendingUploadResult =
  | { status: "claimed"; target: PendingUploadTarget }
  | { status: "consumed" }
  | { status: "not-found" };

export type LocalDevObjectStorage = ObjectStorage & {
  claimPendingUploadTarget(token: string): ClaimPendingUploadResult;
  finalizeConsumedUploadToken(token: string): void;
};

const UPLOAD_PATH_PREFIX = "/dev/object-storage/uploads/";
const OBJECT_PATH_PREFIX = "/dev/object-storage/objects/";

export function buildLocalDevUploadUrl(publicBaseUrl: string, uploadToken: string): string {
  const base = publicBaseUrl.replace(/\/+$/u, "");
  return `${base}${UPLOAD_PATH_PREFIX}${encodeURIComponent(uploadToken)}`;
}

export function buildLocalDevObjectUrl(publicBaseUrl: string, objectKey: string): string {
  const base = publicBaseUrl.replace(/\/+$/u, "");
  return `${base}${OBJECT_PATH_PREFIX}${encodeObjectKey(objectKey)}`;
}

export function encodeObjectKey(objectKey: string): string {
  return Buffer.from(objectKey, "utf8").toString("base64url");
}

export function decodeObjectKey(encoded: string): string | null {
  if (!isCanonicalBase64Url(encoded)) {
    return null;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }

  if (encodeObjectKey(decoded) !== encoded) {
    return null;
  }

  return decoded;
}

function isCanonicalBase64Url(encoded: string): boolean {
  return encoded.length > 0 && /^[A-Za-z0-9_-]+$/u.test(encoded);
}

export function createLocalDevObjectStorage(
  options: LocalDevObjectStorageOptions,
): LocalDevObjectStorage {
  const objects = new Map<string, StoredObject>();
  const pendingUploads = new Map<string, PendingUploadTarget>();
  const inFlightUploadTokens = new Set<string>();
  const consumedUploadTokens = new Set<string>();
  const createUploadToken = options.createUploadToken ?? (() => crypto.randomUUID());
  const publicBaseUrl = options.publicBaseUrl;

  const storage: LocalDevObjectStorage = {
    createUploadTarget(input: {
      kind: RecordingAssetKind;
      objectKey: string;
      mimeType: string;
      maxSizeBytes: number;
    }): UploadTarget {
      const uploadToken = createUploadToken();
      pendingUploads.set(uploadToken, {
        objectKey: input.objectKey,
        mimeType: input.mimeType,
        maxSizeBytes: input.maxSizeBytes,
        kind: input.kind,
      });
      return {
        kind: input.kind,
        method: "PUT",
        url: buildLocalDevUploadUrl(publicBaseUrl, uploadToken),
        headers: { "content-type": input.mimeType },
        maxSizeBytes: input.maxSizeBytes,
      };
    },
    claimPendingUploadTarget(token: string): ClaimPendingUploadResult {
      const target = pendingUploads.get(token);
      if (target) {
        pendingUploads.delete(token);
        inFlightUploadTokens.add(token);
        return { status: "claimed", target };
      }
      if (inFlightUploadTokens.has(token) || consumedUploadTokens.has(token)) {
        return { status: "consumed" };
      }
      return { status: "not-found" };
    },
    finalizeConsumedUploadToken(token: string): void {
      inFlightUploadTokens.delete(token);
      consumedUploadTokens.add(token);
    },
    async putObject(input: PutObjectInput): Promise<void> {
      objects.set(input.key, {
        key: input.key,
        body: input.body,
        contentType: input.contentType,
        sizeBytes: input.body.byteLength,
      });
    },
    async getObject(key: string): Promise<StoredObject | null> {
      return objects.get(key) ?? null;
    },
    async deleteObject(key: string): Promise<void> {
      objects.delete(key);
    },
    getAssetUrl(key: string): string {
      return buildLocalDevObjectUrl(publicBaseUrl, key);
    },
  };

  return storage;
}

export const LOCAL_DEV_OBJECT_STORAGE_UPLOAD_PATH_PREFIX = UPLOAD_PATH_PREFIX;
export const LOCAL_DEV_OBJECT_STORAGE_OBJECT_PATH_PREFIX = OBJECT_PATH_PREFIX;
