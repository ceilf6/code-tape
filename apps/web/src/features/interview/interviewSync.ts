import {
  cloneReplayStableState,
  replayReducer,
  STABLE_EVENT_TYPES,
  type EventBus,
  type RecordingEvent,
  type ReplayStableState,
} from "@/shared/recording-schema";

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

export type InterviewSnapshotPublishResult =
  | { ok: true; message: InterviewSnapshotMessage }
  | { ok: false; reason: "channel-not-open" | "send-failed" | "no-published-events" };

export type InterviewSyncPublisherOptions = {
  channel: InterviewRealtimeDataChannel;
  roomId: string;
  sessionId: string;
  messageIdProvider?: () => string;
  nowProvider?: () => number;
  stateVersionProvider?: () => number;
  snapshotState?: ReplayStableState;
  snapshotEventInterval?: number;
  snapshotTimeIntervalMs?: number;
};

export type InterviewSyncPublisher = {
  publishRecordingEvent(event: RecordingEvent): InterviewPublishResult;
  publishSnapshot(): InterviewSnapshotPublishResult;
  subscribeTo(
    bus: Pick<EventBus, "subscribe"> & Partial<Pick<EventBus, "peek">>,
    options?: InterviewSyncSubscribeOptions,
  ): () => void;
};

export type InterviewSyncSubscribeOptions = {
  includeBacklog?: boolean;
  shouldPublishEvent?: (event: RecordingEvent) => boolean;
  onPublishResult?: (event: RecordingEvent, result: InterviewPublishResult) => void;
};

export function createInterviewSyncPublisher(
  options: InterviewSyncPublisherOptions,
): InterviewSyncPublisher {
  const messageIdProvider = options.messageIdProvider ?? createMessageId;
  const nowProvider = options.nowProvider ?? (() => Date.now());
  const stateVersionProvider = options.stateVersionProvider ?? (() => 0);
  const snapshotEventInterval = options.snapshotEventInterval ?? DEFAULT_SNAPSHOT_EVENT_INTERVAL;
  const snapshotTimeIntervalMs =
    options.snapshotTimeIntervalMs ?? DEFAULT_SNAPSHOT_TIME_INTERVAL_MS;
  const tracksSnapshots = options.snapshotState !== undefined;

  let snapshotState = options.snapshotState
    ? cloneReplayStableState(options.snapshotState)
    : null;
  let lastPublishedSeq: number | null = null;
  let lastPublishedTimestampMs = 0;
  let stableEventsSinceSnapshot = 0;
  let lastSnapshotAtMs: number | null = null;

  const advanceSnapshotState = (event: RecordingEvent) => {
    if (snapshotState) {
      snapshotState = replayReducer(snapshotState, event);
    }
    lastPublishedSeq = event.seq;
    lastPublishedTimestampMs = event.timestampMs;
    if (STABLE_EVENT_TYPES.has(event.type)) {
      stableEventsSinceSnapshot += 1;
    }
  };

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
    } catch {
      return { ok: false, reason: "send-failed" };
    }

    advanceSnapshotState(event);
    return { ok: true, message };
  };

  const publishSnapshot = (): InterviewSnapshotPublishResult => {
    if (options.channel.readyState !== "open") {
      return { ok: false, reason: "channel-not-open" };
    }
    if (!snapshotState || lastPublishedSeq === null) {
      return { ok: false, reason: "no-published-events" };
    }

    const message: InterviewSnapshotMessage = {
      kind: "state-snapshot",
      roomId: options.roomId,
      sessionId: options.sessionId,
      messageId: messageIdProvider(),
      sentAt: nowProvider(),
      snapshotSeq: lastPublishedSeq,
      snapshotTimeMs: lastPublishedTimestampMs,
      stateVersion: stateVersionProvider(),
      state: cloneReplayStableState(snapshotState),
    };

    try {
      options.channel.send(JSON.stringify(message));
    } catch {
      return { ok: false, reason: "send-failed" };
    }

    stableEventsSinceSnapshot = 0;
    lastSnapshotAtMs = nowProvider();
    return { ok: true, message };
  };

  const maybeEmitSnapshot = () => {
    if (!tracksSnapshots || lastPublishedSeq === null) return;
    const now = nowProvider();
    if (lastSnapshotAtMs === null) {
      lastSnapshotAtMs = now;
    }
    const dueByEvents = stableEventsSinceSnapshot >= snapshotEventInterval;
    const dueByTime = now - lastSnapshotAtMs >= snapshotTimeIntervalMs;
    if (dueByEvents || dueByTime) {
      publishSnapshot();
    }
  };

  return {
    publishRecordingEvent,
    publishSnapshot,
    subscribeTo(bus, subscribeOptions = {}) {
      const publishFromSubscription = (event: RecordingEvent) => {
        if (subscribeOptions.shouldPublishEvent?.(event) === false) {
          // Event was already published by a prior publisher (e.g. after a
          // DataChannel reopen). Still advance the running snapshot state so a
          // later snapshot reflects the full published timeline.
          advanceSnapshotState(event);
          return;
        }
        const result = publishRecordingEvent(event);
        subscribeOptions.onPublishResult?.(event, result);
        if (result.ok) {
          maybeEmitSnapshot();
        }
      };

      if (subscribeOptions.includeBacklog) {
        bus.peek?.().forEach(publishFromSubscription);
      }

      return bus.subscribe(publishFromSubscription);
    },
  };
}

const DEFAULT_SNAPSHOT_EVENT_INTERVAL = 50;
const DEFAULT_SNAPSHOT_TIME_INTERVAL_MS = 5000;

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

export type RemoteTimelineBufferSnapshotResult = RemoteTimelineBufferResult & {
  snapshotAccepted: boolean;
};

export type RemoteTimelineBufferOptions = {
  initialExpectedSeq?: number;
};

export type RemoteTimelineBuffer = {
  pushRecordingEvent(message: InterviewRecordingEventMessage): RemoteTimelineBufferResult;
  pushSnapshot(message: InterviewSnapshotMessage): RemoteTimelineBufferSnapshotResult;
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

  const drainContiguousEvents = (): RecordingEvent[] => {
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
    return appliedEvents;
  };

  return {
    pushRecordingEvent(message) {
      const { event } = message;
      if (event.seq <= lastAppliedSeq) {
        return { appliedEvents: [], ...currentState() };
      }
      if (event.seq >= expectedSeq && !bufferedEvents.has(event.seq)) {
        bufferedEvents.set(event.seq, event);
      }

      const appliedEvents = drainContiguousEvents();

      return { appliedEvents, ...currentState() };
    },
    pushSnapshot(message) {
      if (message.snapshotSeq < lastAppliedSeq) {
        return { snapshotAccepted: false, appliedEvents: [], ...currentState() };
      }

      for (const seq of bufferedEvents.keys()) {
        if (seq <= message.snapshotSeq) {
          bufferedEvents.delete(seq);
        }
      }
      lastAppliedSeq = message.snapshotSeq;
      expectedSeq = message.snapshotSeq + 1;

      const appliedEvents = drainContiguousEvents();
      return { snapshotAccepted: true, appliedEvents, ...currentState() };
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
