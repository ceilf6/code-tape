import type { EventBus, RecordingEvent, ReplayStableState } from "@/shared/recording-schema";

export type InterviewRealtimeDataChannel = {
  readyState: "connecting" | "open" | "closing" | "closed";
  send(data: string): void;
};

type InterviewRealtimeBaseMessage = {
  roomId: string;
  sessionId: string;
  messageId: string;
  sentAt: number;
};

export type InterviewRecordingEventMessage = InterviewRealtimeBaseMessage & {
  kind: "recording-event";
  event: RecordingEvent;
  stateVersion: number;
  contentHash?: string;
};

export type InterviewSnapshotMessage = InterviewRealtimeBaseMessage & {
  kind: "state-snapshot";
  snapshotSeq: number;
  snapshotTimeMs: number;
  stateVersion: number;
  state: ReplayStableState;
};

export type InterviewSnapshotRequestMessage = InterviewRealtimeBaseMessage & {
  kind: "snapshot-request";
  reason: "gap-timeout" | "hash-mismatch" | "manual-reconnect";
  expectedSeq: number;
  lastAppliedSeq: number;
};

export type InterviewControlMessage = InterviewRealtimeBaseMessage & {
  kind: "control";
  action: "recording-started" | "recording-paused" | "recording-resumed" | "interview-ended";
  reason?: string;
};

export type InterviewAckMessage = InterviewRealtimeBaseMessage & {
  kind: "ack";
  ackedMessageId: string;
  lastAppliedSeq: number;
};

export type InterviewRealtimeMessage =
  | InterviewRecordingEventMessage
  | InterviewSnapshotMessage
  | InterviewSnapshotRequestMessage
  | InterviewControlMessage
  | InterviewAckMessage;

export type InterviewPublishResult =
  | { ok: true; message: InterviewRecordingEventMessage }
  | { ok: false; reason: "channel-not-open" | "send-failed" };

export type InterviewSyncPublisherOptions = {
  channel: InterviewRealtimeDataChannel;
  roomId: string;
  sessionId: string;
  messageIdProvider?: () => string;
  nowProvider?: () => number;
  stateVersionProvider?: () => number;
};

export type InterviewSyncPublisher = {
  publishRecordingEvent(event: RecordingEvent): InterviewPublishResult;
  subscribeTo(bus: Pick<EventBus, "subscribe">): () => void;
};

export function createInterviewSyncPublisher(
  options: InterviewSyncPublisherOptions,
): InterviewSyncPublisher {
  const messageIdProvider = options.messageIdProvider ?? createMessageId;
  const nowProvider = options.nowProvider ?? (() => Date.now());
  const stateVersionProvider = options.stateVersionProvider ?? (() => 0);

  const publishRecordingEvent = (event: RecordingEvent): InterviewPublishResult => {
    if (options.channel.readyState !== "open") {
      return { ok: false, reason: "channel-not-open" };
    }

    const message: InterviewRecordingEventMessage = {
      kind: "recording-event",
      roomId: options.roomId,
      sessionId: options.sessionId,
      messageId: messageIdProvider(),
      sentAt: nowProvider(),
      event,
      stateVersion: stateVersionProvider(),
      ...contentHashFor(event),
    };

    try {
      options.channel.send(JSON.stringify(message));
      return { ok: true, message };
    } catch {
      return { ok: false, reason: "send-failed" };
    }
  };

  return {
    publishRecordingEvent,
    subscribeTo(bus) {
      return bus.subscribe((event) => {
        publishRecordingEvent(event);
      });
    },
  };
}

export type SnapshotRequestNeed = {
  reason: "gap-detected";
  expectedSeq: number;
  lastAppliedSeq: number;
};

export type RemoteTimelineBufferResult = {
  appliedEvents: RecordingEvent[];
  expectedSeq: number;
  lastAppliedSeq: number;
  snapshotRequestNeeded: SnapshotRequestNeed | null;
};

export type RemoteTimelineBufferOptions = {
  initialExpectedSeq?: number;
};

export type RemoteTimelineBuffer = {
  pushRecordingEvent(message: InterviewRecordingEventMessage): RemoteTimelineBufferResult;
  state(): Omit<RemoteTimelineBufferResult, "appliedEvents">;
};

export function createRemoteTimelineBuffer(
  options: RemoteTimelineBufferOptions = {},
): RemoteTimelineBuffer {
  let expectedSeq = options.initialExpectedSeq ?? 1;
  let lastAppliedSeq = expectedSeq - 1;
  const bufferedEvents = new Map<number, RecordingEvent>();

  const currentSnapshotNeed = (): SnapshotRequestNeed | null =>
    bufferedEvents.size > 0
      ? { reason: "gap-detected", expectedSeq, lastAppliedSeq }
      : null;

  const currentState = () => ({
    expectedSeq,
    lastAppliedSeq,
    snapshotRequestNeeded: currentSnapshotNeed(),
  });

  return {
    pushRecordingEvent(message) {
      const { event } = message;
      if (event.seq <= lastAppliedSeq) {
        return { appliedEvents: [], ...currentState() };
      }
      if (event.seq >= expectedSeq && !bufferedEvents.has(event.seq)) {
        bufferedEvents.set(event.seq, event);
      }

      const appliedEvents: RecordingEvent[] = [];
      while (bufferedEvents.has(expectedSeq)) {
        const next = bufferedEvents.get(expectedSeq);
        if (!next) {
          break;
        }
        bufferedEvents.delete(expectedSeq);
        appliedEvents.push(next);
        lastAppliedSeq = next.seq;
        expectedSeq = next.seq + 1;
      }

      return { appliedEvents, ...currentState() };
    },
    state: currentState,
  };
}

function contentHashFor(event: RecordingEvent): Pick<InterviewRecordingEventMessage, "contentHash"> {
  if (event.type !== "content-change") {
    return {};
  }
  return { contentHash: event.payload.contentHash };
}

function createMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
