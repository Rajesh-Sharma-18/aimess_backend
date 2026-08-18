import { createAuthenticateAccessToken } from "@aimess/auth-jwt";
import type { RequestHandler } from "express";

import { createBannedUserGuard } from "@aimess/redis";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";

export const authenticateAccessToken: RequestHandler =
  createAuthenticateAccessToken({
    accessTokenSecret: env.JWT_ACCESS_SECRET,
    adminTokenSecret: env.JWT_ADMIN_SECRET,
    // Permanent Super Admin system ban: 403 ACCOUNT_BANNED on every
    // authenticated route here. Independent of the session check above — a ban
    // revokes sessions too, but this service must reject a banned user even if
    // a session slipped through, and two of the nine services do not consult
    // sessions at all.
    assertUserBanned: createBannedUserGuard(() => redis),
  });
