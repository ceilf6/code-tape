import type { RecordingEvent } from "@/shared/recording-schema";
import type { InterviewEventsDataChannel } from "./interviewMediaSession";
import type { InterviewRecordingEventMessage } from "./interviewSync";
import type { RemoteInterviewWorkbench } from "./remoteInterviewWorkbench";

export type InterviewRealtimeReceiverIgnoredReason =
  | "non-string-data"
  | "invalid-json"
  | "unsupported-kind"
  | "invalid-message"
  | "room-mismatch";

export type InterviewRealtimeReceiverResult =
  | { ok: true; message: InterviewRecordingEventMessage }
  | { ok: false; reason: InterviewRealtimeReceiverIgnoredReason };

export type InterviewRealtimeReceiverOptions = {
  roomId: string;
  workbench: RemoteInterviewWorkbench;
  onMessageResult?: (result: InterviewRealtimeReceiverResult) => void;
};

export type InterviewRealtimeReceiver = {
  attach(channel: InterviewEventsDataChannel): () => void;
  handleData(data: unknown): InterviewRealtimeReceiverResult;
};

const RECORDING_EVENT_TYPES = new Set<RecordingEvent["type"]>([
  "record-start",
  "record-pause",
  "record-resume",
  "resume-baseline",
  "record-stop",
  "content-change",
  "language-change",
  "selection-change",
  "editor-scroll",
  "mouse-move",
  "mouse-click",
  "shortcut",
  "media-toggle",
  "media-warning",
  "camera-position",
  "run-start",
  "run-output",
  "run-error",
  "chapter-marker",
]);

export function createInterviewRealtimeReceiver(
  options: InterviewRealtimeReceiverOptions,
): InterviewRealtimeReceiver {
  const notify = (result: InterviewRealtimeReceiverResult): InterviewRealtimeReceiverResult => {
    options.onMessageResult?.(result);
    return result;
  };

  const handleData = (data: unknown): InterviewRealtimeReceiverResult => {
    if (typeof data !== "string") {
      return notify({ ok: false, reason: "non-string-data" });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return notify({ ok: false, reason: "invalid-json" });
    }

    if (!isPlainObject(parsed) || parsed.kind !== "recording-event") {
      return notify({ ok: false, reason: "unsupported-kind" });
    }
    if (parsed.roomId !== options.roomId) {
      return notify({ ok: false, reason: "room-mismatch" });
    }
    if (!isInterviewRecordingEventMessage(parsed)) {
      return notify({ ok: false, reason: "invalid-message" });
    }

    options.workbench.pushRecordingEvent(parsed);
    return notify({ ok: true, message: parsed });
  };

  return {
    attach(channel) {
      const previousHandler = channel.onmessage;
      const handler = (event: { data: unknown }) => {
        handleData(event.data);
      };
      channel.onmessage = handler;
      return () => {
        if (channel.onmessage === handler) {
          channel.onmessage = previousHandler;
        }
      };
    },
    handleData,
  };
}

function isInterviewRecordingEventMessage(
  value: Record<string, unknown>,
): value is InterviewRecordingEventMessage {
  return (
    value.kind === "recording-event" &&
    typeof value.roomId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.messageId === "string" &&
    isFiniteNumber(value.sentAt) &&
    isFiniteNumber(value.stateVersion) &&
    (value.contentHash === undefined || typeof value.contentHash === "string") &&
    isRecordingEvent(value.event)
  );
}

function isRecordingEvent(value: unknown): value is RecordingEvent {
  if (!isPlainObject(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    isFiniteNumber(value.seq) &&
    isFiniteNumber(value.timestampMs) &&
    typeof value.source === "string" &&
    typeof value.track === "string" &&
    typeof value.type === "string" &&
    RECORDING_EVENT_TYPES.has(value.type as RecordingEvent["type"]) &&
    isPlainObject(value.payload)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
