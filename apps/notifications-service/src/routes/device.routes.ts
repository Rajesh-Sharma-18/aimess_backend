import { Router, type IRouter } from "express";

import { createAuthenticateAccessToken } from "@aimess/auth-jwt";

import { createBannedUserGuard } from "@aimess/redis";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";
import { isSessionActiveForRequest } from "../lib/session-active-cache.js";
import {
  registerDevice,
  unregisterDevice,
} from "../api/controllers/device.controller.js";

export const deviceRouter: IRouter = Router();

const authenticate = createAuthenticateAccessToken({
  accessTokenSecret: env.JWT_ACCESS_SECRET,
  assertSessionActive: isSessionActiveForRequest,
  // Permanent Super Admin system ban: 403 ACCOUNT_BANNED on every
  // authenticated route here. Independent of the session check above — a ban
  // revokes sessions too, but this service must reject a banned user even if
  // a session slipped through, and two of the nine services do not consult
  // sessions at all.
  assertUserBanned: createBannedUserGuard(() => redis),
});

deviceRouter.post("/", authenticate, registerDevice);
deviceRouter.delete("/:token", authenticate, unregisterDevice);
