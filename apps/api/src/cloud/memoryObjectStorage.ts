import type { ObjectStorage, PutObjectInput, StoredObject } from "./objectStorage.js";
import type { RecordingAssetKind, UploadTarget } from "./types.js";

export type MemoryObjectStorage = ObjectStorage & {
  putBySignedUrl(
    url: string,
    body: Uint8Array,
    options: { contentType: string },
  ): Promise<void>;
};

export function createMemoryObjectStorage(): MemoryObjectStorage {
  const objects = new Map<string, StoredObject>();
  const signedUrlToKey = new Map<string, string>();

  const storage: MemoryObjectStorage = {
    createUploadTarget(input: {
      kind: RecordingAssetKind;
      objectKey: string;
      mimeType: string;
      maxSizeBytes: number;
    }): UploadTarget {
      const url = `memory:${encodeURIComponent(input.objectKey)}`;
      signedUrlToKey.set(url, input.objectKey);
      return {
        kind: input.kind,
        method: "PUT",
        url,
        headers: { "content-type": input.mimeType },
        maxSizeBytes: input.maxSizeBytes,
      };
    },
    async putObject(input: PutObjectInput): Promise<void> {
      objects.set(input.key, {
        key: input.key,
        body: input.body,
        contentType: input.contentType,
        sizeBytes: input.body.byteLength,
      });
    },
    async putBySignedUrl(
      url: string,
      body: Uint8Array,
      options: { contentType: string },
    ): Promise<void> {
      const key = signedUrlToKey.get(url);
      if (!key) throw new Error(`unknown signed upload url: ${url}`);
      await storage.putObject({ key, body, contentType: options.contentType });
    },
    async getObject(key: string): Promise<StoredObject | null> {
      return objects.get(key) ?? null;
    },
    async deleteObject(key: string): Promise<void> {
      objects.delete(key);
    },
    getAssetUrl(key: string): string {
      return `memory:${encodeURIComponent(key)}`;
    },
  };

  return storage;
}
