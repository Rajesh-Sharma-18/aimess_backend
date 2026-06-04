import { randomUUID } from "node:crypto";

import jwt from "jsonwebtoken";

import { UnauthorizedError } from "@aimess/errors";

import { env } from "../config/env.js";

export const ADMIN_ACCESS_TOKEN_TYPE = "admin_access" as const;
export const ADMIN_REFRESH_TOKEN_TYPE = "admin_refresh" as const;

export type AdminAccessTokenPayload = {
  sub: string; // admin id
  role: string; // RoleKey
  perms: string[]; // resolved permission keys
  jti: string;
  type: typeof ADMIN_ACCESS_TOKEN_TYPE;
};

export type AdminRefreshTokenPayload = {
  sub: string;
  jti: string;
  type: typeof ADMIN_REFRESH_TOKEN_TYPE;
};

export type VerifiedAdminAccessToken = {
  adminId: string;
  role: string;
  permissions: string[];
  jti: string;
};

function parseExpiresInSeconds(value: string): number {
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

export function newJti(): string {
  return randomUUID();
}

export function signAdminAccessToken(params: {
  adminId: string;
  role: string;
  permissions: string[];
  jti: string;
}): { token: string; expiresInSeconds: number } {
  const expiresInSeconds = parseExpiresInSeconds(env.JWT_ADMIN_EXPIRES_IN);
  const payload: AdminAccessTokenPayload = {
    sub: params.adminId,
    role: params.role,
    perms: params.permissions,
    jti: params.jti,
    type: ADMIN_ACCESS_TOKEN_TYPE,
  };
  const token = jwt.sign(payload, env.JWT_ADMIN_SECRET, {
    expiresIn: expiresInSeconds,
  });
  return { token, expiresInSeconds };
}

export function signAdminRefreshToken(params: {
  adminId: string;
  jti: string;
}): { token: string; expiresInSeconds: number } {
  const expiresInSeconds = parseExpiresInSeconds(
    env.JWT_ADMIN_REFRESH_EXPIRES_IN
  );
  const payload: AdminRefreshTokenPayload = {
    sub: params.adminId,
    jti: params.jti,
    type: ADMIN_REFRESH_TOKEN_TYPE,
  };
  const token = jwt.sign(payload, env.JWT_ADMIN_REFRESH_SECRET, {
    expiresIn: expiresInSeconds,
  });
  return { token, expiresInSeconds };
}

export function verifyAdminAccessToken(
  token: string
): VerifiedAdminAccessToken {
  let payload: AdminAccessTokenPayload;
  try {
    payload = jwt.verify(
      token,
      env.JWT_ADMIN_SECRET
    ) as AdminAccessTokenPayload;
  } catch (error) {
    throw toUnauthorized(error);
  }

  if (
    payload.type !== ADMIN_ACCESS_TOKEN_TYPE ||
    !payload.sub ||
    !payload.jti ||
    !Array.isArray(payload.perms)
  ) {
    throw new UnauthorizedError("AUTH_INVALID_TOKEN");
  }

  return {
    adminId: payload.sub,
    role: payload.role,
    permissions: payload.perms,
    jti: payload.jti,
  };
}

export function verifyAdminRefreshToken(token: string): {
  adminId: string;
  jti: string;
} {
  let payload: AdminRefreshTokenPayload;
  try {
    payload = jwt.verify(
      token,
      env.JWT_ADMIN_REFRESH_SECRET
    ) as AdminRefreshTokenPayload;
  } catch (error) {
    throw toUnauthorized(error);
  }

  if (
    payload.type !== ADMIN_REFRESH_TOKEN_TYPE ||
    !payload.sub ||
    !payload.jti
  ) {
    throw new UnauthorizedError("AUTH_INVALID_TOKEN");
  }

  return { adminId: payload.sub, jti: payload.jti };
}
