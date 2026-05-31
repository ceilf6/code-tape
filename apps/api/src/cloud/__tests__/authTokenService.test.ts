import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ACCESS_TOKEN_TTL_MS,
  createAuthTokenService,
} from "../authTokenService.js";

test("issues a signed access token whose ownerId equals the refresh token", () => {
  const auth = createAuthTokenService({ secret: "test-secret", now: () => 1_000 });
  const issued = auth.issueFromRefreshToken("device-token-123");
  assert.equal(issued.ok, true);
  if (!issued.ok) return;
  assert.equal(issued.value.tokenType, "Bearer");
  assert.equal(issued.value.expiresAt, 1_000 + DEFAULT_ACCESS_TOKEN_TTL_MS);

  const verified = auth.verifyAccessToken(issued.value.accessToken, 2_000);
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.equal(verified.value.ownerId, "device-token-123");
});

test("rejects refresh tokens that are too short", () => {
  const auth = createAuthTokenService({ secret: "test-secret" });
  const issued = auth.issueFromRefreshToken("short");
  assert.equal(issued.ok, false);
  if (issued.ok) return;
  assert.equal(issued.error.code, "unauthorized");
});

test("rejects an expired access token", () => {
  const auth = createAuthTokenService({
    secret: "test-secret",
    accessTokenTtlMs: 1_000,
    now: () => 0,
  });
  const issued = auth.issueFromRefreshToken("device-token-123");
  assert.equal(issued.ok, true);
  if (!issued.ok) return;

  const expired = auth.verifyAccessToken(issued.value.accessToken, 1_000);
  assert.equal(expired.ok, false);
  if (expired.ok) return;
  assert.match(expired.error.message, /expired/);
});

test("rejects a tampered payload (signature mismatch)", () => {
  const auth = createAuthTokenService({ secret: "test-secret", now: () => 0 });
  const issued = auth.issueFromRefreshToken("device-token-123");
  assert.equal(issued.ok, true);
  if (!issued.ok) return;

  const signature = issued.value.accessToken.split(".")[1];
  const forgedPayload = Buffer.from(
    JSON.stringify({ ownerId: "attacker", iat: 0, exp: Number.MAX_SAFE_INTEGER }),
    "utf8",
  ).toString("base64url");
  const forged = `${forgedPayload}.${signature}`;

  const verified = auth.verifyAccessToken(forged, 1_000);
  assert.equal(verified.ok, false);
});

test("rejects a token signed with a different secret", () => {
  const issuer = createAuthTokenService({ secret: "secret-a", now: () => 0 });
  const verifier = createAuthTokenService({ secret: "secret-b", now: () => 0 });
  const issued = issuer.issueFromRefreshToken("device-token-123");
  assert.equal(issued.ok, true);
  if (!issued.ok) return;

  const verified = verifier.verifyAccessToken(issued.value.accessToken, 1_000);
  assert.equal(verified.ok, false);
});

test("rejects malformed tokens", () => {
  const auth = createAuthTokenService({ secret: "test-secret" });
  for (const bad of ["", "no-dot", ".onlysig", "payload.", "a.b.c.d"]) {
    assert.equal(auth.verifyAccessToken(bad).ok, false);
  }
});
