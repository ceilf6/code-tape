import type { InterviewRoomErrorCode } from "../interview/types.js";
import type { InterviewRoomService } from "../interview/interviewRoomService.js";
import type { CloudApiHandler } from "./cloudApiHandler.js";

type InterviewApiError = {
  code: string;
  message: string;
};

export function createInterviewApiHandler(deps: {
  rooms: InterviewRoomService;
  createRequestId?: () => string;
  onRoomEnded?: (roomId: string) => void;
}): CloudApiHandler {
  const createRequestId = deps.createRequestId ?? (() => crypto.randomUUID());

  return async (request): Promise<Response> => {
    const requestId = createRequestId();
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/interviews/rooms") {
      const created = deps.rooms.createRoom();
      return jsonResponse(
        {
          roomId: created.room.id,
          joinCode: created.room.joinCode,
          status: created.room.status,
          expiresAt: created.room.expiresAt,
          signalingUrl: created.signalingUrl,
        },
        201,
        requestId,
      );
    }

    const roomMatch = url.pathname.match(
      /^\/api\/interviews\/rooms\/([^/]+)$/u,
    );
    if (request.method === "GET" && roomMatch) {
      const roomId = decodePathSegment(roomMatch[1]!);
      if (!roomId.ok)
        return jsonError(
          { code: "bad-request", message: "invalid room id" },
          400,
          requestId,
        );
      const joinCode = url.searchParams.get("joinCode")?.trim();
      if (!joinCode)
        return jsonError(
          { code: "bad-request", message: "missing joinCode" },
          400,
          requestId,
        );
      const result = deps.rooms.getRoom(roomId.value);
      if (!result.ok) {
        return jsonError(
          result.error,
          statusForRoomError(result.error.code),
          requestId,
        );
      }
      if (result.room.joinCode !== joinCode) {
        return jsonError(
          { code: "invalid-join-code", message: "join code is invalid" },
          403,
          requestId,
        );
      }
      return jsonResponse(
        {
          roomId: result.room.id,
          status: result.room.status,
          expiresAt: result.room.expiresAt,
          candidateConnected: Boolean(result.room.candidateConnectionId),
          interviewerConnected: Boolean(result.room.interviewerConnectionId),
        },
        200,
        requestId,
      );
    }

    const endMatch = url.pathname.match(
      /^\/api\/interviews\/rooms\/([^/]+)\/end$/u,
    );
    if (request.method === "POST" && endMatch) {
      const roomId = decodePathSegment(endMatch[1]!);
      if (!roomId.ok)
        return jsonError(
          { code: "bad-request", message: "invalid room id" },
          400,
          requestId,
        );
      const parsed = await readJsonObject(request);
      if (!parsed.ok)
        return jsonError(
          {
            code: "bad-request",
            message: "request body must be a valid JSON object",
          },
          400,
          requestId,
        );
      if (
        !isNonEmptyString(parsed.value.joinCode) ||
        !isNonEmptyString(parsed.value.connectionId)
      ) {
        return jsonError(
          {
            code: "bad-request",
            message: "joinCode and connectionId are required",
          },
          400,
          requestId,
        );
      }
      const result = deps.rooms.endRoom({
        roomId: roomId.value,
        joinCode: parsed.value.joinCode,
        connectionId: parsed.value.connectionId,
      });
      if (!result.ok) {
        return jsonError(
          result.error,
          statusForRoomError(result.error.code),
          requestId,
        );
      }
      deps.onRoomEnded?.(result.room.id);
      return jsonResponse(
        {
          roomId: result.room.id,
          status: result.room.status,
          expiresAt: result.room.expiresAt,
        },
        200,
        requestId,
      );
    }

    return jsonError(
      { code: "not-found", message: "route not found" },
      404,
      requestId,
    );
  };
}

function statusForRoomError(code: InterviewRoomErrorCode): number {
  switch (code) {
    case "not-found":
      return 404;
    case "role-already-connected":
      return 409;
    case "room-ended":
    case "room-expired":
      return 410;
    case "forbidden":
    case "invalid-join-code":
      return 403;
  }
}

async function readJsonObject(
  request: Request,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  try {
    const value = (await request.json()) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return { ok: true, value: value as Record<string, unknown> };
    }
  } catch {
    return { ok: false };
  }
  return { ok: false };
}

function decodePathSegment(
  segment: string,
): { ok: true; value: string } | { ok: false } {
  try {
    return { ok: true, value: decodeURIComponent(segment) };
  } catch {
    return { ok: false };
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
    },
  });
}

function jsonError(
  error: InterviewApiError,
  status: number,
  requestId: string,
): Response {
  return jsonResponse({ error: { ...error, requestId } }, status, requestId);
}
