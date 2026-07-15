import jwt from "jsonwebtoken";

import { UnauthorizedError } from "@aimess/errors";

/** Must match the `type` claim set when auth-service signs access tokens. */
export const ACCESS_TOKEN_TYPE = "access" as const;

/** Platform-wide role carried on the access token (auth-service `GlobalRole`). */
export type PlatformRole = "USER" | "ADMIN";

export type AccessTokenPayload = {
  /** Auth user id (UUID). */
  sub: string;
  /** Session id (UUID). */
  sid: string;
  type: typeof ACCESS_TOKEN_TYPE;
  /** Platform role. Optional so older tokens without it still parse. */
  role?: PlatformRole;
};

export type VerifiedAccessToken = {
  userId: string;
  sessionId: string;
  role: PlatformRole;
};

export function signAccessToken(params: {
  userId: string;
  sessionId: string;
  secret: string;
  expiresInSeconds: number;
  role?: PlatformRole;
}): string {
  const payload: AccessTokenPayload = {
    sub: params.userId,
    sid: params.sessionId,
    type: ACCESS_TOKEN_TYPE,
    // Include `role` only when provided so callers that don't pass it keep the
    // old token shape (and older tokens remain valid).
    ...(params.role ? { role: params.role } : {}),
  };

  return jwt.sign(payload, params.secret, {
    expiresIn: params.expiresInSeconds,
  });
}

/** Maps jsonwebtoken verify failures to stable @aimess/errors codes. */
function toUnauthorized(error: unknown): UnauthorizedError {
  if (error instanceof UnauthorizedError) return error;
  if (error instanceof jwt.TokenExpiredError) {
    return new UnauthorizedError("AUTH_TOKEN_EXPIRED");
  }
  return new UnauthorizedError("AUTH_INVALID_TOKEN");
}

export function verifyAccessToken(
  token: string,
  secret: string
): VerifiedAccessToken {
  let payload: AccessTokenPayload;

  try {
    payload = jwt.verify(token, secret, {
      algorithms: ["HS256"],
    }) as AccessTokenPayload;
  } catch (error) {
    throw toUnauthorized(error);
  }

  if (payload.type !== ACCESS_TOKEN_TYPE || !payload.sub || !payload.sid) {
    throw new UnauthorizedError("AUTH_INVALID_TOKEN");
  }

  // Resolve role defensively: anything that is not exactly "ADMIN"
  // (missing/unknown) is treated as the non-privileged "USER".
  const role: PlatformRole = payload.role === "ADMIN" ? "ADMIN" : "USER";

  return {
    userId: payload.sub,
    sessionId: payload.sid,
    role,
  };
}

/** Must match the `type` claim set when backoffice-service signs admin access tokens. */
export const ADMIN_ACCESS_TOKEN_TYPE = "admin_access" as const;

export type AdminAccessTokenPayload = {
  /** Admin user id (UUID). */
  sub: string;
  /** Admin session id (UUID). */
  sid: string;
  type: typeof ADMIN_ACCESS_TOKEN_TYPE;
};

export type VerifiedAdminAccessToken = {
  adminId: string;
  sessionId: string;
};

/**
 * Verifies a backoffice admin access token (separate secret + `type` claim
 * from the user access token). Shared here so services that need to accept
 * both token kinds — e.g. media-service's upload-url endpoint, used by the
 * Backoffice avatar upload flow — don't reimplement JWT verification.
 */
export function verifyAdminAccessToken(
  token: string,
  secret: string
): VerifiedAdminAccessToken {
  let payload: AdminAccessTokenPayload;

  try {
    payload = jwt.verify(token, secret, {
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

  return { adminId: payload.sub, sessionId: payload.sid };
}

export function extractBearerToken(
  authorizationHeader: string | undefined
): string {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    throw new UnauthorizedError("AUTH_UNAUTHORIZED");
  }

  const token = authorizationHeader.slice("Bearer ".length).trim();
  if (!token) {
    throw new UnauthorizedError("AUTH_UNAUTHORIZED");
  }

  return token;
}
