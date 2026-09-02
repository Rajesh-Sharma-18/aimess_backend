import { createAuthenticateAccessToken } from "@aimess/auth-jwt";
import type { RequestHandler } from "express";

import { createBannedUserGuard, createSessionActiveGuard } from "@aimess/redis";

import { env } from "../config/env.js";
import { isCommunityCacheReady, redis } from "../config/redis.js";

/**
 * Shared JWT verification — the token is signed by auth-service and verified
 * here with the same secret.
 */
export const authenticateAccessToken: RequestHandler =
  createAuthenticateAccessToken({
    accessTokenSecret: env.JWT_ACCESS_SECRET,
    // Force remote logout. Without this, a token stayed usable against every
    // route in this service after the user logged out or terminated the device
    // from another session — revocation writes a Redis marker, but nothing here
    // ever read it. Same helper and same fail-open policy as the four services
    // that already consulted it.
    assertSessionActive: createSessionActiveGuard(
      () => redis,
      isCommunityCacheReady
    ),
    // Permanent Super Admin system ban: 403 ACCOUNT_BANNED on every
    // authenticated route here. Independent of the session check above — a ban
    // revokes sessions too, but this service must reject a banned user even if
    // a session slipped through.
    assertUserBanned: createBannedUserGuard(() => redis),
  });
