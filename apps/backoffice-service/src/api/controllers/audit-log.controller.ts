import { NotFoundError } from "@aimess/errors";
import { HTTP_STATUS, t } from "@aimess/constants";
import type { RequestHandler } from "express";
import { ApiResponse } from "@aimess/utils";

import { auditService } from "../../services/index.js";
import { paginated } from "../lib/respond.js";
import type { ListAuditLogsQuery } from "../../types/audit-log.types.js";
import type { ListAuditLogsQueryInput } from "../validators/index.js";

/** GET /v1/audit-logs — paginated, filtered list (newest first). */
export const listAuditLogs: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const query = req.query as unknown as ListAuditLogsQueryInput;
      const result = await auditService.listAuditLogs(
        query as ListAuditLogsQuery
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          paginated(
            result.data,
            result.pagination,
            t("ADMIN_AUDIT_LOGS_FETCHED", req.locale)
          )
        );
    } catch (error) {
      next(error);
    }
  })();
};

/** GET /v1/audit-logs/:auditLogId — full detail. */
export const getAuditLogDetails: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      // Narrowed by auditLogIdParamSchema on the route.
      const auditLogId = req.params.auditLogId as string;
      const auditLog = await auditService.getAuditLog(auditLogId);
      if (!auditLog) throw new NotFoundError("AUDIT_LOG_NOT_FOUND");
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(auditLog, t("ADMIN_AUDIT_LOG_FETCHED", req.locale))
        );
    } catch (error) {
      next(error);
    }
  })();
};
