import { extractBearerToken, verifyAccessToken } from "@aimess/auth-jwt";
import type { RequestHandler } from "express";

import { env, accessTokenVerifyConfig } from "../config/env.js";

/**
 * Tries to authenticate the JWT if an Authorization header is present.
 * - No Authorization header → proceeds as anonymous (req.auth remains unset)
 * - Valid token → sets req.auth.userId / sessionId / role as normal
 * - Invalid/expired token → passes error to next() → results in 401
 */
export const optionalAuthenticateAccessToken: RequestHandler = async (
  req,
  _res,
  next
) => {
  if (!req.headers.authorization) {
    return next();
  }
  try {
    const token = extractBearerToken(req.headers.authorization);
    const auth = verifyAccessToken(token, accessTokenVerifyConfig);
    req.auth = auth;
    next();
  } catch (error) {
    next(error);
  }
};
