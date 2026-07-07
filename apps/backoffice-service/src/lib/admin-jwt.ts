import jwt from "jsonwebtoken";

import { UnauthorizedError } from "@aimess/errors";

import { env } from "../config/env.js";

export const ADMIN_ACCESS_TOKEN_TYPE = "admin_access" as const;

export type AdminAccessTokenPayload = {
  sub: string; // admin id
  sid: string; // session id
  type: typeof ADMIN_ACCESS_TOKEN_TYPE;
};

export type VerifiedAdminAccessToken = {
  adminId: string;
  sessionId: string;
};

export function parseExpiresInSeconds(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Invalid JWT expiry value: ${value}`);
  }
  return Math.floor(seconds);
}

/** Map jsonwebtoken errors to stable @aimess/errors codes (mirrors auth-jwt). */
function toUnauthorized(error: unknown): UnauthorizedError {
  if (error instanceof UnauthorizedError) return error;
  if (error instanceof jwt.TokenExpiredError) {
    return new UnauthorizedError("AUTH_TOKEN_EXPIRED");
  }
  if (
    error instanceof jwt.JsonWebTokenError ||
    error instanceof jwt.NotBeforeError
  ) {
    return new UnauthorizedError("AUTH_INVALID_TOKEN");
  }
  return new UnauthorizedError("AUTH_INVALID_TOKEN");
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
  let payload: AdminAccessTokenPayload;
  try {
    payload = jwt.verify(token, env.JWT_ADMIN_SECRET, {
      algorithms: ["HS256"],
    }) as AdminAccessTokenPayload;
  } catch (error) {
    throw toUnauthorized(error);
  }

  if (
    payload.type !== ADMIN_ACCESS_TOKEN_TYPE ||
    !payload.sub ||
    !payload.sid
  ) {
    throw new UnauthorizedError("AUTH_INVALID_TOKEN");
  }

  return {
    adminId: payload.sub,
    sessionId: payload.sid,
  };
}
