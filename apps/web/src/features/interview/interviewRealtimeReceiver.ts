import {
  RECORDING_SCHEMA_VERSION,
  validateRecordingPackageV1,
  type RecordingEvent,
  type ReplayStableState,
} from "@/shared/recording-schema";
import type { InterviewEventsDataChannel } from "./interviewMediaSession";
import type { InterviewRecordingEventMessage, InterviewSnapshotMessage } from "./interviewSync";
import type { RemoteInterviewWorkbench } from "./remoteInterviewWorkbench";

export type InterviewRealtimeReceiverIgnoredReason =
  | "non-string-data"
  | "invalid-json"
  | "unsupported-kind"
  | "invalid-message"
  | "room-mismatch";

export type InterviewRealtimeReceiverResult =
  | { ok: true; message: InterviewRecordingEventMessage | InterviewSnapshotMessage }
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

const RECORDING_EVENT_VALIDATION_PACKAGE = {
  schemaVersion: RECORDING_SCHEMA_VERSION,
  manifest: {
    packageId: "interview-realtime-message",
    schemaVersion: RECORDING_SCHEMA_VERSION,
    status: "complete",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
    checksums: { eventsSha256: "realtime", snapshotsSha256: "realtime" },
  },
  meta: {
    id: "interview-realtime-message",
    title: "Interview realtime message",
    createdAt: "2026-01-01T00:00:00.000Z",
    durationMs: 0,
    appVersion: "0.0.0",
    ownerId: null,
    creatorInfo: null,
    initialLanguage: "typescript",
    initialFontSize: 14,
    initialTheme: "dark",
    mediaCapability: {
      audio: "available",
      camera: "available",
      selectedAudioDeviceId: null,
      selectedCameraDeviceId: null,
    },
  },
  snapshots: [],
  media: null,
} as const;

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

    if (
      !isPlainObject(parsed) ||
      (parsed.kind !== "recording-event" && parsed.kind !== "state-snapshot")
    ) {
      return notify({ ok: false, reason: "unsupported-kind" });
    }
    if (parsed.roomId !== options.roomId) {
      return notify({ ok: false, reason: "room-mismatch" });
    }

    if (parsed.kind === "state-snapshot") {
      if (!isInterviewSnapshotMessage(parsed)) {
        return notify({ ok: false, reason: "invalid-message" });
      }
      options.workbench.pushSnapshot(parsed);
      return notify({ ok: true, message: parsed });
    }

    if (!isInterviewRecordingEventMessage(parsed)) {
      return notify({ ok: false, reason: "invalid-message" });
    }
    options.workbench.pushRecordingEvent(parsed);
    return notify({ ok: true, message: parsed });
  };

  return {
    attach(channel) {
      if (isClosedEventsDataChannel(channel)) {
        return () => {};
      }
      const previousHandler = channel.onmessage;
      const previousCloseHandler = channel.onclose;
      function handler(event: { data: unknown }) {
        if (isClosedEventsDataChannel(channel)) {
          detach();
          return;
        }
        handleData(event.data);
      }
      function closeHandler() {
        detach();
        previousCloseHandler?.();
      }
      function detach() {
        if (channel.onmessage === handler) {
          channel.onmessage = previousHandler;
        }
        if (channel.onclose === closeHandler) {
          channel.onclose = previousCloseHandler;
        }
      }
      channel.onmessage = handler;
      channel.onclose = closeHandler;
      return detach;
    },
    handleData,
  };
}

function isClosedEventsDataChannel(channel: InterviewEventsDataChannel): boolean {
  return channel.readyState === "closed" || channel.readyState === "closing";
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
    isPositiveInteger(value.seq) &&
    isFiniteNumber(value.timestampMs) &&
    typeof value.source === "string" &&
    typeof value.track === "string" &&
    typeof value.type === "string" &&
    RECORDING_EVENT_TYPES.has(value.type as RecordingEvent["type"]) &&
    isPlainObject(value.payload) &&
    hasValidRecordingEventPayload(value as RecordingEvent)
  );
}

function isInterviewSnapshotMessage(value: Record<string, unknown>): value is InterviewSnapshotMessage {
  return (
    value.kind === "state-snapshot" &&
    typeof value.roomId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.messageId === "string" &&
    isFiniteNumber(value.sentAt) &&
    isNonNegativeInteger(value.snapshotSeq) &&
    isFiniteNumber(value.snapshotTimeMs) &&
    isFiniteNumber(value.stateVersion) &&
    isReplayStableState(value.state)
  );
}

function hasValidRecordingEventPayload(event: RecordingEvent): boolean {
  return validateRecordingPackageV1({
    ...RECORDING_EVENT_VALIDATION_PACKAGE,
    events: [event],
  }).ok;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isReplayStableState(value: unknown): value is ReplayStableState {
  if (!isPlainObject(value)) {
    return false;
  }

  const { editor, pointer, media, runtime } = value;
  return (
    isEditorState(editor) &&
    isPointerState(pointer) &&
    isMediaState(media) &&
    isRuntimeState(runtime)
  );
}

function isEditorState(value: unknown): value is ReplayStableState["editor"] {
  if (!isPlainObject(value)) {
    return false;
  }
  return (
    typeof value.code === "string" &&
    isRecordingLanguage(value.language) &&
    isCursor(value.cursor) &&
    isSelection(value.selection) &&
    isFiniteNumber(value.scrollTop) &&
    isFiniteNumber(value.scrollLeft) &&
    isFiniteNumber(value.fontSize) &&
    isRecordingTheme(value.theme)
  );
}

function isPointerState(value: unknown): value is ReplayStableState["pointer"] {
  if (value === null) {
    return true;
  }
  return (
    isPlainObject(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    typeof value.visible === "boolean"
  );
}

function isMediaState(value: unknown): value is ReplayStableState["media"] {
  if (!isPlainObject(value) || !isPlainObject(value.cameraPosition)) {
    return false;
  }
  return (
    typeof value.microphoneEnabled === "boolean" &&
    typeof value.cameraEnabled === "boolean" &&
    isFiniteNumber(value.cameraPosition.x) &&
    isFiniteNumber(value.cameraPosition.y)
  );
}

function isRuntimeState(value: unknown): value is ReplayStableState["runtime"] {
  if (!isPlainObject(value)) {
    return false;
  }
  return (
    isRuntimeStatus(value.status) &&
    isStringArray(value.stdout) &&
    isStringArray(value.stderr) &&
    (value.previewHtml === null || typeof value.previewHtml === "string") &&
    (value.errorMessage === null || typeof value.errorMessage === "string")
  );
}

function isCursor(value: unknown): value is ReplayStableState["editor"]["cursor"] {
  if (value === null) {
    return true;
  }
  return isPlainObject(value) && isFiniteNumber(value.lineNumber) && isFiniteNumber(value.column);
}

function isSelection(value: unknown): value is ReplayStableState["editor"]["selection"] {
  if (value === null) {
    return true;
  }
  return (
    isPlainObject(value) &&
    isFiniteNumber(value.startLineNumber) &&
    isFiniteNumber(value.startColumn) &&
    isFiniteNumber(value.endLineNumber) &&
    isFiniteNumber(value.endColumn)
  );
}

function isRecordingLanguage(value: unknown): value is ReplayStableState["editor"]["language"] {
  return value === "javascript" || value === "typescript" || value === "python";
}

function isRecordingTheme(value: unknown): value is ReplayStableState["editor"]["theme"] {
  return value === "light" || value === "dark";
}

function isRuntimeStatus(value: unknown): value is ReplayStableState["runtime"]["status"] {
  return value === "idle" || value === "running" || value === "success" || value === "error";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
