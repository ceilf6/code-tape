import { describe, expect, it, vi } from "vitest";
import type { RecordingEvent, ReplayStableState } from "@/shared/recording-schema";
import type { InterviewEventsDataChannel } from "../interviewMediaSession";
import { createInterviewRealtimeReceiver } from "../interviewRealtimeReceiver";
import { createRemoteInterviewWorkbench } from "../remoteInterviewWorkbench";

describe("InterviewRealtimeReceiver", () => {
  it("applies valid recording-event messages to the remote workbench", () => {
    const workbench = createRemoteInterviewWorkbench({ initialState: initialState() });
    const channel = createFakeEventsChannel();

    createInterviewRealtimeReceiver({ roomId: "room-1", workbench }).attach(channel);
    channel.emit(JSON.stringify(messageFor(contentEvent(1, "const live = true;"))));

    const state = workbench.getState();
    expect(state.stableState.editor.code).toBe("const live = true;");
    expect(state.lastAppliedSeq).toBe(1);
    expect(state.expectedSeq).toBe(2);
    expect(state.syncStatus).toBe("live");
  });

  it("keeps candidate seq order while ignoring invalid or cross-room messages", () => {
    const workbench = createRemoteInterviewWorkbench({ initialState: initialState() });
    const channel = createFakeEventsChannel();
    const ignoredReasons: string[] = [];

    createInterviewRealtimeReceiver({
      roomId: "room-1",
      workbench,
      onMessageResult: (result) => {
        if (!result.ok) {
          ignoredReasons.push(result.reason);
        }
      },
    }).attach(channel);

    channel.emit(JSON.stringify(messageFor(contentEvent(2, "const second = true;"))));
    channel.emit("{not-json");
    channel.emit(JSON.stringify({ ...messageFor(contentEvent(1, "wrong room")), roomId: "room-2" }));

    expect(workbench.getState().stableState.editor.code).toBe("");
    expect(workbench.getState().snapshotRequestNeeded).toEqual({
      reason: "gap-detected",
      expectedSeq: 1,
      lastAppliedSeq: 0,
    });

    channel.emit(JSON.stringify(messageFor(contentEvent(1, "const first = true;"))));

    expect(workbench.getState().stableState.editor.code).toBe("const second = true;");
    expect(ignoredReasons).toEqual(["invalid-json", "room-mismatch"]);
  });

  it("detaches the message handler so closed or unmounted views stop applying events", () => {
    const workbench = createRemoteInterviewWorkbench({ initialState: initialState() });
    const channel = createFakeEventsChannel();
    const detach = createInterviewRealtimeReceiver({ roomId: "room-1", workbench }).attach(channel);

    detach();
    channel.emit(JSON.stringify(messageFor(contentEvent(1, "const ignored = true;"))));

    expect(channel.onmessage).toBeNull();
    expect(workbench.getState().stableState.editor.code).toBe("");
  });
});

type TestEventsDataChannel = InterviewEventsDataChannel & {
  onmessage: ((event: { data: unknown }) => void) | null;
  emit(data: unknown): void;
};

function createFakeEventsChannel(): TestEventsDataChannel {
  return {
    label: "events",
    readyState: "open",
    onopen: null,
    onclose: null,
    onmessage: null,
    send: vi.fn(),
    close: vi.fn(),
    emit(data) {
      this.onmessage?.({ data });
    },
  };
}

function messageFor(event: RecordingEvent) {
  return {
    kind: "recording-event" as const,
    roomId: "room-1",
    sessionId: "session-1",
    messageId: `message-${event.seq}`,
    sentAt: 1_000 + event.seq,
    stateVersion: event.seq,
    event,
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
