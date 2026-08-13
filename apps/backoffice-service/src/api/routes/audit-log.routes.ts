import { Router, type IRouter } from "express";

import { HTTP_STATUS } from "@aimess/constants";
import { USER_AUDIT_ACTIONS } from "@aimess/messaging";

import { AUDIT_ACTIONS, PERMISSIONS } from "../../constants/index.js";
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

// Action catalogue for the FE filter dropdown. MUST be declared before
// `/:auditLogId` or the UUID param validator rejects "actions" with a 400.
auditLogRoutes.get(
  "/audit-logs/actions",
  requirePermission(PERMISSIONS.AUDITLOGS_READ),
  (_req, res) => {
    res.status(HTTP_STATUS.OK).json({
      success: true,
      // Admin-panel actions plus every website action the ingest consumer accepts.
      data: [
        ...Object.values(AUDIT_ACTIONS),
        ...Object.values(USER_AUDIT_ACTIONS),
      ],
    });
  }
);

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
