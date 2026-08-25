import { extractBearerToken, verifyAccessToken } from "@aimess/auth-jwt";
import type { RequestHandler } from "express";

import { env } from "../config/env.js";

/**
 * Best-effort authentication for routes that must serve BOTH a signed-in user
 * and an anonymous visitor — today only the group invite-link preview, which is
 * rendered by the unauthenticated link-preview card AND by the in-app invite
 * screen (where the caller's membership decides "Join Group" vs "View Group").
 *
 * - No Authorization header → anonymous, `req.auth` stays unset.
 * - Valid token → `req.auth` populated as usual.
 * - Invalid/expired token → the error propagates (401), same as a normal route:
 *   a client that sent a token expects to be told its token is dead.
 *
 * Mirrors community-service's `optionalAuthenticateAccessToken`.
 */
export const optionalAuthenticate: RequestHandler = (req, _res, next) => {
  if (!req.headers.authorization) return next();
  try {
    req.auth = verifyAccessToken(
      extractBearerToken(req.headers.authorization),
      env.JWT_ACCESS_SECRET
    );
    next();
  } catch (error) {
    next(error);
  }
};
