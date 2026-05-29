import type {
  CloudRecordingAssetRecord,
  CloudRecordingRecord,
  CloudRecordingShareLinkRecord,
  UploadSessionRecord,
} from "./types.js";

export type CreateUploadWriteResult =
  | { status: "created" }
  | { status: "idempotency-key-exists"; existingSession: UploadSessionRecord };

export type CreateShareLinkWriteResult =
  | { status: "created" }
  | { status: "token-hash-exists" };

export type UpdateRecordingIfStatusResult =
  | { status: "updated"; recording: CloudRecordingRecord }
  | { status: "status-mismatch"; current: CloudRecordingRecord | null };

export type UpdateRecordingIfStatusInput = {
  recordingId: string;
  expectedStatus: CloudRecordingRecord["status"];
  patch: Partial<Omit<CloudRecordingRecord, "id">>;
};

export type MetadataRepository = {
  findSessionByOwnerAndIdempotencyKey(
    ownerId: string,
    idempotencyKey: string,
  ): Promise<UploadSessionRecord | null>;
  getSession(sessionId: string): Promise<UploadSessionRecord | null>;
  getRecording(recordingId: string): Promise<CloudRecordingRecord | null>;
  listRecordingsByOwner(input: {
    ownerId: string;
    statuses?: CloudRecordingRecord["status"][];
  }): Promise<CloudRecordingRecord[]>;
  listAssets(recordingId: string): Promise<CloudRecordingAssetRecord[]>;
  // Atomically writes recording/assets/session with a unique owner + idempotencyKey boundary.
  createUpload(input: {
    recording: CloudRecordingRecord;
    assets: CloudRecordingAssetRecord[];
    session: UploadSessionRecord;
  }): Promise<CreateUploadWriteResult>;
  createShareLink(
    shareLink: CloudRecordingShareLinkRecord,
  ): Promise<CreateShareLinkWriteResult>;
  findShareLinkByTokenHash(tokenHash: string): Promise<CloudRecordingShareLinkRecord | null>;
  revokeShareLinksByRecordingId(input: {
    recordingId: string;
    revokedAt: string;
  }): Promise<void>;
  markUploadCompleted(input: {
    sessionId: string;
    completedAt: string;
    uploadedAssetKinds: string[];
  }): Promise<void>;
  findNextProcessingRecording(): Promise<CloudRecordingRecord | null>;
  updateRecording(recording: CloudRecordingRecord): Promise<void>;
  updateRecordingIfStatus(
    input: UpdateRecordingIfStatusInput,
  ): Promise<UpdateRecordingIfStatusResult>;
  updateAsset(asset: CloudRecordingAssetRecord): Promise<void>;
};
