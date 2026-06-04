import { Router, type IRouter } from "express";

import { PERMISSIONS } from "../../constants/index.js";
import { getDashboard } from "../controllers/index.js";
import {
  adminAuth,
  requirePermission,
  validateQuery,
} from "../middleware/index.js";
import { dashboardQuerySchema } from "../validators/index.js";

export const dashboardRoutes: IRouter = Router();

// All dashboard routes require a valid admin bearer + `dashboard.read`.
dashboardRoutes.use(adminAuth);

// Single merged endpoint: stat cards + active-vs-churned (?period=...) +
// communities/groups donut + service-status, in one response.
dashboardRoutes.get(
  "/stats",
  requirePermission(PERMISSIONS.DASHBOARD_READ),
  validateQuery(dashboardQuerySchema),
  getDashboard
);
