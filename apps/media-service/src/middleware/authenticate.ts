import { createAuthenticateAccessToken } from "@aimess/auth-jwt";
import type { RequestHandler } from "express";

import { createBannedUserGuard, createSessionActiveGuard } from "@aimess/redis";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";

export const authenticateAccessToken: RequestHandler =
  createAuthenticateAccessToken({
    accessTokenSecret: env.JWT_ACCESS_SECRET,
    adminTokenSecret: env.JWT_ADMIN_SECRET,
    // Force remote logout. Without this a logged-out or remotely-terminated
    // token kept minting presigned upload and download URLs until it expired.
    // No readiness flag here: unlike community and stream, this service always
    // connects its Redis client at boot, and the shared client rejects fast
    // when Redis is down, which the guard's catch turns into fail-open — the
    // same outcome the flag produces elsewhere.
    //
    // Only the user-token branch reaches this; the admin-token fallback in
    // `createAuthenticateAccessToken` carries an AdminUser session id, which
    // shares no id space with AuthUser sessions.
    assertSessionActive: createSessionActiveGuard(() => redis),
    // Permanent Super Admin system ban: 403 ACCOUNT_BANNED on every
    // authenticated route here. Independent of the session check above — a ban
    // revokes sessions too, but this service must reject a banned user even if
    // a session slipped through, and two of the nine services do not consult
    // sessions at all.
    assertUserBanned: createBannedUserGuard(() => redis),
  });
