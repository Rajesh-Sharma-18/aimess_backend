import { Router, type IRouter } from "express";

import { PERMISSIONS } from "../../constants/index.js";
import {
  bulkDismissReports,
  bulkResolveReports,
  dismissReport,
  getReportDetails,
  getReportEvidence,
  getReportHistory,
  getReportRelated,
  listReports,
  listReportUsers,
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
  listReportUsersQuerySchema,
  reportEvidenceQuerySchema,
  reportHistoryQuerySchema,
  reportIdParamSchema,
  reportRelatedQuerySchema,
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
moderationRoutes.get(
  "/reports/:reportId/evidence",
  requirePermission(PERMISSIONS.REPORTS_READ),
  validateParams(reportIdParamSchema),
  validateQuery(reportEvidenceQuerySchema),
  getReportEvidence
);
moderationRoutes.get(
  "/reports/:reportId/history",
  requirePermission(PERMISSIONS.REPORTS_READ),
  validateParams(reportIdParamSchema),
  validateQuery(reportHistoryQuerySchema),
  getReportHistory
);
moderationRoutes.get(
  "/reports/:reportId/related",
  requirePermission(PERMISSIONS.REPORTS_READ),
  validateParams(reportIdParamSchema),
  validateQuery(reportRelatedQuerySchema),
  getReportRelated
);
moderationRoutes.get(
  "/reports/:reportId/users",
  requirePermission(PERMISSIONS.REPORTS_READ),
  validateParams(reportIdParamSchema),
  validateQuery(listReportUsersQuerySchema),
  listReportUsers
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
