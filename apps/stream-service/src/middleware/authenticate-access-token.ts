import { createAuthenticateAccessToken } from "@aimess/auth-jwt";
import type { RequestHandler } from "express";

import { createBannedUserGuard } from "@aimess/redis";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";
import { isSessionActiveForRequest } from "../lib/session-active-cache.js";

/**
 * Shared JWT verification — token is signed by auth-service, verified here
 * with the same secret.
 *
 * stream-service owns no session table, but it still consults the revoked-
 * session marker auth-service writes in Redis. Logout, "sign this device out",
 * revoke-all and change-password can only write that marker — they cannot
 * invalidate an already-issued JWT — so without this check a stolen token keeps
 * working on every /streams route for the rest of its lifetime.
 */
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
