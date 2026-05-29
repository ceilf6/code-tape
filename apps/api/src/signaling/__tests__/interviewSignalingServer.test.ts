import assert from "node:assert/strict";
import test from "node:test";
import { createInterviewRoomService } from "../../interview/interviewRoomService.js";
import { createMemoryInterviewRoomRepository } from "../../interview/memoryInterviewRoomRepository.js";
import { createInterviewSignalingServer } from "../interviewSignalingServer.js";

test("signaling server forwards SDP and ICE messages only to the peer role in the same room", () => {
  const rooms = createInterviewRoomService({
    rooms: createMemoryInterviewRoomRepository(),
    createId: () => "room-1",
    createJoinCode: () => "JOIN1234",
    now: () => new Date("2026-05-29T08:00:00.000Z"),
  });
  rooms.createRoom();
  const server = createInterviewSignalingServer({ rooms });
  const candidate = createFakeConnection("candidate-1");
  const interviewer = createFakeConnection("interviewer-1");

  server.receive(
    candidate,
    makeMessage({
      kind: "join",
      role: "candidate",
      connectionId: candidate.id,
    }),
  );
  server.receive(
    interviewer,
    makeMessage({
      kind: "join",
      role: "interviewer",
      connectionId: interviewer.id,
    }),
  );
  server.receive(
    candidate,
    makeMessage({
      kind: "offer",
      role: "candidate",
      connectionId: candidate.id,
      sdp: "v=0",
    }),
  );
  server.receive(
    interviewer,
    makeMessage({
      kind: "ice-candidate",
      role: "interviewer",
      connectionId: interviewer.id,
      candidate: "candidate:1 1 udp",
    }),
  );

  assert.equal(
    interviewer.messages.some((message) => message.kind === "offer"),
    true,
  );
  assert.equal(
    candidate.messages.some((message) => message.kind === "offer"),
    false,
  );
  assert.equal(
    candidate.messages.some((message) => message.kind === "ice-candidate"),
    true,
  );
  assert.equal(
    interviewer.messages.some((message) => message.kind === "ice-candidate"),
    false,
  );
});

test("signaling server rejects malformed messages without forwarding them", () => {
  const rooms = createInterviewRoomService({
    rooms: createMemoryInterviewRoomRepository(),
    createId: () => "room-1",
    createJoinCode: () => "JOIN1234",
    now: () => new Date("2026-05-29T08:00:00.000Z"),
  });
  rooms.createRoom();
  const server = createInterviewSignalingServer({ rooms });
  const candidate = createFakeConnection("candidate-1");
  const interviewer = createFakeConnection("interviewer-1");
  server.receive(
    interviewer,
    makeMessage({
      kind: "join",
      role: "interviewer",
      connectionId: interviewer.id,
    }),
  );

  server.receive(candidate, JSON.stringify({ kind: "chat", roomId: "room-1" }));

  assert.equal(candidate.messages.at(-1)?.kind, "error");
  assert.equal(
    interviewer.messages.some((message) => message.kind === "chat"),
    false,
  );
});

test("signaling server rejects duplicate join on the same connection without leaking the original room slot", () => {
  const rooms = createInterviewRoomService({
    rooms: createMemoryInterviewRoomRepository(),
    createId: createSequence(["room-1", "room-2"]),
    createJoinCode: createSequence(["JOIN1234", "JOIN5678"]),
    now: () => new Date("2026-05-29T08:00:00.000Z"),
  });
  rooms.createRoom();
  rooms.createRoom();
  const server = createInterviewSignalingServer({ rooms });
  const candidate = createFakeConnection("candidate-1");

  server.receive(
    candidate,
    makeMessage({
      kind: "join",
      role: "candidate",
      connectionId: candidate.id,
      roomId: "room-1",
      joinCode: "JOIN1234",
    }),
  );
  server.receive(
    candidate,
    makeMessage({
      kind: "join",
      role: "candidate",
      connectionId: candidate.id,
      roomId: "room-2",
      joinCode: "JOIN5678",
    }),
  );
  server.disconnect(candidate.id);

  assert.equal(candidate.messages.at(-1)?.kind, "error");
  assert.equal(candidate.messages.at(-1)?.code, "already-joined");
  const replacementJoin = rooms.joinRoom({
    roomId: "room-1",
    joinCode: "JOIN1234",
    role: "candidate",
    connectionId: "candidate-2",
  });
  assert.equal(replacementJoin.ok, true);
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
    messageId: `msg-${Math.random()}`,
    sentAt: 1_780_000_000_000,
    ...extra,
  });
}

function createSequence(values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `value-${index}`;
}
