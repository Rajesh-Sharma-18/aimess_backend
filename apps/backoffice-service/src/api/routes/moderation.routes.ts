import { Router, type IRouter } from "express";

import { PERMISSIONS } from "../../constants/index.js";
import {
  bulkDismissReports,
  bulkResolveReports,
  dismissReport,
  getReportDetails,
  listReports,
  resolveReport,
} from "../controllers/index.js";
import {
  adminAuth,
  requirePermission,
  validateBody,
  validateParams,
  validateQuery,
} from "../middleware/index.js";
import {
  bulkDismissSchema,
  bulkResolveSchema,
  dismissReportSchema,
  listReportsQuerySchema,
  reportIdParamSchema,
  resolveReportSchema,
} from "../validators/index.js";

/** Reports & Moderation admin API — mounted at /v1/moderation. */
export const moderationRoutes: IRouter = Router();

// Every route requires a valid admin bearer.
moderationRoutes.use(adminAuth);

// Read.
moderationRoutes.get(
  "/reports",
  requirePermission(PERMISSIONS.REPORTS_READ),
  validateQuery(listReportsQuerySchema),
  listReports
);

// Bulk actions — MUST be declared before the `/:reportId/*` routes so Express
// does not capture "bulk" as a reportId path param.
moderationRoutes.post(
  "/reports/bulk/resolve",
  requirePermission(PERMISSIONS.REPORTS_ACTION),
  validateBody(bulkResolveSchema),
  bulkResolveReports
);
moderationRoutes.post(
  "/reports/bulk/dismiss",
  requirePermission(PERMISSIONS.REPORTS_ACTION),
  validateBody(bulkDismissSchema),
  bulkDismissReports
);

// Single-report detail + actions.
moderationRoutes.get(
  "/reports/:reportId",
  requirePermission(PERMISSIONS.REPORTS_READ),
  validateParams(reportIdParamSchema),
  getReportDetails
);
moderationRoutes.post(
  "/reports/:reportId/resolve",
  requirePermission(PERMISSIONS.REPORTS_ACTION),
  validateParams(reportIdParamSchema),
  validateBody(resolveReportSchema),
  resolveReport
);
moderationRoutes.post(
  "/reports/:reportId/dismiss",
  requirePermission(PERMISSIONS.REPORTS_ACTION),
  validateParams(reportIdParamSchema),
  validateBody(dismissReportSchema),
  dismissReport
);
