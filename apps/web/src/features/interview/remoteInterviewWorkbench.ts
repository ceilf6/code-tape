import {
  cloneReplayStableState,
  replayReducer,
  type ReplayStableState,
} from "@/shared/recording-schema";
import {
  createRemoteTimelineBuffer,
  type InterviewRecordingEventMessage,
  type InterviewSnapshotMessage,
  type SnapshotRequestNeed,
} from "./interviewSync";

export type RemoteInterviewSyncStatus = "idle" | "live" | "waiting-for-snapshot";

export type RemoteInterviewWorkbenchState = {
  stableState: ReplayStableState;
  expectedSeq: number;
  lastAppliedSeq: number;
  syncStatus: RemoteInterviewSyncStatus;
  snapshotRequestNeeded: SnapshotRequestNeed | null;
};

export type RemoteInterviewWorkbenchOptions = {
  initialState: ReplayStableState;
  initialExpectedSeq?: number;
};

export type RemoteInterviewWorkbench = {
  getState(): RemoteInterviewWorkbenchState;
  pushRecordingEvent(message: InterviewRecordingEventMessage): RemoteInterviewWorkbenchState;
  pushSnapshot(message: InterviewSnapshotMessage): RemoteInterviewWorkbenchState;
  subscribe(listener: (state: RemoteInterviewWorkbenchState) => void): () => void;
};

export function createRemoteInterviewWorkbench(
  options: RemoteInterviewWorkbenchOptions,
): RemoteInterviewWorkbench {
  let stableState = cloneReplayStableState(options.initialState);
  const buffer = createRemoteTimelineBuffer({ initialExpectedSeq: options.initialExpectedSeq });
  const listeners = new Set<(state: RemoteInterviewWorkbenchState) => void>();
  let hashMismatchNeed: SnapshotRequestNeed | null = null;
  const deferredHashMismatchSeqs = new Set<number>();
  let deferredGapNeed: SnapshotRequestNeed | null = null;

  const snapshot = (): RemoteInterviewWorkbenchState => {
    const bufferState = buffer.state();
    const snapshotRequestNeeded =
      cloneSnapshotRequestNeed(hashMismatchNeed) ??
      cloneSnapshotRequestNeed(bufferState.snapshotRequestNeeded) ??
      cloneSnapshotRequestNeed(deferredGapNeed);
    return {
      stableState: cloneReplayStableState(stableState),
      expectedSeq: bufferState.expectedSeq,
      lastAppliedSeq: bufferState.lastAppliedSeq,
      syncStatus: syncStatusFor(snapshotRequestNeeded, bufferState.lastAppliedSeq),
      snapshotRequestNeeded,
    };
  };

  const notify = (): RemoteInterviewWorkbenchState => {
    const next = snapshot();
    listeners.forEach((listener) => listener(cloneWorkbenchState(next)));
    return next;
  };

  return {
    getState: snapshot,
    pushRecordingEvent(message) {
      const bufferState = buffer.state();
      if (message.event.seq === bufferState.expectedSeq && hasMismatchedContentHash(message)) {
        hashMismatchNeed = {
          reason: "hash-mismatch",
          expectedSeq: message.event.seq,
          lastAppliedSeq: bufferState.lastAppliedSeq,
        };
        return notify();
      }
      if (message.event.seq > bufferState.expectedSeq && hasMismatchedContentHash(message)) {
        deferredHashMismatchSeqs.add(message.event.seq);
        deferredGapNeed = {
          reason: "gap-detected",
          expectedSeq: bufferState.expectedSeq,
          lastAppliedSeq: bufferState.lastAppliedSeq,
        };
        return notify();
      }
      const result = buffer.pushRecordingEvent(message);
      reconcileDeferredHashMismatches();
      if (
        hashMismatchNeed &&
        result.appliedEvents.some((event) => event.seq >= hashMismatchNeed!.expectedSeq)
      ) {
        hashMismatchNeed = null;
      }
      for (const event of result.appliedEvents) {
        deferredHashMismatchSeqs.delete(event.seq);
      }
      stableState = result.appliedEvents.reduce(replayReducer, stableState);
      return notify();
    },
    pushSnapshot(message) {
      const result = buffer.pushSnapshot(message);
      if (result.snapshotAccepted) {
        stableState = cloneReplayStableState(message.state);
        hashMismatchNeed = null;
        deferredGapNeed = null;
        for (const seq of deferredHashMismatchSeqs) {
          if (seq <= message.snapshotSeq) {
            deferredHashMismatchSeqs.delete(seq);
          }
        }
      }
      reconcileDeferredHashMismatches();
      stableState = result.appliedEvents.reduce(replayReducer, stableState);
      return notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  function reconcileDeferredHashMismatches() {
    const state = buffer.state();
    deferredGapNeed =
      deferredGapNeed && deferredGapNeed.expectedSeq === state.expectedSeq
        ? {
            reason: "gap-detected",
            expectedSeq: state.expectedSeq,
            lastAppliedSeq: state.lastAppliedSeq,
          }
        : null;
    if (!hashMismatchNeed && deferredHashMismatchSeqs.has(state.expectedSeq)) {
      hashMismatchNeed = {
        reason: "hash-mismatch",
        expectedSeq: state.expectedSeq,
        lastAppliedSeq: state.lastAppliedSeq,
      };
    }
  }
}

function cloneWorkbenchState(state: RemoteInterviewWorkbenchState): RemoteInterviewWorkbenchState {
  return {
    ...state,
    stableState: cloneReplayStableState(state.stableState),
    snapshotRequestNeeded: cloneSnapshotRequestNeed(state.snapshotRequestNeeded),
  };
}

function cloneSnapshotRequestNeed(need: SnapshotRequestNeed | null): SnapshotRequestNeed | null {
  return need ? { ...need } : null;
}

function syncStatusFor(
  snapshotRequestNeeded: SnapshotRequestNeed | null,
  lastAppliedSeq: number,
): RemoteInterviewSyncStatus {
  if (snapshotRequestNeeded) {
    return "waiting-for-snapshot";
  }
  return lastAppliedSeq > 0 ? "live" : "idle";
}

function hasMismatchedContentHash(message: InterviewRecordingEventMessage): boolean {
  if (message.event.type !== "content-change" || message.contentHash === undefined) {
    return false;
  }
  return hashContent(message.event.payload.code) !== message.contentHash;
}

function hashContent(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}`;
}
