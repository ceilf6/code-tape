import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { InterviewSignalingServer } from "./interviewSignalingServer.js";

export type InterviewWebSocketUpgradeHandler = {
  canHandle(request: IncomingMessage): boolean;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
};

export function createInterviewWebSocketUpgradeHandler(deps: {
  signaling: InterviewSignalingServer;
  createConnectionId?: () => string;
}): InterviewWebSocketUpgradeHandler {
  const createConnectionId = deps.createConnectionId ?? (() => crypto.randomUUID());
  const webSocketServer = new WebSocketServer({ noServer: true });

  return {
    canHandle(request) {
      return readRoomIdFromRequest(request) !== null;
    },

    handleUpgrade(request, socket, head) {
      const roomId = readRoomIdFromRequest(request);
      if (!roomId) {
        socket.destroy();
        return;
      }

      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        bindConnection({
          signaling: deps.signaling,
          webSocket,
          roomId,
          connectionId: createConnectionId(),
        });
      });
    },

    close() {
      webSocketServer.close();
    },
  };
}

function bindConnection(input: {
  signaling: InterviewSignalingServer;
  webSocket: WebSocket;
  roomId: string;
  connectionId: string;
}): void {
  const connection = {
    id: input.connectionId,
    send(raw: string) {
      if (input.webSocket.readyState === WebSocket.OPEN) {
        input.webSocket.send(raw);
      }
    },
  };

  input.webSocket.on("message", (data) => {
    const raw = rawDataToString(data);
    const messageRoomId = readMessageRoomId(raw);
    if (messageRoomId !== null && messageRoomId !== input.roomId) {
      connection.send(
        JSON.stringify({
          kind: "error",
          code: "room-mismatch",
          message: "message roomId does not match signaling URL",
        }),
      );
      return;
    }
    input.signaling.receive(connection, raw);
  });
  input.webSocket.on("close", () => {
    input.signaling.disconnect(connection.id);
  });
  input.webSocket.send(
    JSON.stringify({
      kind: "connected",
      roomId: input.roomId,
      connectionId: input.connectionId,
    }),
  );
}

function readRoomIdFromRequest(request: IncomingMessage): string | null {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const match = /^\/api\/interviews\/rooms\/([^/]+)\/signaling$/u.exec(
    pathname,
  );
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

function readMessageRoomId(raw: string): string | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as { roomId?: unknown }).roomId === "string"
    ) {
      return (value as { roomId: string }).roomId;
    }
  } catch {
    return null;
  }
  return null;
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  }
  return Buffer.from(new Uint8Array(data)).toString("utf8");
}
