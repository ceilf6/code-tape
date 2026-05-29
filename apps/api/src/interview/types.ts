export type InterviewRole = "candidate" | "interviewer";

export type InterviewRoomStatus =
  | "waiting"
  | "connecting"
  | "live"
  | "ended"
  | "expired";

export type InterviewRoom = {
  id: string;
  joinCode: string;
  status: InterviewRoomStatus;
  createdAt: string;
  expiresAt: string;
  candidateConnectionId: string | null;
  interviewerConnectionId: string | null;
};

export type InterviewRoomErrorCode =
  | "not-found"
  | "invalid-join-code"
  | "role-already-connected"
  | "room-ended"
  | "room-expired"
  | "forbidden";

export type InterviewRoomError = {
  code: InterviewRoomErrorCode;
  message: string;
};

export type InterviewRoomResult<T> =
  | { ok: true; room: T }
  | { ok: false; error: InterviewRoomError };

export type InterviewRoomRepository = {
  get(roomId: string): InterviewRoom | null;
  save(room: InterviewRoom): void;
};
