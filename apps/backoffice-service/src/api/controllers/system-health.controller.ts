import type { RequestHandler } from "express";
import { ApiResponse } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";

import { systemHealthService } from "../../services/index.js";

/**
 * GET /v1/system-health — live System Health dashboard: overall status,
 * services-up tally, per-service health, and infrastructure health. The service
 * never throws on a down dependency, so a partial outage returns 200 with the
 * affected components marked `down`/`degraded`.
 */
export const getSystemHealth: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const data = await systemHealthService.getSystemHealth();
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(data, t("ADMIN_SYSTEM_HEALTH_FETCHED", req.locale))
        );
    } catch (error) {
      next(error);
    }
  })();
};
