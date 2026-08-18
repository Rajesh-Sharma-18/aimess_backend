import { createAuthenticateAccessToken } from "@aimess/auth-jwt";
import { logger } from "@aimess/logger";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import { createBannedUserGuard } from "@aimess/redis";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";

/**
 * Shared JWT verification — token is signed by auth-service, verified here
 * with the same secret. Community-service does not track sessions, so it only
 * verifies the access token (no `assertSessionActive`).
 */
const verify: RequestHandler = createAuthenticateAccessToken({
  accessTokenSecret: env.JWT_ACCESS_SECRET,
  // Permanent Super Admin system ban: 403 ACCOUNT_BANNED on every
  // authenticated route here. Independent of the session check above — a ban
  // revokes sessions too, but this service must reject a banned user even if
  // a session slipped through, and two of the nine services do not consult
  // sessions at all.
  assertUserBanned: createBannedUserGuard(() => redis),
});

/**
 * TEMPORARY DEBUG WRAPPER — remove once the `/categories/admin` 401
 * investigation is closed. Never logs the raw token, only shape/claims.
 */
function decodeUnverifiedForDebug(header: string | undefined) {
  if (!header?.startsWith("Bearer ")) return { hasHeader: false };
  const token = header.slice("Bearer ".length).trim();
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { hasHeader: true, malformed: true };
  }
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    );
    return {
      hasHeader: true,
      claims: {
        type: payload.type,
        role: payload.role,
        hasSub: !!payload.sub,
        hasSid: !!payload.sid,
      },
    };
  } catch {
    return { hasHeader: true, malformed: true };
  }
}

export const authenticateAccessToken: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  logger.debug("[auth-debug] incoming request", {
    path: req.originalUrl,
    method: req.method,
    authHeaderPresent: !!req.headers.authorization,
    unverifiedClaims: decodeUnverifiedForDebug(req.headers.authorization),
  });

  verify(req, res, (err?: unknown) => {
    logger.debug("[auth-debug] verify result", {
      path: req.originalUrl,
      ok: !err,
      error: err instanceof Error ? err.message : err,
      reqAuth: req.auth,
    });
    next(err);
  });
};
