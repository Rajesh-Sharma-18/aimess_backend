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

// Same guard, but a request that cannot prove a live access token is allowed
// through UNAUTHENTICATED (req.auth stays undefined) instead of being rejected.
// Only /logout uses it.
//
// A missing header was already let through: the refresh token is an httpOnly
// cookie the browser cannot clear itself, so sign-out must not require a live
// access token. A STALE header was not, and that was the hole: a tab left idle
// past the 1h access-token expiry still sends its old token, so logout 401'd in
// this guard and never reached the controller's refresh-cookie fallback. The
// client cleared its own state either way, leaving the session alive and piling
// up in Connected Devices on every sign-in/sign-out cycle.
//
// Falling through grants nothing: `req.auth` is never set on this path, so the
// controller can only revoke the session the caller still proves with a refresh
// token (cookie or body). Both are credentials in their own right, and logout
// is idempotent.
export const authenticateAccessTokenOptional: RequestHandler = (
  req,
  res,
  next
) => {
  if (!req.headers.authorization) {
    next();
    return;
  }

  // The rejection is swallowed on purpose - see above. `req.auth` is only
  // assigned on success, so a rejected token leaves the request
  // unauthenticated rather than failing it.
  authenticateAccessToken(req, res, () => next());
};
