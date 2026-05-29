import type {
  InterviewRole,
  InterviewRoom,
  InterviewRoomError,
  InterviewRoomRepository,
  InterviewRoomResult,
} from "./types.js";

const DEFAULT_ROOM_TTL_MS = 2 * 60 * 60 * 1000;

export type CreateInterviewRoomServiceDeps = {
  rooms: InterviewRoomRepository;
  createId?: () => string;
  createJoinCode?: () => string;
  now?: () => Date;
  roomTtlMs?: number;
};

export type CreateInterviewRoomResult = {
  room: InterviewRoom;
  signalingUrl: string;
};

export type JoinInterviewRoomInput = {
  roomId: string;
  joinCode: string;
  role: InterviewRole;
  connectionId: string;
};

export type EndInterviewRoomInput = {
  roomId: string;
  joinCode: string;
  connectionId: string;
};

export type LeaveInterviewRoomInput = {
  roomId: string;
  connectionId: string;
};

export type InterviewRoomService = {
  createRoom(): CreateInterviewRoomResult;
  getRoom(roomId: string): InterviewRoomResult<InterviewRoom>;
  joinRoom(input: JoinInterviewRoomInput): InterviewRoomResult<InterviewRoom>;
  leaveRoom(input: LeaveInterviewRoomInput): InterviewRoomResult<InterviewRoom>;
  endRoom(input: EndInterviewRoomInput): InterviewRoomResult<InterviewRoom>;
};

export function createInterviewRoomService(
  deps: CreateInterviewRoomServiceDeps,
): InterviewRoomService {
  const createId = deps.createId ?? (() => crypto.randomUUID());
  const createJoinCode = deps.createJoinCode ?? createRandomJoinCode;
  const now = deps.now ?? (() => new Date());
  const roomTtlMs = deps.roomTtlMs ?? DEFAULT_ROOM_TTL_MS;

  return {
    createRoom() {
      const createdAt = now();
      const room: InterviewRoom = {
        id: createId(),
        joinCode: createJoinCode(),
        status: "waiting",
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + roomTtlMs).toISOString(),
        candidateConnectionId: null,
        interviewerConnectionId: null,
      };
      deps.rooms.save(room);
      return {
        room,
        signalingUrl: `/api/interviews/rooms/${encodeURIComponent(room.id)}/signaling`,
      };
    },

    getRoom(roomId) {
      const room = deps.rooms.get(roomId);
      if (!room) {
        return failure("not-found", "interview room not found");
      }
      if (isExpired(room, now())) {
        const expired = { ...room, status: "expired" as const };
        deps.rooms.save(expired);
        return failure("room-expired", "interview room has expired");
      }
      return { ok: true, room };
    },

    joinRoom(input) {
      const loaded = loadJoinableRoom(
        deps.rooms,
        input.roomId,
        input.joinCode,
        now(),
      );
      if (!loaded.ok) return loaded;

      const room = loaded.room;
      const connectionKey = connectionKeyForRole(input.role);
      const existingConnectionId = room[connectionKey];
      if (existingConnectionId && existingConnectionId !== input.connectionId) {
        return failure(
          "role-already-connected",
          `${input.role} is already connected`,
        );
      }

      const next: InterviewRoom = {
        ...room,
        [connectionKey]: input.connectionId,
      };
      next.status =
        next.candidateConnectionId && next.interviewerConnectionId
          ? "live"
          : "connecting";
      deps.rooms.save(next);
      return { ok: true, room: next };
    },

    leaveRoom(input) {
      const room = deps.rooms.get(input.roomId);
      if (!room) {
        return failure("not-found", "interview room not found");
      }
      if (room.status === "ended") {
        return { ok: true, room };
      }
      if (room.status === "expired" || isExpired(room, now())) {
        const expired = { ...room, status: "expired" as const };
        deps.rooms.save(expired);
        return failure("room-expired", "interview room has expired");
      }

      let next: InterviewRoom | null = null;
      if (room.candidateConnectionId === input.connectionId) {
        next = { ...room, candidateConnectionId: null };
      } else if (room.interviewerConnectionId === input.connectionId) {
        next = { ...room, interviewerConnectionId: null };
      }
      if (!next) {
        return failure(
          "forbidden",
          "connection is not joined to this interview room",
        );
      }
      next.status = statusForConnections(next);
      deps.rooms.save(next);
      return { ok: true, room: next };
    },

    endRoom(input) {
      const loaded = loadJoinableRoom(
        deps.rooms,
        input.roomId,
        input.joinCode,
        now(),
      );
      if (!loaded.ok) return loaded;

      const room = loaded.room;
      if (room.candidateConnectionId !== input.connectionId) {
        return failure(
          "forbidden",
          "only the connected candidate can end the interview room",
        );
      }
      const ended: InterviewRoom = { ...room, status: "ended" };
      deps.rooms.save(ended);
      return { ok: true, room: ended };
    },
  };
}

function loadJoinableRoom(
  rooms: InterviewRoomRepository,
  roomId: string,
  joinCode: string,
  now: Date,
): InterviewRoomResult<InterviewRoom> {
  const room = rooms.get(roomId);
  if (!room) {
    return failure("not-found", "interview room not found");
  }
  if (room.joinCode !== joinCode) {
    return failure("invalid-join-code", "join code is invalid");
  }
  if (room.status === "ended") {
    return failure("room-ended", "interview room has ended");
  }
  if (room.status === "expired" || isExpired(room, now)) {
    const expired = { ...room, status: "expired" as const };
    rooms.save(expired);
    return failure("room-expired", "interview room has expired");
  }
  return { ok: true, room };
}

function connectionKeyForRole(
  role: InterviewRole,
): "candidateConnectionId" | "interviewerConnectionId" {
  return role === "candidate"
    ? "candidateConnectionId"
    : "interviewerConnectionId";
}

function isExpired(room: InterviewRoom, now: Date): boolean {
  return Date.parse(room.expiresAt) <= now.getTime();
}

function statusForConnections(
  room: InterviewRoom,
): "waiting" | "connecting" | "live" {
  if (room.candidateConnectionId && room.interviewerConnectionId) {
    return "live";
  }
  if (room.candidateConnectionId || room.interviewerConnectionId) {
    return "connecting";
  }
  return "waiting";
}

function createRandomJoinCode(): string {
  return crypto.randomUUID().replace(/-/gu, "").slice(0, 8).toUpperCase();
}

function failure(
  code: InterviewRoomError["code"],
  message: string,
): { ok: false; error: InterviewRoomError } {
  return { ok: false, error: { code, message } };
}
