import type { RequestHandler } from "express";

import { createAuthenticateAccessToken } from "@aimess/auth-jwt";

import { env } from "../config/env.js";
import { isSessionActiveForRequest } from "../lib/session-active-cache.js";

/**
 * Express middleware: verify AIMess access JWT.
 * Populates `req.auth` with `{ userId, sessionId }`.
 * Rejects a terminated/revoked session immediately (force remote logout).
 */
export const authenticate: RequestHandler = createAuthenticateAccessToken({
  accessTokenSecret: env.JWT_ACCESS_SECRET,
  assertSessionActive: isSessionActiveForRequest,
});
