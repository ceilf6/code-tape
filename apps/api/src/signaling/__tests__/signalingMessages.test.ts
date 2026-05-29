import assert from "node:assert/strict";
import test from "node:test";
import { parseSignalingMessage } from "../signalingMessages.js";

const BASE_MESSAGE = {
  roomId: "room-1",
  connectionId: "candidate-1",
  role: "candidate",
  messageId: "msg-1",
  sentAt: 1_780_000_000_000,
} as const;

test("parseSignalingMessage accepts offer answer ice heartbeat and leave messages", () => {
  const accepted = [
    { ...BASE_MESSAGE, kind: "join" },
    { ...BASE_MESSAGE, kind: "offer", sdp: "v=0" },
    { ...BASE_MESSAGE, kind: "answer", sdp: "v=0" },
    {
      ...BASE_MESSAGE,
      kind: "ice-candidate",
      candidate: "candidate:1 1 udp",
      sdpMid: "0",
      sdpMLineIndex: 0,
    },
    { ...BASE_MESSAGE, kind: "heartbeat" },
    { ...BASE_MESSAGE, kind: "leave" },
  ];

  for (const message of accepted) {
    const result = parseSignalingMessage(JSON.stringify(message));
    assert.equal(result.ok, true, JSON.stringify(message));
  }
});

test("parseSignalingMessage rejects unknown kinds, missing identity fields, and oversized messages", () => {
  const unknown = parseSignalingMessage(
    JSON.stringify({ ...BASE_MESSAGE, kind: "chat", text: "hi" }),
  );
  assert.equal(unknown.ok, false);
  assert.equal(unknown.ok ? "" : unknown.error.code, "unknown-message-kind");

  const missingIdentity = parseSignalingMessage(
    JSON.stringify({ ...BASE_MESSAGE, kind: "join", roomId: "" }),
  );
  assert.equal(missingIdentity.ok, false);
  assert.equal(
    missingIdentity.ok ? "" : missingIdentity.error.code,
    "bad-message",
  );

  const oversized = parseSignalingMessage(
    JSON.stringify({ ...BASE_MESSAGE, kind: "offer", sdp: "x".repeat(70_000) }),
  );
  assert.equal(oversized.ok, false);
  assert.equal(oversized.ok ? "" : oversized.error.code, "message-too-large");
});
