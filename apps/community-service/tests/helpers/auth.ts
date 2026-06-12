/**
 * Auth helpers for tests — mint real access tokens with the same algorithm and
 * secret the service verifies against, so JWT auth is exercised end-to-end
 * (valid / expired / forged are all genuinely distinguishable). Built only on
 * `@aimess/auth-jwt` so no extra transitive dependency must resolve.
 *
 * community-service does not track sessions — its `authenticateAccessToken`
 * middleware only verifies the access token signature/exp (no session gate), so
 * a token minted here is immediately accepted on authenticated routes.
 */
import { signAccessToken } from "@aimess/auth-jwt";

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET as string;

export const TEST_USER_ID = "11111111-1111-4111-8111-111111111111";
export const TEST_SESSION_ID = "22222222-2222-4222-8222-222222222222";

/** A valid Bearer access token (default: TEST_USER_ID / TEST_SESSION_ID). */
export function makeAccessToken(
  opts: {
    userId?: string;
    sessionId?: string;
    expiresInSeconds?: number;
    role?: "USER" | "ADMIN";
  } = {}
): string {
  return signAccessToken({
    userId: opts.userId ?? TEST_USER_ID,
    sessionId: opts.sessionId ?? TEST_SESSION_ID,
    secret: ACCESS_SECRET,
    expiresInSeconds: opts.expiresInSeconds ?? 3600,
    ...(opts.role ? { role: opts.role } : {}),
  });
}

/** A valid Bearer access token carrying the platform-admin role. */
export function makeAdminAccessToken(): string {
  return makeAccessToken({ role: "ADMIN" });
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
