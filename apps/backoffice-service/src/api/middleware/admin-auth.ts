import { extractBearerToken } from "@aimess/auth-jwt";
import { NotFoundError, UnauthorizedError } from "@aimess/errors";
import type { RequestHandler } from "express";

import { assertAdminAccountAccessible } from "../../lib/admin-status-guard.js";
import { verifyAdminAccessToken } from "../../lib/admin-jwt.js";
import { getCachedAdminPermissions } from "../../lib/admin-perms-cache.js";
import { withImpliedReads } from "../../lib/implied-reads.js";
import { isAdminSessionActiveForRequest } from "../../lib/admin-session-cache.js";
import { adminUserRepository } from "../../repositories/index.js";

/**
 * Verifies the admin access JWT, checks the session is still active (Redis +
 * DB), resolves permissions per-request, and attaches
 * `req.admin = { id, sid, role, permissions }`.
 */
export const adminAuth: RequestHandler = (req, _res, next) => {
  void (async () => {
    try {
      const token = extractBearerToken(req.headers.authorization);
      const { adminId, sessionId } = verifyAdminAccessToken(token);

      if (!(await isAdminSessionActiveForRequest(sessionId))) {
        throw new UnauthorizedError("AUTH_INVALID_TOKEN");
      }

      const admin = await adminUserRepository.findById(adminId);
      if (!admin) {
        throw new NotFoundError("ADMIN_NOT_FOUND");
      }
      assertAdminAccountAccessible(admin);

      const permissions = await getCachedAdminPermissions(
        adminId,
        admin.role.key
      );

      req.admin = {
        id: adminId,
        sid: sessionId,
        role: admin.role.key,
        // Applied here as well as in the RBAC repo: a cached set written before
        // the read/action split still has to satisfy the `<module>.read` guards.
        permissions: withImpliedReads(permissions),
      };
      next();
    } catch (error) {
      next(error);
    }
  })();
};
