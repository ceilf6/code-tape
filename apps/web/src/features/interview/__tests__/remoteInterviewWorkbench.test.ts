import { describe, expect, it } from "vitest";
import type { RecordingEvent, ReplayStableState } from "@/shared/recording-schema";
import {
  createRemoteInterviewWorkbench,
  type RemoteInterviewWorkbench,
} from "../remoteInterviewWorkbench";

function initialState(): ReplayStableState {
  return {
    editor: {
      code: "",
      language: "typescript",
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
  };
}

function contentEvent(seq: number, code: string): RecordingEvent {
  return {
    id: `event-${seq}`,
    seq,
    timestampMs: seq * 100,
    source: "editor",
    track: "main",
    type: "content-change",
    payload: {
      fileId: "main",
      version: seq,
      code,
      contentHash: `hash-${seq}`,
      language: "typescript",
      changeReason: "input",
      changeCount: 1,
      flushedBy: "debounce",
    },
  };
}

function selectionEvent(seq: number): RecordingEvent {
  return {
    id: `event-${seq}`,
    seq,
    timestampMs: seq * 100,
    source: "editor",
    track: "main",
    type: "selection-change",
    payload: {
      cursor: { lineNumber: 2, column: 5 },
      selection: {
        startLineNumber: 2,
        startColumn: 1,
        endLineNumber: 2,
        endColumn: 5,
      },
    },
  };
}

function runOutputEvent(seq: number): RecordingEvent {
  return {
    id: `event-${seq}`,
    seq,
    timestampMs: seq * 100,
    source: "runtime",
    track: "runtime",
    type: "run-output",
    payload: {
      runId: "run-1",
      stdout: ["42"],
      stderr: [],
      previewHtml: "<strong>42</strong>",
      status: "success",
    },
  };
}

function messageFor(event: RecordingEvent) {
  return {
    kind: "recording-event" as const,
    roomId: "room-1",
    sessionId: "session-1",
    messageId: `message-${event.seq}`,
    sentAt: event.timestampMs,
    stateVersion: 1,
    event,
  };
}

function snapshotMessage(snapshotSeq: number, code: string) {
  return {
    kind: "state-snapshot" as const,
    roomId: "room-1",
    sessionId: "session-1",
    messageId: `snapshot-${snapshotSeq}`,
    sentAt: snapshotSeq * 100,
    snapshotSeq,
    snapshotTimeMs: snapshotSeq * 100,
    stateVersion: snapshotSeq,
    state: {
      ...initialState(),
      editor: {
        ...initialState().editor,
        code,
      },
    },
  };
}

describe("RemoteInterviewWorkbench", () => {
  it("applies out-of-order remote events through the replay reducer in candidate seq order", () => {
    const workbench = createRemoteInterviewWorkbench({ initialState: initialState() });

    workbench.pushRecordingEvent(messageFor(selectionEvent(2)));
    workbench.pushRecordingEvent(messageFor(runOutputEvent(3)));
    const state = workbench.pushRecordingEvent(messageFor(contentEvent(1, "const answer = 42;")));

    expect(state.lastAppliedSeq).toBe(3);
    expect(state.syncStatus).toBe("live");
    expect(state.snapshotRequestNeeded).toBeNull();
    expect(state.stableState.editor.code).toBe("const answer = 42;");
    expect(state.stableState.editor.cursor).toEqual({ lineNumber: 2, column: 5 });
    expect(state.stableState.runtime).toMatchObject({
      status: "success",
      stdout: ["42"],
      previewHtml: "<strong>42</strong>",
    });
  });

  it("does not apply events across a missing seq and exposes waiting-for-snapshot state", () => {
    const workbench = createRemoteInterviewWorkbench({
      initialState: initialState(),
      initialExpectedSeq: 2,
    });

    const state = workbench.pushRecordingEvent(messageFor(contentEvent(3, "skipped gap")));

    expect(state.lastAppliedSeq).toBe(1);
    expect(state.stableState.editor.code).toBe("");
    expect(state.syncStatus).toBe("waiting-for-snapshot");
    expect(state.snapshotRequestNeeded).toEqual({
      reason: "gap-detected",
      expectedSeq: 2,
      lastAppliedSeq: 1,
    });
  });

  it("uses snapshots to recover gaps and replay buffered later events", () => {
    const workbench = createRemoteInterviewWorkbench({
      initialState: initialState(),
      initialExpectedSeq: 2,
    });

    workbench.pushRecordingEvent(messageFor(contentEvent(3, "const afterSnapshot = true;")));
    const state = workbench.pushSnapshot(snapshotMessage(2, "const fromSnapshot = true;"));

    expect(state.stableState.editor.code).toBe("const afterSnapshot = true;");
    expect(state.lastAppliedSeq).toBe(3);
    expect(state.expectedSeq).toBe(4);
    expect(state.syncStatus).toBe("live");
    expect(state.snapshotRequestNeeded).toBeNull();
  });

  it("ignores duplicate and old events without rolling back stable state", () => {
    const workbench = createRemoteInterviewWorkbench({ initialState: initialState() });

    workbench.pushRecordingEvent(messageFor(contentEvent(1, "first")));
    workbench.pushRecordingEvent(messageFor(contentEvent(2, "second")));

    const duplicate = workbench.pushRecordingEvent(messageFor(contentEvent(2, "duplicate")));
    const old = workbench.pushRecordingEvent(messageFor(contentEvent(1, "old")));

    expect(duplicate.stableState.editor.code).toBe("second");
    expect(old.stableState.editor.code).toBe("second");
    expect(old.lastAppliedSeq).toBe(2);
  });

  it("exposes observer operations only and returns cloned snapshots", () => {
    const workbench = createRemoteInterviewWorkbench({ initialState: initialState() });
    const api = workbench as RemoteInterviewWorkbench & Record<string, unknown>;

    expect(api.publishRecordingEvent).toBeUndefined();
    expect(api.subscribeTo).toBeUndefined();

    const snapshot = workbench.getState();
    snapshot.stableState.editor.code = "mutated outside";

    expect(workbench.getState().stableState.editor.code).toBe("");
  });

  it("returns isolated snapshot request objects from gap snapshots", () => {
    const workbench = createRemoteInterviewWorkbench({
      initialState: initialState(),
      initialExpectedSeq: 2,
    });
    workbench.pushRecordingEvent(messageFor(contentEvent(3, "buffered")));

    const snapshot = workbench.getState();
    if (!snapshot.snapshotRequestNeeded) {
      throw new Error("expected a snapshot request");
    }
    snapshot.snapshotRequestNeeded.expectedSeq = 99;

    expect(workbench.getState().snapshotRequestNeeded).toEqual({
      reason: "gap-detected",
      expectedSeq: 2,
      lastAppliedSeq: 1,
    });
  });

  it("notifies subscribers with isolated read-only snapshots", () => {
    const workbench = createRemoteInterviewWorkbench({ initialState: initialState() });
    let secondSubscriberCode = "";

    workbench.subscribe((state) => {
      state.stableState.editor.code = "mutated by first subscriber";
    });
    const unsubscribe = workbench.subscribe((state) => {
      secondSubscriberCode = state.stableState.editor.code;
    });

    workbench.pushRecordingEvent(messageFor(contentEvent(1, "candidate code")));
    unsubscribe();

    expect(secondSubscriberCode).toBe("candidate code");
  });
});
