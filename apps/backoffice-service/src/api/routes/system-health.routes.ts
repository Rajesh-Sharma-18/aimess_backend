import { Router, type IRouter } from "express";

import { PERMISSIONS } from "../../constants/index.js";
import { getSystemHealth } from "../controllers/index.js";
import { adminAuth, requirePermission } from "../middleware/index.js";

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
