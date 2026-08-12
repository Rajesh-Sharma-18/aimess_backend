/**
 * Auth helpers for tests — mint real access tokens with the same algorithm and
 * secret the service verifies against, so JWT auth is exercised end-to-end
 * (valid / expired / forged are all genuinely distinguishable). Built only on
 * `@aimess/auth-jwt` so no extra transitive dependency must resolve.
 *
 * chat-service authenticates with the shared `createAuthenticateAccessToken`
 * middleware (see src/middleware/authenticate.ts), so these tokens work for any
 * authenticated chat route.
 */
import { signAccessToken } from "@aimess/auth-jwt";

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET as string;

export const TEST_USER_ID = "11111111-1111-4111-8111-111111111111";
export const TEST_SESSION_ID = "22222222-2222-4222-8222-222222222222";
/** The other side of the default private room the app-factory hands out. */
export const TEST_PEER_ID = "33333333-3333-4333-8333-333333333333";

/** A valid Bearer access token (default: TEST_USER_ID / TEST_SESSION_ID). */
export function makeAccessToken(
  opts: { userId?: string; sessionId?: string; expiresInSeconds?: number } = {}
): string {
  return signAccessToken({
    userId: opts.userId ?? TEST_USER_ID,
    sessionId: opts.sessionId ?? TEST_SESSION_ID,
    secret: ACCESS_SECRET,
    expiresInSeconds: opts.expiresInSeconds ?? 3600,
  });
}

/** An access token that has already expired (negative TTL → exp in the past). */
export function makeExpiredAccessToken(): string {
  return signAccessToken({
    userId: TEST_USER_ID,
    sessionId: TEST_SESSION_ID,
    secret: ACCESS_SECRET,
    expiresInSeconds: -10,
  });
}

/** A token signed with the WRONG secret (forged / tampered signature). */
export function makeForgedAccessToken(): string {
  return signAccessToken({
    userId: TEST_USER_ID,
    sessionId: TEST_SESSION_ID,
    secret: "attacker-controlled-secret",
    expiresInSeconds: 3600,
  });
}

/** `Authorization: Bearer <token>` header object. */
export function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}
