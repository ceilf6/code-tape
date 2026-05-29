import type { RecordingAssetKind, UploadTarget } from "./types.js";

export type PutObjectInput = {
  key: string;
  body: Uint8Array;
  contentType: string;
};

export type StoredObject = {
  key: string;
  body: Uint8Array;
  contentType: string;
  sizeBytes: number;
};

export type ObjectStorage = {
  createUploadTarget(input: {
    kind: RecordingAssetKind;
    objectKey: string;
    mimeType: string;
    maxSizeBytes: number;
  }): UploadTarget;
  putObject(input: PutObjectInput): Promise<void>;
  getObject(key: string): Promise<StoredObject | null>;
  deleteObject(key: string): Promise<void>;
  getAssetUrl(objectKey: string): string;
};
