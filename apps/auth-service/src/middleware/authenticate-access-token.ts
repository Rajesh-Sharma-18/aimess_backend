import { createAuthenticateAccessToken } from "@aimess/auth-jwt";
import type { RequestHandler } from "express";

import { createBannedUserGuard } from "@aimess/redis";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";
import { isSessionActiveForRequest } from "../lib/session-active-cache.js";

export const authenticateAccessToken: RequestHandler =
  createAuthenticateAccessToken({
    accessTokenSecret: env.JWT_ACCESS_SECRET,
    assertSessionActive: isSessionActiveForRequest,
    // Permanent Super Admin system ban: 403 ACCOUNT_BANNED on every
    // authenticated route here. Independent of the session check above — a ban
    // revokes sessions too, but this service must reject a banned user even if
    // a session slipped through, and two of the nine services do not consult
    // sessions at all.
    assertUserBanned: createBannedUserGuard(() => redis),
  });

// Same guard, but a request with NO Authorization header is allowed through
// unauthenticated (req.auth stays undefined). Only /logout uses it: once the
// refresh token lives in an httpOnly cookie the browser cannot clear it itself,
// so a user whose access token already expired must still be able to sign out.
// A malformed or revoked token is still rejected - this skips the check, it
// never weakens it.
export const authenticateAccessTokenOptional: RequestHandler = (
  req,
  res,
  next
) => {
  if (!req.headers.authorization) {
    next();
    return;
  }

  authenticateAccessToken(req, res, next);
};
