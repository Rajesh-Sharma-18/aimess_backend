import { createAuthenticateAccessToken } from "@aimess/auth-jwt";
import type { RequestHandler } from "express";

import { env } from "../config/env.js";
import { isSessionActiveForRequest } from "../lib/session-active-cache.js";

export const authenticateAccessToken: RequestHandler =
  createAuthenticateAccessToken({
    accessTokenSecret: env.JWT_ACCESS_SECRET,
    assertSessionActive: isSessionActiveForRequest,
  });
