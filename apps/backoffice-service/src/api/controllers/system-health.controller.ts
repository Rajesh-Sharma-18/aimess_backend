import type { RequestHandler } from "express";
import { HTTP_STATUS } from "@aimess/constants";

import { systemHealthService } from "../../services/index.js";

/**
 * GET /v1/system-health — live System Health dashboard: overall status,
 * services-up tally, per-service health, and infrastructure health. The service
 * never throws on a down dependency, so a partial outage returns 200 with the
 * affected components marked `down`/`degraded`.
 */
export const getSystemHealth: RequestHandler = (_req, res, next) => {
  void (async () => {
    try {
      const data = await systemHealthService.getSystemHealth();
      res.status(HTTP_STATUS.OK).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  })();
};
