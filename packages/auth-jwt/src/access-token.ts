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
    if (error instanceof UnauthorizedError) {
      throw error;
    }

    if (error instanceof jwt.TokenExpiredError) {
      throw new UnauthorizedError("AUTH_TOKEN_EXPIRED");
    }

    if (
      error instanceof jwt.JsonWebTokenError ||
      error instanceof jwt.NotBeforeError
    ) {
      throw new UnauthorizedError("AUTH_INVALID_TOKEN");
    }

    throw new UnauthorizedError("AUTH_INVALID_TOKEN");
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
