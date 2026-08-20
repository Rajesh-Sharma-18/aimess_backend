import { NotFoundError } from "@aimess/errors";
import type { RequestHandler } from "express";
import { ApiResponse } from "@aimess/utils";

import { getRequestContext } from "../../lib/request-context.js";
import { moderationService } from "../../services/index.js";
import { paginated } from "../lib/respond.js";
import type {
  ListReportsQuery,
  ListReportUsersQuery,
} from "../../types/moderation.types.js";
import type {
  BulkDismissInput,
  BulkResolveInput,
  DismissReportInput,
  ListReportsQueryInput,
  ListReportUsersQueryInput,
  ReportEvidenceQueryInput,
  ReportHistoryQueryInput,
  ReportRelatedQueryInput,
  ResolveReportInput,
} from "../validators/index.js";
import { HTTP_STATUS, t } from "@aimess/constants";

/** GET /v1/moderation/reports — paginated, filtered list. */
export const listReports: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const query = req.query as unknown as ListReportsQueryInput;
      const result = await moderationService.listReports(
        query as ListReportsQuery
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          paginated(
            result.data,
            result.pagination,
            t("ADMIN_REPORTS_FETCHED", req.locale)
          )
        );
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * GET /v1/moderation/reports/:reportId — Reports & Moderation Details page:
 * report block + Community Report Details.
 */
export const getReportDetails: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      // Narrowed by reportIdParamSchema on the route.
      const reportId = req.params.reportId as string;
      const detail =
        await moderationService.getReportModerationDetail(reportId);
      if (!detail) throw new NotFoundError("REPORT_NOT_FOUND");
      res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse(detail, t("ADMIN_REPORT_FETCHED", req.locale)));
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * GET /v1/moderation/reports/:reportId/users — paginated users list at the
 * bottom of the Report Details page (community members OR livestream viewers,
 * depending on the report kind).
 */
export const listReportUsers: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      // Narrowed by reportIdParamSchema on the route.
      const reportId = req.params.reportId as string;
      const query = req.query as unknown as ListReportUsersQueryInput;
      const result = await moderationService.listReportUsers(
        reportId,
        query as unknown as ListReportUsersQuery
      );
      if (!result) throw new NotFoundError("REPORT_NOT_FOUND");
      res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
          {
            users: result.items,
            pagination: result.pagination,
          },
          t("ADMIN_REPORT_USERS_FETCHED", req.locale)
        )
      );
    } catch (error) {
      next(error);
    }
  })();
};

/** POST /v1/moderation/reports/:reportId/resolve. */
export const resolveReport: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      // Narrowed by reportIdParamSchema on the route.
      const reportId = req.params.reportId as string;
      const body = req.body as ResolveReportInput;
      const result = await moderationService.resolveReport(
        reportId,
        body,
        req.admin!,
        getRequestContext(req)
      );
      res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse(result, t("ADMIN_REPORT_RESOLVED", req.locale)));
    } catch (error) {
      next(error);
    }
  })();
};

/** POST /v1/moderation/reports/:reportId/dismiss. */
export const dismissReport: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      // Narrowed by reportIdParamSchema on the route.
      const reportId = req.params.reportId as string;
      const body = req.body as DismissReportInput;
      const result = await moderationService.dismissReport(
        reportId,
        body,
        req.admin!,
        getRequestContext(req)
      );
      res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse(result, t("ADMIN_REPORT_DISMISSED", req.locale)));
    } catch (error) {
      next(error);
    }
  })();
};

/** POST /v1/moderation/reports/bulk/resolve — 207 Multi-Status. */
export const bulkResolveReports: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const { reportIds, ...input } = req.body as BulkResolveInput;
      const result = await moderationService.bulkResolve(
        reportIds,
        input,
        req.admin!,
        getRequestContext(req)
      );
      res
        .status(207)
        .json(
          new ApiResponse(result, t("ADMIN_REPORTS_BULK_RESOLVED", req.locale))
        );
    } catch (error) {
      next(error);
    }
  })();
};

/** POST /v1/moderation/reports/bulk/dismiss — 207 Multi-Status. */
export const bulkDismissReports: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const { reportIds, ...input } = req.body as BulkDismissInput;
      const result = await moderationService.bulkDismiss(
        reportIds,
        input,
        req.admin!,
        getRequestContext(req)
      );
      res
        .status(207)
        .json(
          new ApiResponse(result, t("ADMIN_REPORTS_BULK_DISMISSED", req.locale))
        );
    } catch (error) {
      next(error);
    }
  })();
};

/** GET /v1/moderation/reports/:reportId/evidence */
export const getReportEvidence: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const reportId = req.params.reportId as string;
      const query = req.query as unknown as ReportEvidenceQueryInput;
      const result = await moderationService.listReportEvidence(
        reportId,
        query
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          paginated(
            result.data,
            result.pagination,
            t("ADMIN_REPORT_EVIDENCE_FETCHED", req.locale)
          )
        );
    } catch (error) {
      next(error);
    }
  })();
};

/** GET /v1/moderation/reports/:reportId/history */
export const getReportHistory: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const reportId = req.params.reportId as string;
      const query = req.query as unknown as ReportHistoryQueryInput;
      const result = await moderationService.listReportHistory(reportId, query);
      res
        .status(HTTP_STATUS.OK)
        .json(
          paginated(
            result.data,
            result.pagination,
            t("ADMIN_REPORT_HISTORY_FETCHED", req.locale)
          )
        );
    } catch (error) {
      next(error);
    }
  })();
};

/** GET /v1/moderation/reports/:reportId/related */
export const getReportRelated: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const reportId = req.params.reportId as string;
      const query = req.query as unknown as ReportRelatedQueryInput;
      const result = await moderationService.listReportRelated(reportId, query);
      res
        .status(HTTP_STATUS.OK)
        .json(
          paginated(
            result.data,
            result.pagination,
            t("ADMIN_REPORT_RELATED_FETCHED", req.locale)
          )
        );
    } catch (error) {
      next(error);
    }
  })();
};
