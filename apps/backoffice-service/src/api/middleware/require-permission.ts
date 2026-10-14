import { ForbiddenError, UnauthorizedError } from "@aimess/errors";
import type { RequestHandler } from "express";

import type { PermissionKey } from "../../constants/index.js";

/**
 * RBAC gate — requires `req.admin` (set by `adminAuth`) to carry `permission`
 * (any one of them when several are given). Must be mounted AFTER `adminAuth`.
 */
export function requirePermission(
  ...permissions: [PermissionKey, ...PermissionKey[]]
): RequestHandler {
  return (req, _res, next) => {
    if (!req.admin) {
      next(new UnauthorizedError("AUTH_UNAUTHORIZED"));
      return;
    }
    if (!permissions.some((key) => req.admin!.permissions.includes(key))) {
      next(new ForbiddenError("ADMIN_FORBIDDEN"));
      return;
    }
    next();
  };
}
