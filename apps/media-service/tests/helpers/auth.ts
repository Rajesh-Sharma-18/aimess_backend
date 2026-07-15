import jwt from "jsonwebtoken";
import { signAccessToken, ADMIN_ACCESS_TOKEN_TYPE } from "@aimess/auth-jwt";

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET as string;
const ADMIN_SECRET = process.env.JWT_ADMIN_SECRET as string;

export const TEST_USER_ID = "11111111-1111-4111-8111-111111111111";
export const TEST_SESSION_ID = "22222222-2222-4222-8222-222222222222";

export const TEST_ADMIN_ID = "33333333-3333-4333-8333-333333333333";
export const TEST_ADMIN_SESSION_ID = "44444444-4444-4444-8444-444444444444";

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

export function makeExpiredAccessToken(): string {
  return signAccessToken({
    userId: TEST_USER_ID,
    sessionId: TEST_SESSION_ID,
    secret: ACCESS_SECRET,
    expiresInSeconds: -10,
  });
}

export function makeForgedAccessToken(): string {
  return signAccessToken({
    userId: TEST_USER_ID,
    sessionId: TEST_SESSION_ID,
    secret: "attacker-controlled-secret",
    expiresInSeconds: 3600,
  });
}

export function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

// ---------------------------------------------------------------------------
// Admin access tokens (mirrors backoffice-service's src/lib/admin-jwt.ts)
// ---------------------------------------------------------------------------

export function makeAdminAccessToken(
  opts: { adminId?: string; sessionId?: string; expiresInSeconds?: number } = {}
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
