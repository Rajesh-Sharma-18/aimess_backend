import { Router, type IRouter } from "express";

import { createAuthenticateAccessToken } from "@aimess/auth-jwt";

import { env } from "../config/env.js";
import { isSessionActiveForRequest } from "../lib/session-active-cache.js";
import {
  registerDevice,
  unregisterDevice,
} from "../api/controllers/device.controller.js";

export const deviceRouter: IRouter = Router();

const authenticate = createAuthenticateAccessToken({
  accessTokenSecret: env.JWT_ACCESS_SECRET,
  assertSessionActive: isSessionActiveForRequest,
});

deviceRouter.post("/", authenticate, registerDevice);
deviceRouter.delete("/:token", authenticate, unregisterDevice);
