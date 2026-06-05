import type { RequestHandler } from "express";

import { dashboardService } from "../../services/index.js";
import type { DashboardChartsQueryInput } from "../validators/index.js";
import { HTTP_STATUS } from "@aimess/constants";

/**
 * GET /v1/dashboard/overview — stat cards only (users/active/communities/
 * groups), live gRPC-aggregated with 0 fallback on upstream failure.
 */
export const getDashboardOverview: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const data = await dashboardService.getOverview();
      res.status(HTTP_STATUS.OK).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * GET /v1/dashboard/charts — active-vs-churned series (filtered by
 * `?period=daily|weekly|monthly`) + communities/groups donut.
 */
export const getDashboardCharts: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const { period } = req.query as unknown as DashboardChartsQueryInput;
      const data = await dashboardService.getCharts(period);
      res.status(HTTP_STATUS.OK).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * GET /v1/dashboard/service-status — opossum-derived per-service health panel.
 */
export const getDashboardServiceStatus: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const data = await dashboardService.getServiceStatus();
      res.status(HTTP_STATUS.OK).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  })();
};
