import { Router, type IRouter } from "express";

import { PERMISSIONS } from "../../constants/index.js";
import { getAuditLogDetails, listAuditLogs } from "../controllers/index.js";
import {
  adminAuth,
  requirePermission,
  validateParams,
  validateQuery,
} from "../middleware/index.js";
import {
  auditLogIdParamSchema,
  listAuditLogsQuerySchema,
} from "../validators/index.js";

/**
 * Audit Logs admin API — self-prefixed `/audit-logs` so it resolves at
 * `/v1/audit-logs/*`, matching the documented gateway path `/admin/v1/audit-logs`
 * (the gateway strips `/admin` and forwards `/v1/*` verbatim). Read-only — the
 * rows are written automatically by every admin module via `auditService.record`.
 */
export const auditLogRoutes: IRouter = Router();

auditLogRoutes.use(adminAuth);

auditLogRoutes.get(
  "/audit-logs",
  requirePermission(PERMISSIONS.AUDITLOGS_READ),
  validateQuery(listAuditLogsQuerySchema),
  listAuditLogs
);
auditLogRoutes.get(
  "/audit-logs/:auditLogId",
  requirePermission(PERMISSIONS.AUDITLOGS_READ),
  validateParams(auditLogIdParamSchema),
  getAuditLogDetails
);
