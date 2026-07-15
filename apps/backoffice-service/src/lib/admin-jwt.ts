import jwt from "jsonwebtoken";

import {
  ADMIN_ACCESS_TOKEN_TYPE,
  verifyAdminAccessToken as verifySharedAdminAccessToken,
  type AdminAccessTokenPayload,
  type VerifiedAdminAccessToken,
} from "@aimess/auth-jwt";

import { env } from "../config/env.js";

export { ADMIN_ACCESS_TOKEN_TYPE };
export type { AdminAccessTokenPayload, VerifiedAdminAccessToken };

export function parseExpiresInSeconds(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Invalid JWT expiry value: ${value}`);
  }
  return Math.floor(seconds);
}

export function signAdminAccessToken(params: {
  adminId: string;
  sessionId: string;
}): { token: string; expiresInSeconds: number } {
  const expiresInSeconds = parseExpiresInSeconds(env.JWT_ADMIN_EXPIRES_IN);
  const payload: AdminAccessTokenPayload = {
    sub: params.adminId,
    sid: params.sessionId,
    type: ADMIN_ACCESS_TOKEN_TYPE,
  };
  const token = jwt.sign(payload, env.JWT_ADMIN_SECRET, {
    expiresIn: expiresInSeconds,
  });
  return { token, expiresInSeconds };
}

export function verifyAdminAccessToken(
  token: string
): VerifiedAdminAccessToken {
  return verifySharedAdminAccessToken(token, env.JWT_ADMIN_SECRET);
}
