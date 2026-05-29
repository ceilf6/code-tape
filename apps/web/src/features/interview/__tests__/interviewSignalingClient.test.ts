import { describe, expect, it } from "vitest";
import {
  buildInterviewSignalingWebSocketUrl,
  createInterviewSignalingClient,
  type InterviewSignalingSocket,
} from "../interviewSignalingClient";

describe("InterviewSignalingClient", () => {
  it("builds websocket URLs from relative and absolute signaling URLs", () => {
    expect(
      buildInterviewSignalingWebSocketUrl(
        "/api/interviews/rooms/room-1/signaling",
        "https://app.example/interview",
      ),
    ).toBe("wss://app.example/api/interviews/rooms/room-1/signaling");
    expect(
      buildInterviewSignalingWebSocketUrl(
        "http://localhost:3000/api/interviews/rooms/room-1/signaling",
        "http://app.example/interview",
      ),
    ).toBe("ws://localhost:3000/api/interviews/rooms/room-1/signaling");
    expect(
      buildInterviewSignalingWebSocketUrl(
        "wss://signal.example/api/interviews/rooms/room-1/signaling",
        "https://app.example/interview",
      ),
    ).toBe("wss://signal.example/api/interviews/rooms/room-1/signaling");
  });

  it("sends signaling messages with the required interview envelope", () => {
    const sockets: FakeWebSocket[] = [];
    const client = createInterviewSignalingClient({
      signalingUrl: "/api/interviews/rooms/room-1/signaling",
      baseUrl: "https://app.example/interview",
      roomId: "room-1",
      role: "candidate",
      joinCode: "JOIN1234",
      WebSocket: createFakeWebSocketConstructor(sockets),
      now: () => 1_780_000_000_000,
      createMessageId: createSequence(["msg-join", "msg-offer", "msg-answer", "msg-ice", "msg-heartbeat", "msg-leave"]),
    });

    expect(sockets[0]?.url).toBe("wss://app.example/api/interviews/rooms/room-1/signaling");
    expect(client.sendJoin()).toEqual({ ok: false, reason: "connection-not-ready" });
    sockets[0]?.emitMessage({
      kind: "connected",
      roomId: "room-1",
      connectionId: "server-connection-1",
    });
    expect(client.getConnectionId()).toBe("server-connection-1");
    expect(client.sendJoin()).toMatchObject({ ok: true });
    expect(client.sendOffer("offer-sdp")).toMatchObject({ ok: true });
    expect(client.sendAnswer("answer-sdp")).toMatchObject({ ok: true });
    expect(
      client.sendIceCandidate({
        candidate: "candidate:1",
        sdpMid: "0",
        sdpMLineIndex: 0,
      }),
    ).toMatchObject({ ok: true });
    expect(client.sendHeartbeat()).toMatchObject({ ok: true });
    expect(client.sendLeave()).toMatchObject({ ok: true });

    expect(sockets[0]?.sent.map((raw) => JSON.parse(raw))).toEqual([
      {
        kind: "join",
        roomId: "room-1",
        role: "candidate",
        connectionId: "server-connection-1",
        joinCode: "JOIN1234",
        messageId: "msg-join",
        sentAt: 1_780_000_000_000,
      },
      {
        kind: "offer",
        roomId: "room-1",
        role: "candidate",
        connectionId: "server-connection-1",
        sdp: "offer-sdp",
        messageId: "msg-offer",
        sentAt: 1_780_000_000_000,
      },
      {
        kind: "answer",
        roomId: "room-1",
        role: "candidate",
        connectionId: "server-connection-1",
        sdp: "answer-sdp",
        messageId: "msg-answer",
        sentAt: 1_780_000_000_000,
      },
      {
        kind: "ice-candidate",
        roomId: "room-1",
        role: "candidate",
        connectionId: "server-connection-1",
        candidate: "candidate:1",
        sdpMid: "0",
        sdpMLineIndex: 0,
        messageId: "msg-ice",
        sentAt: 1_780_000_000_000,
      },
      {
        kind: "heartbeat",
        roomId: "room-1",
        role: "candidate",
        connectionId: "server-connection-1",
        messageId: "msg-heartbeat",
        sentAt: 1_780_000_000_000,
      },
      {
        kind: "leave",
        roomId: "room-1",
        role: "candidate",
        connectionId: "server-connection-1",
        messageId: "msg-leave",
        sentAt: 1_780_000_000_000,
      },
    ]);
  });

  it("dispatches valid inbound messages and reports malformed payloads", () => {
    const sockets: FakeWebSocket[] = [];
    const messages: unknown[] = [];
    const errors: unknown[] = [];
    createInterviewSignalingClient({
      signalingUrl: "/api/interviews/rooms/room-1/signaling",
      baseUrl: "https://app.example/interview",
      roomId: "room-1",
      role: "interviewer",
      joinCode: "JOIN1234",
      WebSocket: createFakeWebSocketConstructor(sockets),
      onMessage: (message) => messages.push(message),
      onError: (error) => errors.push(error),
    });

    sockets[0]?.emitMessage({
      kind: "connected",
      roomId: "room-1",
      connectionId: "server-connection-2",
    });
    sockets[0]?.emitMessage({
      kind: "joined",
      roomId: "room-1",
      role: "interviewer",
      status: "live",
    });
    sockets[0]?.emitMessage({
      kind: "offer",
      roomId: "room-1",
      role: "candidate",
      connectionId: "candidate-1",
      messageId: "msg-offer",
      sentAt: 1_780_000_000_000,
      sdp: "offer-sdp",
    });
    sockets[0]?.emitRaw("{");
    sockets[0]?.emitMessage({ kind: "chat", text: "unsupported" });

    expect(messages).toEqual([
      {
        kind: "connected",
        roomId: "room-1",
        connectionId: "server-connection-2",
      },
      {
        kind: "joined",
        roomId: "room-1",
        role: "interviewer",
        status: "live",
      },
      {
        kind: "offer",
        roomId: "room-1",
        role: "candidate",
        connectionId: "candidate-1",
        messageId: "msg-offer",
        sentAt: 1_780_000_000_000,
        sdp: "offer-sdp",
      },
    ]);
    expect(errors).toEqual([
      {
        code: "bad-json",
        message: "signaling message must be valid JSON",
      },
      {
        code: "unknown-message-kind",
        message: "signaling message kind is not supported",
      },
    ]);
  });

  it("returns explicit failures when the socket is not open or send throws", () => {
    const sockets: FakeWebSocket[] = [];
    const client = createInterviewSignalingClient({
      signalingUrl: "/api/interviews/rooms/room-1/signaling",
      baseUrl: "https://app.example/interview",
      roomId: "room-1",
      role: "candidate",
      joinCode: "JOIN1234",
      WebSocket: createFakeWebSocketConstructor(sockets),
    });
    expect(client.sendHeartbeat()).toEqual({ ok: false, reason: "connection-not-ready" });

    sockets[0]?.emitMessage({
      kind: "connected",
      roomId: "room-1",
      connectionId: "server-connection-1",
    });
    sockets[0]!.readyState = FakeWebSocket.CLOSED;

    expect(client.sendHeartbeat()).toEqual({ ok: false, reason: "socket-not-open" });

    sockets[0]!.readyState = FakeWebSocket.OPEN;
    sockets[0]!.throwOnSend = true;

    expect(client.sendHeartbeat()).toEqual({ ok: false, reason: "send-failed" });
  });
});

class FakeWebSocket implements InterviewSignalingSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readyState = FakeWebSocket.OPEN;
  readonly sent: string[] = [];
  throwOnSend = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    if (this.throwOnSend) {
      throw new Error("send failed");
    }
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  emitMessage(message: unknown): void {
    this.emitRaw(JSON.stringify(message));
  }

  emitRaw(data: string): void {
    this.onmessage?.({ data } as MessageEvent<string>);
  }
}

function createFakeWebSocketConstructor(instances: FakeWebSocket[]) {
  return class extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      instances.push(this);
    }
  };
}

function createSequence(values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `msg-${index}`;
}
