/**
 * Auth helpers for backoffice-service tests.
 *
 * Two token families:
 *  1. USER access tokens via `@aimess/auth-jwt` (the shared user-facing JWT) —
 *     for any route still guarded by the standard user middleware.
 *  2. ADMIN access tokens — minted with `jsonwebtoken` to EXACTLY match
 *     `src/lib/admin-jwt.ts#verifyAdminAccessToken`: payload
 *     `{ sub, sid, type: "admin_access" }` signed with `JWT_ADMIN_SECRET`.
 *     This exercises admin JWT verification end-to-end (valid / expired /
 *     forged are genuinely distinguishable).
 */
import jwt from "jsonwebtoken";
import { signAccessToken } from "@aimess/auth-jwt";

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET as string;
const ADMIN_SECRET = process.env.JWT_ADMIN_SECRET as string;

/** Must match `src/lib/admin-jwt.ts` ADMIN_ACCESS_TOKEN_TYPE. */
const ADMIN_ACCESS_TOKEN_TYPE = "admin_access" as const;

export const TEST_USER_ID = "11111111-1111-4111-8111-111111111111";
export const TEST_SESSION_ID = "22222222-2222-4222-8222-222222222222";

export const TEST_ADMIN_ID = "33333333-3333-4333-8333-333333333333";
export const TEST_ADMIN_SESSION_ID = "44444444-4444-4444-8444-444444444444";

// ---------------------------------------------------------------------------
// User-facing access tokens (@aimess/auth-jwt)
// ---------------------------------------------------------------------------

/** A valid Bearer user access token (default: TEST_USER_ID / TEST_SESSION_ID). */
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

// ---------------------------------------------------------------------------
// Admin access tokens (match src/lib/admin-jwt.ts)
// ---------------------------------------------------------------------------

/** A valid admin Bearer access token. */
export function makeAdminAccessToken(
  opts: {
    adminId?: string;
    sessionId?: string;
    expiresInSeconds?: number;
  } = {}
): string {
  return jwt.sign(
    {
      sub: opts.adminId ?? TEST_ADMIN_ID,
      sid: opts.sessionId ?? TEST_ADMIN_SESSION_ID,
      type: ADMIN_ACCESS_TOKEN_TYPE,
    },
    ADMIN_SECRET,
    { expiresIn: opts.expiresInSeconds ?? 28800 }
  );
}

/** An admin token that has already expired. */
export function makeExpiredAdminAccessToken(): string {
  return jwt.sign(
    {
      sub: TEST_ADMIN_ID,
      sid: TEST_ADMIN_SESSION_ID,
      type: ADMIN_ACCESS_TOKEN_TYPE,
    },
    ADMIN_SECRET,
    { expiresIn: -10 }
  );
}

/** An admin token signed with the WRONG secret (forged / tampered signature). */
export function makeForgedAdminAccessToken(): string {
  return jwt.sign(
    {
      sub: TEST_ADMIN_ID,
      sid: TEST_ADMIN_SESSION_ID,
      type: ADMIN_ACCESS_TOKEN_TYPE,
    },
    "attacker-controlled-secret",
    { expiresIn: 28800 }
  );
}

/**
 * Correctly signed with the admin secret, but the `type` claim is NOT
 * "admin_access" (e.g. a refresh-shaped or tampered token). `verifyAdminAccessToken`
 * rejects on the type mismatch alone.
 */
export function makeWrongTypeAdminToken(): string {
  return jwt.sign(
    {
      sub: TEST_ADMIN_ID,
      sid: TEST_ADMIN_SESSION_ID,
      type: "admin_refresh",
    },
    ADMIN_SECRET,
    { expiresIn: 28800 }
  );
}

/**
 * Correctly signed admin token but missing the `sid` claim. Exercises the
 * `!payload.sid` guard in verifyAdminAccessToken.
 */
export function makeAdminTokenWithoutSid(): string {
  return jwt.sign(
    { sub: TEST_ADMIN_ID, type: ADMIN_ACCESS_TOKEN_TYPE },
    ADMIN_SECRET,
    { expiresIn: 28800 }
  );
}

/** `Authorization: Bearer <token>` header object. */
export function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}
