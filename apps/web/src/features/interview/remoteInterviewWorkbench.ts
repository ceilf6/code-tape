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

  const snapshot = (): RemoteInterviewWorkbenchState => {
    const bufferState = buffer.state();
    return {
      stableState: cloneReplayStableState(stableState),
      expectedSeq: bufferState.expectedSeq,
      lastAppliedSeq: bufferState.lastAppliedSeq,
      syncStatus: syncStatusFor(bufferState.snapshotRequestNeeded, bufferState.lastAppliedSeq),
      snapshotRequestNeeded: cloneSnapshotRequestNeed(bufferState.snapshotRequestNeeded),
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
      const result = buffer.pushRecordingEvent(message);
      stableState = result.appliedEvents.reduce(replayReducer, stableState);
      return notify();
    },
    pushSnapshot(message) {
      const result = buffer.pushSnapshot(message);
      if (result.snapshotAccepted) {
        stableState = cloneReplayStableState(message.state);
      }
      stableState = result.appliedEvents.reduce(replayReducer, stableState);
      return notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
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
