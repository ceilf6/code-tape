import type { InterviewRoomStatus } from "./interviewRoomClient";

export type InterviewSignalingRole = "candidate" | "interviewer";

export type InterviewSignalingSocket = {
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type InterviewSignalingSocketConstructor = new (url: string) => InterviewSignalingSocket;

type BaseSignalingMessage = {
  roomId: string;
  connectionId: string;
  role: InterviewSignalingRole;
  messageId: string;
  sentAt: number;
};

export type JoinSignalingMessage = BaseSignalingMessage & {
  kind: "join";
  joinCode: string;
};

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

export type OutboundSignalingMessage =
  | JoinSignalingMessage
  | SessionDescriptionSignalingMessage
  | IceCandidateSignalingMessage
  | ControlSignalingMessage;

export type JoinedSignalingMessage = {
  kind: "joined";
  roomId: string;
  role: InterviewSignalingRole;
  status: InterviewRoomStatus;
};

export type EndedSignalingMessage = {
  kind: "ended";
  roomId: string;
};

export type ErrorSignalingMessage = {
  kind: "error";
  code: string;
  message: string;
};

export type ConnectedSignalingMessage = {
  kind: "connected";
  roomId: string;
  connectionId: string;
};

export type InboundSignalingMessage =
  | Omit<JoinSignalingMessage, "joinCode">
  | SessionDescriptionSignalingMessage
  | IceCandidateSignalingMessage
  | ControlSignalingMessage
  | ConnectedSignalingMessage
  | JoinedSignalingMessage
  | EndedSignalingMessage
  | ErrorSignalingMessage;

export type InterviewSignalingClientError = {
  code: string;
  message: string;
};

export type InterviewSignalingSendResult =
  | { ok: true; message: OutboundSignalingMessage }
  | { ok: false; reason: "connection-not-ready" | "socket-not-open" | "send-failed" };

export type InterviewSignalingClientOptions = {
  signalingUrl: string;
  baseUrl?: string | URL;
  roomId: string;
  role: InterviewSignalingRole;
  joinCode: string;
  WebSocket?: InterviewSignalingSocketConstructor;
  now?: () => number;
  createMessageId?: () => string;
  onMessage?: (message: InboundSignalingMessage) => void;
  onError?: (error: InterviewSignalingClientError) => void;
};

export type InterviewSignalingClient = {
  readonly socket: InterviewSignalingSocket;
  getConnectionId(): string | null;
  sendJoin(): InterviewSignalingSendResult;
  sendOffer(sdp: string): InterviewSignalingSendResult;
  sendAnswer(sdp: string): InterviewSignalingSendResult;
  sendIceCandidate(candidate: {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
  }): InterviewSignalingSendResult;
  sendHeartbeat(): InterviewSignalingSendResult;
  sendLeave(): InterviewSignalingSendResult;
  close(code?: number, reason?: string): void;
};

const SOCKET_OPEN = 1;

export function createInterviewSignalingClient(
  options: InterviewSignalingClientOptions,
): InterviewSignalingClient {
  const WebSocketCtor = options.WebSocket ?? defaultWebSocketConstructor();
  const socket = new WebSocketCtor(
    buildInterviewSignalingWebSocketUrl(options.signalingUrl, options.baseUrl),
  );
  const now = options.now ?? (() => Date.now());
  const createMessageId = options.createMessageId ?? defaultMessageId;
  let connectionId: string | null = null;

  socket.onmessage = (event) => {
    const parsed = parseInboundSignalingMessage(event.data);
    if (parsed.ok) {
      if (parsed.message.kind === "connected" && parsed.message.roomId === options.roomId) {
        connectionId = parsed.message.connectionId;
      }
      options.onMessage?.(parsed.message);
    } else {
      options.onError?.(parsed.error);
    }
  };
  socket.onerror = () => {
    options.onError?.({
      code: "socket-error",
      message: "interview signaling socket error",
    });
  };

  const base = (): BaseSignalingMessage | null =>
    connectionId
      ? {
          roomId: options.roomId,
          role: options.role,
          connectionId,
          messageId: createMessageId(),
          sentAt: now(),
        }
      : null;

  const send = (
    createMessage: (baseMessage: BaseSignalingMessage) => OutboundSignalingMessage,
  ): InterviewSignalingSendResult => {
    const baseMessage = base();
    if (!baseMessage) {
      return { ok: false, reason: "connection-not-ready" };
    }
    if (socket.readyState !== SOCKET_OPEN) {
      return { ok: false, reason: "socket-not-open" };
    }
    const message = createMessage(baseMessage);
    try {
      socket.send(JSON.stringify(message));
      return { ok: true, message };
    } catch {
      return { ok: false, reason: "send-failed" };
    }
  };

  return {
    socket,
    getConnectionId() {
      return connectionId;
    },
    sendJoin() {
      return send((baseMessage) => ({
        ...baseMessage,
        kind: "join",
        joinCode: options.joinCode,
      }));
    },
    sendOffer(sdp) {
      return send((baseMessage) => ({ ...baseMessage, kind: "offer", sdp }));
    },
    sendAnswer(sdp) {
      return send((baseMessage) => ({ ...baseMessage, kind: "answer", sdp }));
    },
    sendIceCandidate(candidate) {
      return send((baseMessage) => ({
        ...baseMessage,
        kind: "ice-candidate",
        ...candidate,
      }));
    },
    sendHeartbeat() {
      return send((baseMessage) => ({ ...baseMessage, kind: "heartbeat" }));
    },
    sendLeave() {
      return send((baseMessage) => ({ ...baseMessage, kind: "leave" }));
    },
    close(code, reason) {
      socket.onmessage = null;
      socket.onerror = null;
      socket.close(code, reason);
    },
  };
}

export function buildInterviewSignalingWebSocketUrl(
  signalingUrl: string,
  baseUrl?: string | URL,
): string {
  const url = new URL(signalingUrl, baseUrl ?? defaultBaseUrl());
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  }
  return url.toString();
}

function parseInboundSignalingMessage(
  raw: string,
):
  | { ok: true; message: InboundSignalingMessage }
  | { ok: false; error: InterviewSignalingClientError } {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return failure("bad-json", "signaling message must be valid JSON");
  }

  if (!isJsonObject(value) || !isNonEmptyString(value.kind)) {
    return failure("bad-message", "signaling message is missing kind");
  }

  switch (value.kind) {
    case "connected":
      if (isNonEmptyString(value.roomId) && isNonEmptyString(value.connectionId)) {
        return {
          ok: true,
          message: {
            kind: "connected",
            roomId: value.roomId,
            connectionId: value.connectionId,
          },
        };
      }
      return failure("bad-message", "connected message shape is invalid");
    case "joined":
      if (
        isNonEmptyString(value.roomId) &&
        isInterviewRole(value.role) &&
        isInterviewRoomStatus(value.status)
      ) {
        return {
          ok: true,
          message: {
            kind: "joined",
            roomId: value.roomId,
            role: value.role,
            status: value.status,
          },
        };
      }
      return failure("bad-message", "joined message shape is invalid");
    case "ended":
      if (isNonEmptyString(value.roomId)) {
        return { ok: true, message: { kind: "ended", roomId: value.roomId } };
      }
      return failure("bad-message", "ended message shape is invalid");
    case "error":
      if (isNonEmptyString(value.code) && isNonEmptyString(value.message)) {
        return {
          ok: true,
          message: { kind: "error", code: value.code, message: value.message },
        };
      }
      return failure("bad-message", "error message shape is invalid");
    case "join":
    case "heartbeat":
    case "leave":
    case "offer":
    case "answer":
    case "ice-candidate":
      return parsePeerSignalingMessage(value);
    default:
      return failure("unknown-message-kind", "signaling message kind is not supported");
  }
}

function parsePeerSignalingMessage(
  value: Record<string, unknown>,
):
  | { ok: true; message: InboundSignalingMessage }
  | { ok: false; error: InterviewSignalingClientError } {
  const base = parseBase(value);
  if (!base) {
    return failure("bad-message", "signaling message is missing required identity fields");
  }

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
        return failure("bad-message", "session description message requires sdp");
      }
      return { ok: true, message: { ...base, kind: value.kind, sdp: value.sdp } };
    case "ice-candidate":
      if (!isNonEmptyString(value.candidate)) {
        return failure("bad-message", "ice-candidate message requires candidate");
      }
      if (
        value.sdpMid !== undefined &&
        value.sdpMid !== null &&
        !isNonEmptyString(value.sdpMid)
      ) {
        return failure("bad-message", "ice-candidate sdpMid must be a string when present");
      }
      if (
        value.sdpMLineIndex !== undefined &&
        value.sdpMLineIndex !== null &&
        !Number.isSafeInteger(value.sdpMLineIndex)
      ) {
        return failure("bad-message", "ice-candidate sdpMLineIndex must be an integer when present");
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
  }
  return failure("unknown-message-kind", "signaling message kind is not supported");
}

function parseBase(value: Record<string, unknown>): BaseSignalingMessage | null {
  if (
    !isNonEmptyString(value.roomId) ||
    !isNonEmptyString(value.connectionId) ||
    !isInterviewRole(value.role) ||
    !isNonEmptyString(value.messageId) ||
    typeof value.sentAt !== "number" ||
    !Number.isFinite(value.sentAt)
  ) {
    return null;
  }
  return {
    roomId: value.roomId,
    connectionId: value.connectionId,
    role: value.role,
    messageId: value.messageId,
    sentAt: value.sentAt,
  };
}

function defaultWebSocketConstructor(): InterviewSignalingSocketConstructor {
  if (typeof WebSocket === "undefined") {
    throw new Error("WebSocket is not available in this environment");
  }
  return WebSocket;
}

function defaultBaseUrl(): string {
  if (typeof window !== "undefined") {
    return window.location.href;
  }
  return "http://localhost/";
}

function defaultMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `signal-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isInterviewRoomStatus(value: unknown): value is InterviewRoomStatus {
  return (
    value === "waiting" ||
    value === "connecting" ||
    value === "live" ||
    value === "ended" ||
    value === "expired"
  );
}

function isInterviewRole(value: unknown): value is InterviewSignalingRole {
  return value === "candidate" || value === "interviewer";
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function failure(
  code: InterviewSignalingClientError["code"],
  message: string,
): { ok: false; error: InterviewSignalingClientError } {
  return { ok: false, error: { code, message } };
}
