import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import { createApiHandler } from "../../http/createApiHandler.js";
import { createInterviewApiHandler } from "../../http/interviewApiHandler.js";
import { createInterviewRoomService } from "../../interview/interviewRoomService.js";
import { createMemoryInterviewRoomRepository } from "../../interview/memoryInterviewRoomRepository.js";
import { createInterviewSignalingServer } from "../interviewSignalingServer.js";
import { createInterviewWebSocketUpgradeHandler } from "../interviewWebSocketUpgradeHandler.js";

test("websocket upgrade handler connects the returned signaling URL to peer forwarding", async () => {
  const rooms = createInterviewRoomService({
    rooms: createMemoryInterviewRoomRepository(),
    createId: () => "room-1",
    createJoinCode: () => "JOIN1234",
    now: () => new Date("2026-05-29T08:00:00.000Z"),
  });
  const signaling = createInterviewSignalingServer({ rooms });
  const api = createApiHandler({
    interview: createInterviewApiHandler({
      rooms,
      createRequestId: () => "req-room",
      onRoomEnded: signaling.notifyRoomEnded,
    }),
    cloud: async () => new Response("cloud fallback", { status: 404 }),
  });
  const upgrade = createInterviewWebSocketUpgradeHandler({
    signaling,
    createConnectionId: createSequence(["candidate-1", "interviewer-1"]),
  });
  const server = createServer((request, response) => {
    void handleRequest(api, request, response);
  });
  server.on("upgrade", (request, socket, head) => {
    if (upgrade.canHandle(request)) {
      upgrade.handleUpgrade(request, socket, head);
      return;
    }
    socket.destroy();
  });

  await listen(server);
  const baseUrl = `http://127.0.0.1:${addressPort(server)}`;
  try {
    const createResponse = await fetch(`${baseUrl}/api/interviews/rooms`, {
      method: "POST",
    });
    const created = (await createResponse.json()) as {
      roomId: string;
      joinCode: string;
      signalingUrl: string;
    };
    const candidate = await openConnectedSocket(
      wsUrl(baseUrl, created.signalingUrl),
    );
    const interviewer = await openConnectedSocket(
      wsUrl(baseUrl, created.signalingUrl),
    );
    try {
      candidate.socket.send(
        signalingMessage({
          kind: "join",
          roomId: created.roomId,
          joinCode: created.joinCode,
          role: "candidate",
          connectionId: candidate.connected.connectionId,
        }),
      );
      interviewer.socket.send(
        signalingMessage({
          kind: "join",
          roomId: created.roomId,
          joinCode: created.joinCode,
          role: "interviewer",
          connectionId: interviewer.connected.connectionId,
        }),
      );
      await nextJson(candidate.socket, "joined");
      await nextJson(interviewer.socket, "joined");

      candidate.socket.send(
        signalingMessage({
          kind: "offer",
          roomId: created.roomId,
          role: "candidate",
          connectionId: candidate.connected.connectionId,
          sdp: "v=0",
        }),
      );

      const forwarded = await nextJson(interviewer.socket, "offer");
      assert.equal(forwarded.sdp, "v=0");
      assert.equal(forwarded.connectionId, candidate.connected.connectionId);
    } finally {
      candidate.socket.close();
      interviewer.socket.close();
    }
  } finally {
    await closeServer(server);
    upgrade.close();
  }
});

test("websocket upgrade handler rejects messages for a different room than the URL", async () => {
  const rooms = createInterviewRoomService({
    rooms: createMemoryInterviewRoomRepository(),
    createId: createSequence(["room-a", "room-b"]),
    createJoinCode: createSequence(["JOINAAAA", "JOINBBBB"]),
    now: () => new Date("2026-05-29T08:00:00.000Z"),
  });
  const roomA = rooms.createRoom();
  const roomB = rooms.createRoom();
  const signaling = createInterviewSignalingServer({ rooms });
  const upgrade = createInterviewWebSocketUpgradeHandler({
    signaling,
    createConnectionId: () => "candidate-1",
  });
  const server = createServer((_, response) => {
    response.writeHead(404);
    response.end();
  });
  server.on("upgrade", (request, socket, head) => {
    if (upgrade.canHandle(request)) {
      upgrade.handleUpgrade(request, socket, head);
      return;
    }
    socket.destroy();
  });

  await listen(server);
  const baseUrl = `http://127.0.0.1:${addressPort(server)}`;
  try {
    const candidate = await openConnectedSocket(
      wsUrl(baseUrl, roomA.signalingUrl),
    );
    try {
      candidate.socket.send(
        signalingMessage({
          kind: "join",
          roomId: roomB.room.id,
          joinCode: roomB.room.joinCode,
          role: "candidate",
          connectionId: candidate.connected.connectionId,
        }),
      );

      const error = await nextJson(candidate.socket, "error");
      assert.equal(error.code, "room-mismatch");
      assert.equal(
        rooms.joinRoom({
          roomId: roomB.room.id,
          joinCode: roomB.room.joinCode,
          role: "candidate",
          connectionId: "candidate-2",
        }).ok,
        true,
      );
    } finally {
      candidate.socket.close();
    }
  } finally {
    await closeServer(server);
    upgrade.close();
  }
});

async function handleRequest(
  handler: (request: Request) => Promise<Response>,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host}`);
  const response = await handler(
    new Request(url, {
      method: incoming.method,
      headers: incoming.headers as HeadersInit,
    }),
  );
  outgoing.statusCode = response.status;
  response.headers.forEach((value, key) => outgoing.setHeader(key, value));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function addressPort(server: ReturnType<typeof createServer>): number {
  const address = server.address();
  assert.notEqual(typeof address, "string");
  assert.ok(address);
  return (address as AddressInfo).port;
}

function wsUrl(baseUrl: string, path: string): string {
  const url = new URL(path, baseUrl);
  url.protocol = "ws:";
  return url.toString();
}

async function openConnectedSocket(url: string): Promise<{
  socket: WebSocket;
  connected: Record<string, string>;
}> {
  const socket = new WebSocket(url);
  const connected = nextJson(socket, "connected");
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, connected: await connected };
}

function nextJson(
  socket: WebSocket,
  kind: string,
): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${kind}`));
    }, 1_000);
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as Record<string, string>;
      if (message.kind !== kind) return;
      cleanup();
      resolve(message);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

function signalingMessage(extra: Record<string, unknown>): string {
  return JSON.stringify({
    messageId: `msg-${Math.random()}`,
    sentAt: 1_780_000_000_000,
    ...extra,
  });
}

function createSequence(values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `connection-${index}`;
}
