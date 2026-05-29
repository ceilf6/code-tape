import assert from "node:assert/strict";
import test from "node:test";
import { createInterviewRoomService } from "../interviewRoomService.js";
import { createMemoryInterviewRoomRepository } from "../memoryInterviewRoomRepository.js";

test("createRoom returns a waiting room with an opaque join code", () => {
  const service = createInterviewRoomService({
    rooms: createMemoryInterviewRoomRepository(),
    createId: () => "room-1",
    createJoinCode: () => "JOIN1234",
    now: () => new Date("2026-05-29T08:00:00.000Z"),
  });

  const result = service.createRoom();

  assert.equal(result.room.id, "room-1");
  assert.equal(result.room.joinCode, "JOIN1234");
  assert.equal(result.room.status, "waiting");
  assert.equal(result.signalingUrl, "/api/interviews/rooms/room-1/signaling");
  assert.equal(result.room.expiresAt, "2026-05-29T10:00:00.000Z");
});

test("joinRoom validates join code, role uniqueness, expiration, and ended rooms", () => {
  const now = new Date("2026-05-29T08:00:00.000Z");
  const service = createInterviewRoomService({
    rooms: createMemoryInterviewRoomRepository(),
    createId: () => "room-1",
    createJoinCode: () => "JOIN1234",
    now: () => now,
  });
  const { room } = service.createRoom();

  assert.equal(
    service.joinRoom({
      roomId: room.id,
      joinCode: "WRONG123",
      role: "candidate",
      connectionId: "candidate-1",
    }).ok,
    false,
  );

  const candidateJoin = service.joinRoom({
    roomId: room.id,
    joinCode: "JOIN1234",
    role: "candidate",
    connectionId: "candidate-1",
  });
  assert.equal(candidateJoin.ok, true);

  const duplicateCandidate = service.joinRoom({
    roomId: room.id,
    joinCode: "JOIN1234",
    role: "candidate",
    connectionId: "candidate-2",
  });
  assert.equal(duplicateCandidate.ok, false);
  assert.equal(
    duplicateCandidate.ok ? "" : duplicateCandidate.error.code,
    "role-already-connected",
  );

  const interviewerJoin = service.joinRoom({
    roomId: room.id,
    joinCode: "JOIN1234",
    role: "interviewer",
    connectionId: "interviewer-1",
  });
  assert.equal(interviewerJoin.ok, true);
  assert.equal(interviewerJoin.ok ? interviewerJoin.room.status : "", "live");

  const ended = service.endRoom({
    roomId: room.id,
    joinCode: "JOIN1234",
    connectionId: "candidate-1",
  });
  assert.equal(ended.ok, true);
  assert.equal(ended.ok ? ended.room.status : "", "ended");

  const afterEnd = service.joinRoom({
    roomId: room.id,
    joinCode: "JOIN1234",
    role: "interviewer",
    connectionId: "interviewer-2",
  });
  assert.equal(afterEnd.ok, false);
  assert.equal(afterEnd.ok ? "" : afterEnd.error.code, "room-ended");
});

test("expired rooms reject joins and persist expired status", () => {
  let currentTime = new Date("2026-05-29T08:00:00.000Z");
  const service = createInterviewRoomService({
    rooms: createMemoryInterviewRoomRepository(),
    createId: () => "room-1",
    createJoinCode: () => "JOIN1234",
    now: () => currentTime,
    roomTtlMs: 1_000,
  });
  const { room } = service.createRoom();

  currentTime = new Date("2026-05-29T08:00:01.000Z");

  const expiredJoin = service.joinRoom({
    roomId: room.id,
    joinCode: "JOIN1234",
    role: "candidate",
    connectionId: "candidate-1",
  });
  const expiredGet = service.getRoom(room.id);

  assert.equal(expiredJoin.ok, false);
  assert.equal(expiredJoin.ok ? "" : expiredJoin.error.code, "room-expired");
  assert.equal(expiredGet.ok, false);
  assert.equal(expiredGet.ok ? "" : expiredGet.error.code, "room-expired");
});

test("leaveRoom clears the role connection so an explicit disconnect can rejoin", () => {
  const service = createInterviewRoomService({
    rooms: createMemoryInterviewRoomRepository(),
    createId: () => "room-1",
    createJoinCode: () => "JOIN1234",
    now: () => new Date("2026-05-29T08:00:00.000Z"),
  });
  service.createRoom();
  service.joinRoom({
    roomId: "room-1",
    joinCode: "JOIN1234",
    role: "candidate",
    connectionId: "candidate-1",
  });

  const left = service.leaveRoom({
    roomId: "room-1",
    connectionId: "candidate-1",
  });
  const rejoined = service.joinRoom({
    roomId: "room-1",
    joinCode: "JOIN1234",
    role: "candidate",
    connectionId: "candidate-2",
  });

  assert.equal(left.ok, true);
  assert.equal(
    left.ok ? left.room.candidateConnectionId : "still-connected",
    null,
  );
  assert.equal(rejoined.ok, true);
});
