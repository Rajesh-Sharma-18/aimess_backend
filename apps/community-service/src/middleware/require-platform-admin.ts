import { ForbiddenError } from "@aimess/errors";
import type { RequestHandler } from "express";

/**
 * Route guard: only a platform admin (GlobalRole ADMIN, carried on the access
 * token) may proceed. Must run AFTER `authenticateAccessToken`, which sets
 * `req.auth`. Any non-admin (or missing role) is rejected with 403.
 */
export const requirePlatformAdmin: RequestHandler = (req, _res, next) => {
  if (req.auth?.role !== "ADMIN") {
    next(new ForbiddenError("PLATFORM_ADMIN_REQUIRED"));
    return;
  }
  next();
};
