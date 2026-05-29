import type { InterviewRole } from "../interview/types.js";
import type { InterviewRoomService } from "../interview/interviewRoomService.js";
import {
  parseSignalingMessage,
  type SignalingMessage,
} from "./signalingMessages.js";

export type SignalingConnection = {
  id: string;
  send(raw: string): void;
};

export type InterviewSignalingServer = {
  receive(connection: SignalingConnection, raw: string): void;
  disconnect(connectionId: string): void;
  notifyRoomEnded(roomId: string): void;
};

type ActiveConnection = {
  roomId: string;
  role: InterviewRole;
  connection: SignalingConnection;
};

export function createInterviewSignalingServer(deps: {
  rooms: InterviewRoomService;
}): InterviewSignalingServer {
  const activeConnections = new Map<string, ActiveConnection>();

  return {
    receive(connection, raw) {
      const parsed = parseSignalingMessage(raw);
      if (!parsed.ok) {
        sendError(connection, parsed.error.code, parsed.error.message);
        return;
      }

      const message = parsed.message;
      if (message.connectionId !== connection.id) {
        sendError(
          connection,
          "connection-mismatch",
          "message connectionId does not match socket",
        );
        return;
      }

      if (message.kind === "join") {
        handleJoin({
          rooms: deps.rooms,
          activeConnections,
          connection,
          raw,
          message,
        });
        return;
      }

      const current = activeConnections.get(connection.id);
      if (
        !current ||
        current.roomId !== message.roomId ||
        current.role !== message.role
      ) {
        sendError(
          connection,
          "not-joined",
          "connection must join before sending signaling messages",
        );
        return;
      }

      if (message.kind === "leave") {
        deps.rooms.leaveRoom({
          roomId: message.roomId,
          connectionId: connection.id,
        });
        activeConnections.delete(connection.id);
      }

      const peer = findPeer(activeConnections, message.roomId, message.role);
      if (peer) {
        peer.connection.send(JSON.stringify(message));
      }
    },

    disconnect(connectionId) {
      const active = activeConnections.get(connectionId);
      if (active) {
        deps.rooms.leaveRoom({ roomId: active.roomId, connectionId });
        activeConnections.delete(connectionId);
        notifyPeerDisconnected(activeConnections, active);
        return;
      }
      activeConnections.delete(connectionId);
    },

    notifyRoomEnded(roomId) {
      for (const [connectionId, active] of activeConnections.entries()) {
        if (active.roomId !== roomId) continue;
        active.connection.send(JSON.stringify({ kind: "ended", roomId }));
        activeConnections.delete(connectionId);
      }
    },
  };
}

function notifyPeerDisconnected(
  activeConnections: Map<string, ActiveConnection>,
  active: ActiveConnection,
): void {
  const peer = findPeer(activeConnections, active.roomId, active.role);
  if (!peer) return;

  const sentAt = Date.now();
  peer.connection.send(
    JSON.stringify({
      kind: "leave",
      roomId: active.roomId,
      role: active.role,
      connectionId: active.connection.id,
      messageId: `disconnect-${active.connection.id}-${sentAt}`,
      sentAt,
    }),
  );
}

function handleJoin(input: {
  rooms: InterviewRoomService;
  activeConnections: Map<string, ActiveConnection>;
  connection: SignalingConnection;
  raw: string;
  message: SignalingMessage & { kind: "join" };
}): void {
  if (input.activeConnections.has(input.connection.id)) {
    sendError(
      input.connection,
      "already-joined",
      "connection has already joined an interview room",
    );
    return;
  }

  const joinCode = readJoinCode(input.raw);
  if (!joinCode) {
    sendError(
      input.connection,
      "bad-message",
      "join message requires joinCode",
    );
    return;
  }

  const joined = input.rooms.joinRoom({
    roomId: input.message.roomId,
    joinCode,
    role: input.message.role,
    connectionId: input.message.connectionId,
  });
  if (!joined.ok) {
    sendError(input.connection, joined.error.code, joined.error.message);
    return;
  }

  input.activeConnections.set(input.connection.id, {
    roomId: input.message.roomId,
    role: input.message.role,
    connection: input.connection,
  });
  input.connection.send(
    JSON.stringify({
      kind: "joined",
      roomId: input.message.roomId,
      role: input.message.role,
      status: joined.room.status,
    }),
  );

  const peer = findPeer(
    input.activeConnections,
    input.message.roomId,
    input.message.role,
  );
  if (peer) {
    peer.connection.send(
      JSON.stringify({
        kind: "joined",
        roomId: input.message.roomId,
        role: input.message.role,
        status: joined.room.status,
      }),
    );
  }
}

function findPeer(
  activeConnections: Map<string, ActiveConnection>,
  roomId: string,
  senderRole: InterviewRole,
): ActiveConnection | null {
  for (const active of activeConnections.values()) {
    if (active.roomId === roomId && active.role !== senderRole) {
      return active;
    }
  }
  return null;
}

function readJoinCode(raw: string): string | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as { joinCode?: unknown }).joinCode === "string" &&
      (value as { joinCode: string }).joinCode.trim().length > 0
    ) {
      return (value as { joinCode: string }).joinCode;
    }
  } catch {
    return null;
  }
  return null;
}

function sendError(
  connection: SignalingConnection,
  code: string,
  message: string,
): void {
  connection.send(JSON.stringify({ kind: "error", code, message }));
}
