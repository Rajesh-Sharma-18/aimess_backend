import { extractBearerToken } from "@aimess/auth-jwt";
import { UnauthorizedError } from "@aimess/errors";
import type { RequestHandler } from "express";

import { verifyAdminAccessToken } from "../../lib/admin-jwt.js";
import { isJtiBlacklisted } from "../../lib/jti-blacklist.js";

/**
 * Verifies the admin access JWT, rejects blacklisted (logged-out / revoked)
 * jti, and attaches `req.admin = { id, role, permissions, jti }`.
 */
export const adminAuth: RequestHandler = (req, _res, next) => {
  void (async () => {
    try {
      const token = extractBearerToken(req.headers.authorization);
      const verified = verifyAdminAccessToken(token);

      if (await isJtiBlacklisted(verified.jti)) {
        throw new UnauthorizedError("AUTH_INVALID_TOKEN");
      }

      req.admin = {
        id: verified.adminId,
        role: verified.role,
        permissions: verified.permissions,
        jti: verified.jti,
      };
      next();
    } catch (error) {
      next(error);
    }
  })();
};
