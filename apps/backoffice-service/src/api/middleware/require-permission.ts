import { ForbiddenError, UnauthorizedError } from "@aimess/errors";
import type { RequestHandler } from "express";

import type { PermissionKey } from "../../constants/index.js";

/**
 * RBAC gate — requires `req.admin` (set by `adminAuth`) to carry `permission`.
 * Must be mounted AFTER `adminAuth`.
 */
export function requirePermission(permission: PermissionKey): RequestHandler {
  return (req, _res, next) => {
    if (!req.admin) {
      next(new UnauthorizedError("AUTH_UNAUTHORIZED"));
      return;
    }
    if (!req.admin.permissions.includes(permission)) {
      // No generic "forbidden" key in @aimess/constants (shared pkg is not ours
      // to modify); pass a readable message that doubles as the fallback.
      next(new ForbiddenError("Insufficient permissions"));
      return;
    }
    next();
  };
}
