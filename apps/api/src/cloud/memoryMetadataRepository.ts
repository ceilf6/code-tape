import type {
  CreateShareLinkWriteResult,
  CreateUploadWriteResult,
  MetadataRepository,
} from "./metadataRepository.js";
import type {
  CloudRecordingAssetRecord,
  CloudRecordingRecord,
  CloudRecordingShareLinkRecord,
  UploadSessionRecord,
} from "./types.js";

export function createMemoryMetadataRepository(): MetadataRepository {
  const recordings = new Map<string, CloudRecordingRecord>();
  const sessions = new Map<string, UploadSessionRecord>();
  const assetsByRecording = new Map<string, CloudRecordingAssetRecord[]>();
  const sessionIdByIdempotencyKey = new Map<string, string>();
  const shareLinks = new Map<string, CloudRecordingShareLinkRecord>();
  const shareLinkIdByTokenHash = new Map<string, string>();

  return {
    async findSessionByOwnerAndIdempotencyKey(
      ownerId: string,
      idempotencyKey: string,
    ): Promise<UploadSessionRecord | null> {
      for (const session of sessions.values()) {
        if (session.ownerId === ownerId && session.idempotencyKey === idempotencyKey) {
          return { ...session };
        }
      }
      return null;
    },
    async getSession(sessionId: string): Promise<UploadSessionRecord | null> {
      const session = sessions.get(sessionId);
      return session ? { ...session } : null;
    },
    async getRecording(recordingId: string): Promise<CloudRecordingRecord | null> {
      const recording = recordings.get(recordingId);
      return recording ? { ...recording } : null;
    },
    async listRecordingsByOwner(input: {
      ownerId: string;
      statuses?: CloudRecordingRecord["status"][];
    }): Promise<CloudRecordingRecord[]> {
      const allowedStatuses = input.statuses ? new Set(input.statuses) : null;
      return Array.from(recordings.values())
        .filter((recording) => recording.ownerId === input.ownerId)
        .filter((recording) => !allowedStatuses || allowedStatuses.has(recording.status))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .map((recording) => ({ ...recording }));
    },
    async listAssets(recordingId: string): Promise<CloudRecordingAssetRecord[]> {
      return (assetsByRecording.get(recordingId) ?? []).map((asset) => ({ ...asset }));
    },
    async createUpload(input: {
      recording: CloudRecordingRecord;
      assets: CloudRecordingAssetRecord[];
      session: UploadSessionRecord;
    }): Promise<CreateUploadWriteResult> {
      const idempotencyKey = sessionKey(input.session.ownerId, input.session.idempotencyKey);
      const existingSessionId = sessionIdByIdempotencyKey.get(idempotencyKey);
      if (existingSessionId) {
        const existingSession = sessions.get(existingSessionId);
        if (existingSession) {
          return {
            status: "idempotency-key-exists",
            existingSession: { ...existingSession },
          };
        }
      }
      recordings.set(input.recording.id, { ...input.recording });
      sessions.set(input.session.id, { ...input.session });
      sessionIdByIdempotencyKey.set(idempotencyKey, input.session.id);
      assetsByRecording.set(
        input.recording.id,
        input.assets.map((asset) => ({ ...asset })),
      );
      return { status: "created" };
    },
    async createShareLink(
      shareLink: CloudRecordingShareLinkRecord,
    ): Promise<CreateShareLinkWriteResult> {
      const existingShareLinkId = shareLinkIdByTokenHash.get(shareLink.tokenHash);
      if (existingShareLinkId && shareLinks.has(existingShareLinkId)) {
        return { status: "token-hash-exists" };
      }
      shareLinks.set(shareLink.id, { ...shareLink });
      shareLinkIdByTokenHash.set(shareLink.tokenHash, shareLink.id);
      return { status: "created" };
    },
    async findShareLinkByTokenHash(
      tokenHash: string,
    ): Promise<CloudRecordingShareLinkRecord | null> {
      const shareLinkId = shareLinkIdByTokenHash.get(tokenHash);
      if (!shareLinkId) return null;
      const shareLink = shareLinks.get(shareLinkId);
      return shareLink ? { ...shareLink } : null;
    },
    async revokeShareLinksByRecordingId(input: {
      recordingId: string;
      revokedAt: string;
    }): Promise<void> {
      for (const shareLink of shareLinks.values()) {
        if (shareLink.recordingId === input.recordingId && shareLink.revokedAt === null) {
          shareLinks.set(shareLink.id, { ...shareLink, revokedAt: input.revokedAt });
        }
      }
    },
    async markUploadCompleted(input: {
      sessionId: string;
      completedAt: string;
      uploadedAssetKinds: string[];
    }): Promise<void> {
      const session = sessions.get(input.sessionId);
      if (!session) return;
      const recording = recordings.get(session.recordingId);
      if (recording?.status !== "uploading") return;
      sessions.set(input.sessionId, {
        ...session,
        status: "completed",
        completedAt: input.completedAt,
      });
      recordings.set(recording.id, {
        ...recording,
        status: "processing",
        updatedAt: input.completedAt,
      });
      const assets = assetsByRecording.get(session.recordingId) ?? [];
      assetsByRecording.set(
        session.recordingId,
        assets.map((asset) =>
          input.uploadedAssetKinds.includes(asset.kind)
            ? { ...asset, uploadedAt: input.completedAt }
            : asset,
        ),
      );
    },
    async findNextProcessingRecording(): Promise<CloudRecordingRecord | null> {
      for (const recording of recordings.values()) {
        if (recording.status === "processing") return { ...recording };
      }
      return null;
    },
    async updateRecording(recording: CloudRecordingRecord): Promise<void> {
      recordings.set(recording.id, { ...recording });
    },
    async updateRecordingIfStatus(input) {
      const current = recordings.get(input.recordingId);
      if (!current || current.status !== input.expectedStatus) {
        return {
          status: "status-mismatch" as const,
          current: current ? { ...current } : null,
        };
      }
      const updated = { ...current, ...input.patch, id: current.id };
      recordings.set(current.id, updated);
      return {
        status: "updated" as const,
        recording: { ...updated },
      };
    },
    async updateAsset(asset: CloudRecordingAssetRecord): Promise<void> {
      const assets = assetsByRecording.get(asset.recordingId) ?? [];
      assetsByRecording.set(
        asset.recordingId,
        assets.map((existing) => (existing.id === asset.id ? { ...asset } : existing)),
      );
    },
  };
}

function sessionKey(ownerId: string, idempotencyKey: string): string {
  return `${ownerId}\0${idempotencyKey}`;
}
