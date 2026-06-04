import { Router, type IRouter } from "express";

import { PERMISSIONS } from "../../constants/index.js";
import {
  getDashboardOverview,
  getDashboardCharts,
  getDashboardServiceStatus,
} from "../controllers/index.js";
import {
  adminAuth,
  requirePermission,
  validateQuery,
} from "../middleware/index.js";
import { dashboardChartsQuerySchema } from "../validators/index.js";

export const dashboardRoutes: IRouter = Router();

// All dashboard routes require a valid admin bearer + `dashboard.read`.
dashboardRoutes.use(adminAuth);

// Split into three independently-refreshing sections:
//   /overview        → stat cards
//   /charts          → active-vs-churned (?period=...) + communities/groups donut
//   /service-status  → service-status health panel
dashboardRoutes.get(
  "/overview",
  requirePermission(PERMISSIONS.DASHBOARD_READ),
  getDashboardOverview
);
dashboardRoutes.get(
  "/charts",
  requirePermission(PERMISSIONS.DASHBOARD_READ),
  validateQuery(dashboardChartsQuerySchema),
  getDashboardCharts
);
dashboardRoutes.get(
  "/service-status",
  requirePermission(PERMISSIONS.DASHBOARD_READ),
  getDashboardServiceStatus
);
