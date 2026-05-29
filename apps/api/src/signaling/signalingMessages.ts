import type { InterviewRole } from "../interview/types.js";

export type SignalingMessageKind =
  | "join"
  | "offer"
  | "answer"
  | "ice-candidate"
  | "heartbeat"
  | "leave";

export type BaseSignalingMessage = {
  kind: SignalingMessageKind;
  roomId: string;
  connectionId: string;
  role: InterviewRole;
  messageId: string;
  sentAt: number;
};

export type JoinSignalingMessage = BaseSignalingMessage & { kind: "join" };
export type SessionDescriptionSignalingMessage = BaseSignalingMessage & {
  kind: "offer" | "answer";
  sdp: string;
};
export type IceCandidateSignalingMessage = BaseSignalingMessage & {
  kind: "ice-candidate";
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
};
export type ControlSignalingMessage = BaseSignalingMessage & {
  kind: "heartbeat" | "leave";
};

export type SignalingMessage =
  | JoinSignalingMessage
  | SessionDescriptionSignalingMessage
  | IceCandidateSignalingMessage
  | ControlSignalingMessage;

export type SignalingMessageErrorCode =
  | "bad-json"
  | "bad-message"
  | "message-too-large"
  | "unknown-message-kind";

export type SignalingMessageParseResult =
  | { ok: true; message: SignalingMessage }
  | { ok: false; error: { code: SignalingMessageErrorCode; message: string } };

const MAX_SIGNALING_MESSAGE_BYTES = 64 * 1024;

export function parseSignalingMessage(
  raw: string,
  options: { maxBytes?: number } = {},
): SignalingMessageParseResult {
  const maxBytes = options.maxBytes ?? MAX_SIGNALING_MESSAGE_BYTES;
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    return failure("message-too-large", "signaling message exceeds size limit");
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return failure("bad-json", "signaling message must be valid JSON");
  }

  if (!isJsonObject(value) || !hasBaseFields(value)) {
    return failure(
      "bad-message",
      "signaling message is missing required identity fields",
    );
  }
  const base: Omit<BaseSignalingMessage, "kind"> = {
    roomId: value.roomId as string,
    connectionId: value.connectionId as string,
    role: value.role as InterviewRole,
    messageId: value.messageId as string,
    sentAt: value.sentAt as number,
  };

  switch (value.kind) {
    case "join":
      return { ok: true, message: { ...base, kind: "join" } };
    case "heartbeat":
      return { ok: true, message: { ...base, kind: "heartbeat" } };
    case "leave":
      return { ok: true, message: { ...base, kind: "leave" } };
    case "offer":
    case "answer":
      if (!isNonEmptyString(value.sdp)) {
        return failure(
          "bad-message",
          "session description message requires sdp",
        );
      }
      return {
        ok: true,
        message: { ...base, kind: value.kind, sdp: value.sdp },
      };
    case "ice-candidate":
      if (!isNonEmptyString(value.candidate)) {
        return failure(
          "bad-message",
          "ice-candidate message requires candidate",
        );
      }
      if (
        value.sdpMid !== undefined &&
        value.sdpMid !== null &&
        !isNonEmptyString(value.sdpMid)
      ) {
        return failure(
          "bad-message",
          "ice-candidate sdpMid must be a string when present",
        );
      }
      if (
        value.sdpMLineIndex !== undefined &&
        value.sdpMLineIndex !== null &&
        !Number.isSafeInteger(value.sdpMLineIndex)
      ) {
        return failure(
          "bad-message",
          "ice-candidate sdpMLineIndex must be an integer when present",
        );
      }
      return {
        ok: true,
        message: {
          ...base,
          kind: "ice-candidate",
          candidate: value.candidate,
          sdpMid: value.sdpMid as string | null | undefined,
          sdpMLineIndex: value.sdpMLineIndex as number | null | undefined,
        },
      };
    default:
      return failure(
        "unknown-message-kind",
        "signaling message kind is not supported",
      );
  }
}

function hasBaseFields(value: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(value.roomId) &&
    isNonEmptyString(value.connectionId) &&
    isInterviewRole(value.role) &&
    isNonEmptyString(value.messageId) &&
    Number.isFinite(value.sentAt) &&
    isNonEmptyString(value.kind)
  );
}

function isInterviewRole(value: unknown): value is InterviewRole {
  return value === "candidate" || value === "interviewer";
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function failure(
  code: SignalingMessageErrorCode,
  message: string,
): SignalingMessageParseResult {
  return { ok: false, error: { code, message } };
}
