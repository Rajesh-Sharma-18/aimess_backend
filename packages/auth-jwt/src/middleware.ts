import { UnauthorizedError } from "@aimess/errors";
import type { RequestHandler } from "express";

import { extractBearerToken, verifyAccessToken } from "./access-token.js";

declare global {
  namespace Express {
    interface Request {
      auth: {
        userId: string;
        sessionId: string;
      };
    }
  }
}

export type AuthenticateAccessTokenOptions = {
  accessTokenSecret: string;
  /** When set, revoked sessions are rejected immediately (force remote logout). */
  assertSessionActive?: (sessionId: string) => Promise<boolean>;
};

/**
 * Express middleware: verify AIMess access JWT (issued by auth-service).
 * Requires the same `JWT_ACCESS_SECRET` in every service that uses this.
 */
export function createAuthenticateAccessToken(
  accessTokenSecretOrOptions: string | AuthenticateAccessTokenOptions
): RequestHandler {
  const options: AuthenticateAccessTokenOptions =
    typeof accessTokenSecretOrOptions === "string"
      ? { accessTokenSecret: accessTokenSecretOrOptions }
      : accessTokenSecretOrOptions;

  return async (req, _res, next) => {
    try {
      const token = extractBearerToken(req.headers.authorization);
      const auth = verifyAccessToken(token, options.accessTokenSecret);

      if (options.assertSessionActive) {
        const active = await options.assertSessionActive(auth.sessionId);
        if (!active) {
          throw new UnauthorizedError("AUTH_SESSION_ENDED");
        }
      }

      req.auth = auth;
      next();
    } catch (error) {
      next(error);
    }
  };
}
