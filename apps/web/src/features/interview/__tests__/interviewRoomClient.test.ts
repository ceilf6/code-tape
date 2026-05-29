import { describe, expect, it } from "vitest";
import { createInterviewRoomClient } from "../interviewRoomClient";

describe("InterviewRoomClient", () => {
  it("creates, reads, and ends interview rooms with typed responses", async () => {
    const requests: Request[] = [];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      requests.push(request);

      if (request.method === "POST" && request.url.endsWith("/api/interviews/rooms")) {
        return json(
          {
            roomId: "room-1",
            joinCode: "JOIN1234",
            status: "waiting",
            expiresAt: "2026-05-29T10:00:00.000Z",
            signalingUrl: "/api/interviews/rooms/room-1/signaling",
          },
          201,
        );
      }
      if (
        request.method === "GET" &&
        request.url ===
          "https://app.example/api/interviews/rooms/room%2F1?joinCode=JOIN%201234"
      ) {
        return json({
          roomId: "room/1",
          status: "live",
          expiresAt: "2026-05-29T10:00:00.000Z",
          candidateConnected: true,
          interviewerConnected: true,
        });
      }
      if (
        request.method === "POST" &&
        request.url === "https://app.example/api/interviews/rooms/room%2F1/end"
      ) {
        expect(await request.json()).toEqual({
          joinCode: "JOIN 1234",
          connectionId: "candidate-1",
        });
        return json({
          roomId: "room/1",
          status: "ended",
          expiresAt: "2026-05-29T10:00:00.000Z",
        });
      }
      return json({ error: { code: "not-found", message: "unexpected request" } }, 404);
    };
    const client = createInterviewRoomClient({ baseUrl: "https://app.example/app", fetch });

    await expect(client.createRoom()).resolves.toEqual({
      ok: true,
      value: {
        roomId: "room-1",
        joinCode: "JOIN1234",
        status: "waiting",
        expiresAt: "2026-05-29T10:00:00.000Z",
        signalingUrl: "/api/interviews/rooms/room-1/signaling",
      },
    });
    await expect(client.getRoom("room/1", "JOIN 1234")).resolves.toEqual({
      ok: true,
      value: {
        roomId: "room/1",
        status: "live",
        expiresAt: "2026-05-29T10:00:00.000Z",
        candidateConnected: true,
        interviewerConnected: true,
      },
    });
    await expect(
      client.endRoom("room/1", { joinCode: "JOIN 1234", connectionId: "candidate-1" }),
    ).resolves.toEqual({
      ok: true,
      value: {
        roomId: "room/1",
        status: "ended",
        expiresAt: "2026-05-29T10:00:00.000Z",
      },
    });
    expect(requests.map((request) => request.method)).toEqual(["POST", "GET", "POST"]);
  });

  it("normalizes backend errors, malformed success JSON, and thrown fetches", async () => {
    const backendErrorClient = createInterviewRoomClient({
      baseUrl: "https://app.example",
      fetch: async () =>
        json(
          {
            error: {
              code: "invalid-join-code",
              message: "join code is invalid",
              requestId: "req-1",
            },
          },
          403,
        ),
    });
    const malformedClient = createInterviewRoomClient({
      baseUrl: "https://app.example",
      fetch: async () => new Response("{", { status: 200 }),
    });
    const thrownClient = createInterviewRoomClient({
      baseUrl: "https://app.example",
      fetch: async () => {
        throw new Error("offline");
      },
    });

    await expect(backendErrorClient.getRoom("room-1", "bad-code")).resolves.toEqual({
      ok: false,
      error: {
        code: "invalid-join-code",
        message: "join code is invalid",
        requestId: "req-1",
        status: 403,
      },
    });
    await expect(malformedClient.createRoom()).resolves.toEqual({
      ok: false,
      error: {
        code: "bad-response",
        message: "interview room response must be valid JSON",
        status: 200,
      },
    });
    await expect(thrownClient.createRoom()).resolves.toEqual({
      ok: false,
      error: {
        code: "network-error",
        message: "offline",
      },
    });
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
