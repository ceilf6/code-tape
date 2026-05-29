import assert from "node:assert/strict";
import test from "node:test";
import { createInterviewRoomService } from "../../interview/interviewRoomService.js";
import { createMemoryInterviewRoomRepository } from "../../interview/memoryInterviewRoomRepository.js";
import { createInterviewSignalingServer } from "../../signaling/interviewSignalingServer.js";
import { createApiHandler } from "../createApiHandler.js";
import { createInterviewApiHandler } from "../interviewApiHandler.js";

test("POST /api/interviews/rooms creates an interview room", async () => {
  const handler = createInterviewApiHandler({
    rooms: createInterviewRoomService({
      rooms: createMemoryInterviewRoomRepository(),
      createId: () => "room-1",
      createJoinCode: () => "JOIN1234",
      now: () => new Date("2026-05-29T08:00:00.000Z"),
    }),
    createRequestId: () => "req-room-create",
  });

  const response = await handler(
    new Request("http://localhost/api/interviews/rooms", { method: "POST" }),
  );
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-request-id"), "req-room-create");
  assert.deepEqual(body, {
    roomId: "room-1",
    joinCode: "JOIN1234",
    status: "waiting",
    expiresAt: "2026-05-29T10:00:00.000Z",
    signalingUrl: "/api/interviews/rooms/room-1/signaling",
  });
});

test("GET /api/interviews/rooms/:roomId returns room status when join code matches", async () => {
  const rooms = createInterviewRoomService({
    rooms: createMemoryInterviewRoomRepository(),
    createId: () => "room-1",
    createJoinCode: () => "JOIN1234",
    now: () => new Date("2026-05-29T08:00:00.000Z"),
  });
  rooms.createRoom();
  const handler = createInterviewApiHandler({
    rooms,
    createRequestId: () => "req-room-get",
  });

  const response = await handler(
    new Request(
      "http://localhost/api/interviews/rooms/room-1?joinCode=JOIN1234",
      { method: "GET" },
    ),
  );
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.status, "waiting");
  assert.equal(body.expiresAt, "2026-05-29T10:00:00.000Z");
});

test("POST /api/interviews/rooms/:roomId/end ends a room only for the connected candidate", async () => {
  const rooms = createInterviewRoomService({
    rooms: createMemoryInterviewRoomRepository(),
    createId: () => "room-1",
    createJoinCode: () => "JOIN1234",
    now: () => new Date("2026-05-29T08:00:00.000Z"),
  });
  rooms.createRoom();
  rooms.joinRoom({
    roomId: "room-1",
    joinCode: "JOIN1234",
    role: "candidate",
    connectionId: "candidate-1",
  });
  const handler = createInterviewApiHandler({
    rooms,
    createRequestId: () => "req-room-end",
  });

  const response = await handler(
    new Request("http://localhost/api/interviews/rooms/room-1/end", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        joinCode: "JOIN1234",
        connectionId: "candidate-1",
      }),
    }),
  );
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.status, "ended");
});

test("POST /api/interviews/rooms/:roomId/end notifies connected signaling peers", async () => {
  const rooms = createInterviewRoomService({
    rooms: createMemoryInterviewRoomRepository(),
    createId: () => "room-1",
    createJoinCode: () => "JOIN1234",
    now: () => new Date("2026-05-29T08:00:00.000Z"),
  });
  rooms.createRoom();
  const signaling = createInterviewSignalingServer({ rooms });
  const candidate = createFakeConnection("candidate-1");
  const interviewer = createFakeConnection("interviewer-1");
  signaling.receive(
    candidate,
    makeMessage({
      kind: "join",
      role: "candidate",
      connectionId: candidate.id,
    }),
  );
  signaling.receive(
    interviewer,
    makeMessage({
      kind: "join",
      role: "interviewer",
      connectionId: interviewer.id,
    }),
  );
  const handler = createInterviewApiHandler({
    rooms,
    createRequestId: () => "req-room-end",
    onRoomEnded: signaling.notifyRoomEnded,
  });

  const response = await handler(
    new Request("http://localhost/api/interviews/rooms/room-1/end", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        joinCode: "JOIN1234",
        connectionId: "candidate-1",
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(interviewer.messages.at(-1), {
    kind: "ended",
    roomId: "room-1",
  });
});

test("createApiHandler routes interview requests before cloud fallback", async () => {
  const rooms = createInterviewRoomService({
    rooms: createMemoryInterviewRoomRepository(),
    createId: () => "room-1",
    createJoinCode: () => "JOIN1234",
    now: () => new Date("2026-05-29T08:00:00.000Z"),
  });
  const interview = createInterviewApiHandler({
    rooms,
    createRequestId: () => "req-route",
  });
  const handler = createApiHandler({
    interview,
    cloud: async () => new Response("cloud fallback", { status: 599 }),
  });

  const response = await handler(
    new Request("http://localhost/api/interviews/rooms", { method: "POST" }),
  );

  assert.equal(response.status, 201);
});

type FakeConnection = {
  id: string;
  messages: Array<Record<string, unknown>>;
  send(raw: string): void;
};

function createFakeConnection(id: string): FakeConnection {
  return {
    id,
    messages: [],
    send(raw) {
      this.messages.push(JSON.parse(raw) as Record<string, unknown>);
    },
  };
}

function makeMessage(extra: Record<string, unknown>): string {
  return JSON.stringify({
    roomId: "room-1",
    joinCode: "JOIN1234",
    messageId: "msg-1",
    sentAt: 1_780_000_000_000,
    ...extra,
  });
}
