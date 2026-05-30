import { describe, expect, it } from "vitest";
import {
  cloneReplayStableState,
  replayReducer,
  type EventBus,
  type RecordingEvent,
  type ReplayStableState,
} from "@/shared/recording-schema";
import {
  createInterviewSyncPublisher,
  createRemoteTimelineBuffer,
  type InterviewRealtimeDataChannel,
} from "../interviewSync";
import { INITIAL_REMOTE_INTERVIEW_STABLE_STATE } from "../remoteInterviewInitialState";

function initialStableState(): ReplayStableState {
  return cloneReplayStableState(INITIAL_REMOTE_INTERVIEW_STABLE_STATE);
}

function contentEvent(seq: number, code = `code-${seq}`): RecordingEvent {
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

function recordStartEvent(seq: number): RecordingEvent {
  return {
    id: `event-${seq}`,
    seq,
    timestampMs: seq * 100,
    source: "recorder",
    track: "main",
    type: "record-start",
    payload: {
      initialLanguage: "javascript",
      initialFontSize: 18,
      initialTheme: "light",
      selectedAudioDeviceId: null,
      selectedCameraDeviceId: null,
      mediaCapability: {
        audio: "available",
        camera: "available",
        selectedAudioDeviceId: null,
        selectedCameraDeviceId: null,
      },
    },
  };
}

function createFakeChannel(initialState: InterviewRealtimeDataChannel["readyState"] = "open") {
  const sent: string[] = [];
  const channel: InterviewRealtimeDataChannel = {
    readyState: initialState,
    send(data) {
      sent.push(data);
    },
  };
  return { channel, sent };
}

function createFakeEventBus(
  history: RecordingEvent[] = [],
): Pick<EventBus, "peek" | "subscribe"> & { emit(event: RecordingEvent): void } {
  const listeners = new Set<(event: RecordingEvent) => void>();
  return {
    peek() {
      return history.slice();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      history.push(event);
      listeners.forEach((listener) => listener(event));
    },
  };
}

describe("InterviewSyncPublisher", () => {
  it("wraps event bus recording events for the reliable DataChannel without mutating them", () => {
    const { channel, sent } = createFakeChannel();
    const bus = createFakeEventBus();
    const publisher = createInterviewSyncPublisher({
      channel,
      roomId: "room-1",
      sessionId: "session-1",
      messageIdProvider: () => "message-1",
      nowProvider: () => 1234,
      stateVersionProvider: () => 7,
    });
    const event = contentEvent(1, "const answer = 42;");
    const before = structuredClone(event);

    const unsubscribe = publisher.subscribeTo(bus);
    bus.emit(event);
    unsubscribe();

    expect(event).toEqual(before);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toEqual({
      kind: "recording-event",
      roomId: "room-1",
      sessionId: "session-1",
      messageId: "message-1",
      sentAt: 1234,
      stateVersion: 7,
      contentHash: "hash-1",
      event,
    });
  });

  it("only replays existing EventBus events when backlog publishing is requested", () => {
    const { channel, sent } = createFakeChannel();
    const event = contentEvent(1, "const beforeSubscribe = true;");
    const bus = createFakeEventBus([event]);
    const publisher = createInterviewSyncPublisher({
      channel,
      roomId: "room-1",
      sessionId: "session-1",
    });

    const unsubscribeWithoutBacklog = publisher.subscribeTo(bus);
    unsubscribeWithoutBacklog();

    expect(sent).toEqual([]);

    const unsubscribeWithBacklog = publisher.subscribeTo(bus, { includeBacklog: true });
    unsubscribeWithBacklog();

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]).event).toEqual(event);
  });

  it("returns an explicit failure when the DataChannel is not open", () => {
    const { channel, sent } = createFakeChannel("closed");
    const publisher = createInterviewSyncPublisher({
      channel,
      roomId: "room-1",
      sessionId: "session-1",
    });

    const result = publisher.publishRecordingEvent(contentEvent(1));

    expect(result).toEqual({ ok: false, reason: "channel-not-open" });
    expect(sent).toEqual([]);
  });

  it("returns an explicit failure when DataChannel send throws", () => {
    const channel: InterviewRealtimeDataChannel = {
      readyState: "open",
      send() {
        throw new Error("send failed");
      },
    };
    const publisher = createInterviewSyncPublisher({
      channel,
      roomId: "room-1",
      sessionId: "session-1",
    });

    expect(publisher.publishRecordingEvent(contentEvent(1))).toEqual({
      ok: false,
      reason: "send-failed",
    });
  });

  it("publishes a state snapshot reflecting all published events", () => {
    const { channel, sent } = createFakeChannel();
    const publisher = createInterviewSyncPublisher({
      channel,
      roomId: "room-1",
      sessionId: "session-1",
      messageIdProvider: () => "snapshot-message",
      nowProvider: () => 4321,
      stateVersionProvider: () => 9,
      snapshotState: initialStableState(),
    });

    publisher.publishRecordingEvent(contentEvent(1, "const a = 1;"));
    publisher.publishRecordingEvent(contentEvent(2, "const a = 2;"));
    const result = publisher.publishSnapshot();

    expect(result.ok).toBe(true);
    const expectedState = [contentEvent(1, "const a = 1;"), contentEvent(2, "const a = 2;")].reduce(
      replayReducer,
      initialStableState(),
    );
    const snapshotPayload = JSON.parse(sent.at(-1)!);
    expect(snapshotPayload).toEqual({
      kind: "state-snapshot",
      roomId: "room-1",
      sessionId: "session-1",
      messageId: "snapshot-message",
      sentAt: 4321,
      snapshotSeq: 2,
      snapshotTimeMs: 200,
      stateVersion: 9,
      state: expectedState,
    });
  });

  it("auto-emits a snapshot every N stable events while subscribed", () => {
    const { channel, sent } = createFakeChannel();
    const bus = createFakeEventBus();
    const publisher = createInterviewSyncPublisher({
      channel,
      roomId: "room-1",
      sessionId: "session-1",
      snapshotState: initialStableState(),
      snapshotEventInterval: 3,
      snapshotTimeIntervalMs: Number.POSITIVE_INFINITY,
    });

    const unsubscribe = publisher.subscribeTo(bus);
    for (let seq = 1; seq <= 3; seq += 1) {
      bus.emit(contentEvent(seq, `const v = ${seq};`));
    }
    unsubscribe();

    const kinds = sent.map((raw) => JSON.parse(raw).kind);
    expect(kinds.filter((kind) => kind === "recording-event")).toHaveLength(3);
    const snapshots = sent
      .map((raw) => JSON.parse(raw))
      .filter((message) => message.kind === "state-snapshot");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].snapshotSeq).toBe(3);
  });

  it("auto-emits a snapshot once the time interval elapses", () => {
    const { channel, sent } = createFakeChannel();
    const bus = createFakeEventBus();
    let now = 1000;
    const publisher = createInterviewSyncPublisher({
      channel,
      roomId: "room-1",
      sessionId: "session-1",
      nowProvider: () => now,
      snapshotState: initialStableState(),
      snapshotEventInterval: Number.POSITIVE_INFINITY,
      snapshotTimeIntervalMs: 5000,
    });

    const unsubscribe = publisher.subscribeTo(bus);
    bus.emit(contentEvent(1, "const v = 1;"));
    expect(sent.map((raw) => JSON.parse(raw).kind)).toEqual(["recording-event"]);

    now = 6500;
    bus.emit(contentEvent(2, "const v = 2;"));
    unsubscribe();

    const snapshots = sent
      .map((raw) => JSON.parse(raw))
      .filter((message) => message.kind === "state-snapshot");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].snapshotSeq).toBe(2);
  });

  it("does not emit a snapshot when the channel is not open", () => {
    const { channel, sent } = createFakeChannel("closed");
    const publisher = createInterviewSyncPublisher({
      channel,
      roomId: "room-1",
      sessionId: "session-1",
      snapshotState: initialStableState(),
    });

    expect(publisher.publishSnapshot()).toEqual({ ok: false, reason: "channel-not-open" });
    expect(sent).toEqual([]);
  });

  it("seeds the snapshot state from the record-start payload", () => {
    const { channel, sent } = createFakeChannel();
    const publisher = createInterviewSyncPublisher({
      channel,
      roomId: "room-1",
      sessionId: "session-1",
      snapshotState: initialStableState(),
    });

    publisher.publishRecordingEvent(recordStartEvent(1));
    publisher.publishSnapshot();
    const seededOnly = JSON.parse(sent.at(-1)!);
    expect(seededOnly.state.editor.language).toBe("javascript");
    expect(seededOnly.state.editor.fontSize).toBe(18);
    expect(seededOnly.state.editor.theme).toBe("light");

    publisher.publishRecordingEvent(contentEvent(2, "const seeded = true;"));
    publisher.publishSnapshot();
    const snapshot = JSON.parse(sent.at(-1)!);
    // content-change carries its own language; fontSize/theme remain seeded.
    expect(snapshot.state.editor.fontSize).toBe(18);
    expect(snapshot.state.editor.theme).toBe("light");
    expect(snapshot.state.editor.code).toBe("const seeded = true;");
  });

  it("emits a snapshot after rebuilding deduped backlog past the event threshold", () => {
    const { channel, sent } = createFakeChannel();
    const events = Array.from({ length: 3 }, (_, index) => contentEvent(index + 1, `const v = ${index + 1};`));
    const bus = createFakeEventBus(events.slice());
    const alreadyPublished = new Set(events.map((event) => event.id));
    const publisher = createInterviewSyncPublisher({
      channel,
      roomId: "room-1",
      sessionId: "session-1",
      snapshotState: initialStableState(),
      snapshotEventInterval: 3,
      snapshotTimeIntervalMs: Number.POSITIVE_INFINITY,
    });

    const unsubscribe = publisher.subscribeTo(bus, {
      includeBacklog: true,
      shouldPublishEvent: (event) => !alreadyPublished.has(event.id),
    });
    unsubscribe();

    const messages = sent.map((raw) => JSON.parse(raw));
    expect(messages.filter((message) => message.kind === "recording-event")).toHaveLength(0);
    const snapshots = messages.filter((message) => message.kind === "state-snapshot");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].snapshotSeq).toBe(3);
    expect(snapshots[0].state.editor.code).toBe("const v = 3;");
  });
});

describe("RemoteTimelineBuffer", () => {
  it("flushes out-of-order events in candidate seq order once the gap is filled", () => {
    const buffer = createRemoteTimelineBuffer();

    const first = buffer.pushRecordingEvent({
      kind: "recording-event",
      roomId: "room-1",
      sessionId: "session-1",
      messageId: "message-2",
      sentAt: 200,
      stateVersion: 1,
      event: contentEvent(2),
    });
    const second = buffer.pushRecordingEvent({
      kind: "recording-event",
      roomId: "room-1",
      sessionId: "session-1",
      messageId: "message-1",
      sentAt: 100,
      stateVersion: 1,
      event: contentEvent(1),
    });

    expect(first.appliedEvents).toEqual([]);
    expect(first.snapshotRequestNeeded).toEqual({
      reason: "gap-detected",
      expectedSeq: 1,
      lastAppliedSeq: 0,
    });
    expect(second.appliedEvents.map((event) => event.seq)).toEqual([1, 2]);
    expect(second.snapshotRequestNeeded).toBeNull();
    expect(second.lastAppliedSeq).toBe(2);
  });

  it("ignores duplicate or old events without rolling back the stable state", () => {
    const buffer = createRemoteTimelineBuffer();

    expect(buffer.pushRecordingEvent(messageFor(contentEvent(1))).appliedEvents).toHaveLength(1);
    expect(buffer.pushRecordingEvent(messageFor(contentEvent(2))).appliedEvents).toHaveLength(1);

    const duplicate = buffer.pushRecordingEvent(messageFor(contentEvent(2, "stale duplicate")));
    const old = buffer.pushRecordingEvent(messageFor(contentEvent(1, "old event")));

    expect(duplicate.appliedEvents).toEqual([]);
    expect(old.appliedEvents).toEqual([]);
    expect(duplicate.lastAppliedSeq).toBe(2);
    expect(old.lastAppliedSeq).toBe(2);
  });

  it("does not apply a later event across a missing seq and exposes snapshot request state", () => {
    const buffer = createRemoteTimelineBuffer({ initialExpectedSeq: 2 });

    const result = buffer.pushRecordingEvent(messageFor(contentEvent(3)));

    expect(result.appliedEvents).toEqual([]);
    expect(result.lastAppliedSeq).toBe(1);
    expect(result.snapshotRequestNeeded).toEqual({
      reason: "gap-detected",
      expectedSeq: 2,
      lastAppliedSeq: 1,
    });
  });

  it("accepts snapshots to skip gaps and replay buffered later events", () => {
    const buffer = createRemoteTimelineBuffer({ initialExpectedSeq: 2 });

    buffer.pushRecordingEvent(messageFor(contentEvent(3)));
    const result = buffer.pushSnapshot(snapshotMessage(2));

    expect(result.snapshotAccepted).toBe(true);
    expect(result.appliedEvents.map((event) => event.seq)).toEqual([3]);
    expect(result.lastAppliedSeq).toBe(3);
    expect(result.expectedSeq).toBe(4);
    expect(result.snapshotRequestNeeded).toBeNull();
  });

  it("ignores stale snapshots without clearing the pending gap", () => {
    const buffer = createRemoteTimelineBuffer();

    buffer.pushRecordingEvent(messageFor(contentEvent(1)));
    buffer.pushRecordingEvent(messageFor(contentEvent(3)));
    const result = buffer.pushSnapshot(snapshotMessage(0));

    expect(result.snapshotAccepted).toBe(false);
    expect(result.appliedEvents).toEqual([]);
    expect(result.lastAppliedSeq).toBe(1);
    expect(result.snapshotRequestNeeded).toEqual({
      reason: "gap-detected",
      expectedSeq: 2,
      lastAppliedSeq: 1,
    });
  });
});

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

function snapshotMessage(snapshotSeq: number) {
  return {
    kind: "state-snapshot" as const,
    roomId: "room-1",
    sessionId: "session-1",
    messageId: `snapshot-${snapshotSeq}`,
    sentAt: snapshotSeq * 100,
    snapshotSeq,
    snapshotTimeMs: snapshotSeq * 100,
    stateVersion: snapshotSeq,
    state: {} as ReplayStableState,
  };
}
