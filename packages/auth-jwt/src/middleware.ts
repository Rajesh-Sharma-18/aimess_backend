import { UnauthorizedError } from "@aimess/errors";
import type { RequestHandler } from "express";

import {
  extractBearerToken,
  verifyAccessToken,
  verifyAdminAccessToken,
  type PlatformRole,
} from "./access-token.js";

declare global {
  namespace Express {
    interface Request {
      auth: {
        userId: string;
        sessionId: string;
        role: PlatformRole;
      };
    }
  }
}

export type AuthenticateAccessTokenOptions = {
  accessTokenSecret: string;
  /**
   * When set, also accepts a backoffice admin access token signed with this
   * secret (`type: "admin_access"`). Tried only as a fallback, after the
   * user access token fails to verify — so existing user auth is unaffected.
   * The admin's id is exposed as `req.auth.userId` (role "ADMIN") so
   * downstream code (e.g. object-key ownership) needs no admin-specific path.
   */
  adminTokenSecret?: string;
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

      try {
        const auth = verifyAccessToken(token, options.accessTokenSecret);

        if (options.assertSessionActive) {
          const active = await options.assertSessionActive(auth.sessionId);
          if (!active) {
            throw new UnauthorizedError("AUTH_SESSION_ENDED");
          }
        }

        req.auth = auth;
        return next();
      } catch (userTokenError) {
        // Only fall back to admin verification when the token was simply not
        // a valid user token (wrong secret/shape) — not on expiry or a
        // revoked session, which are conclusive verdicts on their own.
        if (
          !options.adminTokenSecret ||
          !(userTokenError instanceof UnauthorizedError) ||
          userTokenError.messageKey !== "AUTH_INVALID_TOKEN"
        ) {
          throw userTokenError;
        }

        const admin = verifyAdminAccessToken(token, options.adminTokenSecret);
        req.auth = {
          userId: admin.adminId,
          sessionId: admin.sessionId,
          role: "ADMIN",
        };
        return next();
      }
    } catch (error) {
      next(error);
    }
  };
}
