import type { RequestHandler } from "express";

import { createAuthenticateAccessToken } from "@aimess/auth-jwt";

import { env } from "../config/env.js";

/**
 * Express middleware: verify AIMess access JWT.
 * Populates `req.auth` with `{ userId, sessionId }`.
 */
export const authenticate: RequestHandler = createAuthenticateAccessToken(
  env.JWT_ACCESS_SECRET
);
