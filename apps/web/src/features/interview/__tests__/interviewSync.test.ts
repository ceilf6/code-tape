import { describe, expect, it } from "vitest";
import type { EventBus, RecordingEvent, ReplayStableState } from "@/shared/recording-schema";
import {
  createInterviewSyncPublisher,
  createRemoteTimelineBuffer,
  type InterviewRealtimeDataChannel,
} from "../interviewSync";

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
