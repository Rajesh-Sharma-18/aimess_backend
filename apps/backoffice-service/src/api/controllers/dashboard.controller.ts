import type { RequestHandler } from "express";

import { dashboardService } from "../../services/index.js";
import type { DashboardQueryInput } from "../validators/index.js";

/**
 * GET /v1/dashboard/stats — the entire dashboard in one call: stat cards,
 * active-vs-churned chart (filtered by `?period=daily|weekly|monthly`),
 * communities/groups donut, and the service-status panel.
 */
export const getDashboard: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const { period } = req.query as unknown as DashboardQueryInput;
      const data = await dashboardService.getDashboard(period);
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  })();
};
