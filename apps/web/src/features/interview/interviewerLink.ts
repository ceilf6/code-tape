const JOIN_CODE_PATTERN = /^[0-9A-Za-z]{8}$/u;

export type ParsedInterviewerLink =
  | { ok: true; roomId: string; joinCode: string }
  | {
      ok: false;
      reason: "empty" | "not-interviewer-link" | "missing-join-code" | "invalid-join-code";
    };

export function parseInterviewerLink(input: string): ParsedInterviewerLink {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, reason: "empty" };
  }

  let url: URL;
  try {
    url = new URL(trimmed, defaultBaseUrl());
  } catch {
    return { ok: false, reason: "not-interviewer-link" };
  }

  const match = url.pathname.match(/\/interview\/interviewer\/([^/]+)\/?$/u);
  if (!match) {
    return { ok: false, reason: "not-interviewer-link" };
  }

  let roomId: string;
  try {
    roomId = decodeURIComponent(match[1]!);
  } catch {
    return { ok: false, reason: "not-interviewer-link" };
  }
  if (!roomId) {
    return { ok: false, reason: "not-interviewer-link" };
  }

  const joinCode = url.searchParams.get("joinCode")?.trim();
  if (!joinCode) {
    return { ok: false, reason: "missing-join-code" };
  }
  if (!JOIN_CODE_PATTERN.test(joinCode)) {
    return { ok: false, reason: "invalid-join-code" };
  }

  return { ok: true, roomId, joinCode };
}

function defaultBaseUrl(): string {
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return "http://localhost/";
}
