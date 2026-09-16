import { Router, type IRouter } from "express";

import { PERMISSIONS } from "../../constants/index.js";
import {
  getSystemHealth,
  listServiceRestarts,
  restartService,
} from "../controllers/index.js";
import {
  adminAuth,
  requirePermission,
  validateParams,
} from "../middleware/index.js";
import { serviceRestartParamsSchema } from "../validators/index.js";

/**
 * System Health admin API — self-prefixed `/system-health` so it resolves at
 * `/v1/system-health`, matching the documented gateway path
 * `/admin/v1/system-health` (the gateway strips `/admin` and forwards `/v1/*`
 * verbatim). Read-only; every request needs a valid admin bearer +
 * `systemhealth.read`.
 */
export const systemHealthRoutes: IRouter = Router();

systemHealthRoutes.use(adminAuth);

systemHealthRoutes.get(
  "/system-health",
  requirePermission(PERMISSIONS.SYSTEMHEALTH_READ),
  getSystemHealth
);

// Service restart — an infrastructure action, so SUPER_ADMIN only: it needs
// `settings.manage` (see role-matrix.ts) on top of `systemhealth.read`. The
// service key is allowlisted here, again in the service, and again in the
// restart agent; the request body is never read.
systemHealthRoutes.get(
  "/system-health/restarts",
  requirePermission(PERMISSIONS.SYSTEMHEALTH_READ),
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  listServiceRestarts
);
systemHealthRoutes.post(
  "/system-health/services/:serviceKey/restart",
  requirePermission(PERMISSIONS.SYSTEMHEALTH_READ),
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  validateParams(serviceRestartParamsSchema),
  restartService
);
