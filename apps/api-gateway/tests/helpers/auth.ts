/**
 * Auth helpers for tests — mint real tokens with the same algorithm and secret
 * the gateway verifies against, so JWT auth is exercised end-to-end (valid /
 * expired / forged are all genuinely distinguishable).
 *
 *   - User access tokens use `@aimess/auth-jwt` (`JWT_ACCESS_SECRET`) — the
 *     shared contract the socket-auth middleware verifies.
 *   - Admin tokens use plain `jsonwebtoken` (`JWT_ADMIN_SECRET`) — matching the
 *     edge check in `src/middleware/admin-jwt.ts`, which only verifies signature
 *     + expiry (HS256) and does NOT inspect a jti blacklist.
 */
import { signAccessToken } from "@aimess/auth-jwt";
import jwt from "jsonwebtoken";

import { env } from "../../src/config/env.js";

// Read the secrets from the SAME config module the middleware verifies with,
// not from `process.env`. `tests/setup/env.ts` seeds process.env first, but the
// gateway's config loads `.env` through dotenvx with `override: true`, so the
// two disagree whenever that load wins — and `admin-edge.test.ts` then rejected
// a token it had just minted, flaking on module import order rather than on
// anything the edge actually does.
const ACCESS_SECRET = env.JWT_ACCESS_SECRET;
const ADMIN_SECRET = env.JWT_ADMIN_SECRET as string;

export const TEST_USER_ID = "11111111-1111-4111-8111-111111111111";
export const TEST_SESSION_ID = "22222222-2222-4222-8222-222222222222";
export const TEST_ADMIN_ID = "33333333-3333-4333-8333-333333333333";

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

/**
 * A valid admin Bearer token accepted by `src/middleware/admin-jwt.ts`
 * (HS256, `JWT_ADMIN_SECRET`). The edge only checks signature + expiry, so the
 * claim shape is flexible; `sub`/`role` are included for realism.
 */
export function makeAdminToken(
  opts: { adminId?: string; role?: string; expiresInSeconds?: number } = {}
): string {
  return jwt.sign(
    { sub: opts.adminId ?? TEST_ADMIN_ID, role: opts.role ?? "ADMIN" },
    ADMIN_SECRET,
    { expiresIn: opts.expiresInSeconds ?? 3600 }
  );
}

/** An admin token already expired (for negative-path tests). */
export function makeExpiredAdminToken(): string {
  return jwt.sign({ sub: TEST_ADMIN_ID, role: "ADMIN" }, ADMIN_SECRET, {
    expiresIn: -10,
  });
}

/** An admin token signed with the WRONG secret (forged). */
export function makeForgedAdminToken(): string {
  return jwt.sign(
    { sub: TEST_ADMIN_ID, role: "ADMIN" },
    "attacker-controlled-admin-secret",
    { expiresIn: 3600 }
  );
}

/** `Authorization: Bearer <token>` header object. */
export function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}
