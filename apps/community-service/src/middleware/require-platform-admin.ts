import { ForbiddenError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import type { RequestHandler } from "express";

/**
 * Route guard: only a platform admin (GlobalRole ADMIN, carried on the access
 * token) may proceed. Must run AFTER `authenticateAccessToken`, which sets
 * `req.auth`. Any non-admin (or missing role) is rejected with 403.
 */
export const requirePlatformAdmin: RequestHandler = (req, _res, next) => {
  // TEMPORARY DEBUG — remove once the `/categories/admin` 401 investigation
  // is closed.
  logger.debug("[auth-debug] requirePlatformAdmin", {
    path: req.originalUrl,
    reqAuthPresent: !!req.auth,
    role: req.auth?.role,
  });

  if (req.auth?.role !== "ADMIN") {
    next(new ForbiddenError("PLATFORM_ADMIN_REQUIRED"));
    return;
  }
  next();
};
