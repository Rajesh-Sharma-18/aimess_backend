import { createAuthenticateAccessToken } from "@aimess/auth-jwt";
import type { RequestHandler } from "express";

import { env } from "../config/env.js";

/**
 * Shared JWT verification — token is signed by auth-service, verified here
 * with the same secret. Community-service does not track sessions, so it only
 * verifies the access token (no `assertSessionActive`).
 */
export const authenticateAccessToken: RequestHandler =
  createAuthenticateAccessToken({
    accessTokenSecret: env.JWT_ACCESS_SECRET,
  });
