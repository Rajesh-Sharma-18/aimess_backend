import { ForbiddenError, UnauthorizedError } from "@aimess/errors";
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
  /**
   * Shared HS256 secret.
   *
   * Optional now that verification can also be done with a public key. A
   * service configured with `accessTokenPublicKey` and no secret cannot mint
   * tokens at all, which is the point: a leak from it discloses nothing that
   * forges a session.
   */
  accessTokenSecret?: string;
  /** RS256 public key. Not a secret; safe to ship to every service. */
  accessTokenPublicKey?: string;
  /**
   * Reject a token that carries no `iss`/`aud`. Leave false until every token
   * minted before the claims existed has expired. See `AccessTokenVerifyConfig`.
   */
  requireIssuerAudience?: boolean;
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
  // When set, a permanently system-banned user is rejected with 403
  // ACCOUNT_BANNED on EVERY authenticated route of the mounting service.
  //
  // Second, independent layer next to `assertSessionActive`: a ban revokes all
  // sessions too, but community-service and stream-service do not wire the
  // session check, and a session issued in the same instant as the ban would
  // race past it. Resolve `true` when the user is positively known to be
  // banned; implementations fail OPEN on infrastructure errors so a Redis blip
  // cannot sign the platform out (session revocation still holds the ban).
  //
  // Never consulted on the admin-token fallback below — `req.auth.userId` is an
  // AdminUser.id there, which shares no id space with AuthUser.
  assertUserBanned?: (userId: string) => Promise<boolean>;
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

  if (!options.accessTokenSecret && !options.accessTokenPublicKey) {
    throw new Error(
      "createAuthenticateAccessToken requires accessTokenSecret or accessTokenPublicKey"
    );
  }

  const verifyConfig = {
    secret: options.accessTokenSecret,
    publicKey: options.accessTokenPublicKey,
    requireIssuerAudience: options.requireIssuerAudience,
  };

  return async (req, _res, next) => {
    try {
      const token = extractBearerToken(req.headers.authorization);

      try {
        const auth = verifyAccessToken(token, verifyConfig);

        if (options.assertSessionActive) {
          const active = await options.assertSessionActive(auth.sessionId);
          if (!active) {
            throw new UnauthorizedError("AUTH_SESSION_ENDED");
          }
        }

        // 403, not 401: the token is valid and refreshing it will not help.
        // A distinct code lets every client tell "sign in again" apart from
        // "this account is permanently banned" and stop retrying.
        if (options.assertUserBanned) {
          const banned = await options.assertUserBanned(auth.userId);
          if (banned) {
            throw new ForbiddenError("ACCOUNT_BANNED");
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
