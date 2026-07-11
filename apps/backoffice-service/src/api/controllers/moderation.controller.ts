import { NotFoundError } from "@aimess/errors";
import type { RequestHandler } from "express";

import { getRequestContext } from "../../lib/request-context.js";
import { moderationService } from "../../services/index.js";
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
import { HTTP_STATUS } from "@aimess/constants";

/** GET /v1/moderation/reports — paginated, filtered list. */
export const listReports: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const query = req.query as unknown as ListReportsQueryInput;
      const result = await moderationService.listReports(
        query as ListReportsQuery
      );
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
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
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: detail,
      });
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
      res.status(HTTP_STATUS.OK).json({
        success: true,
        message: "Users fetched successfully.",
        data: {
          users: result.items,
          pagination: result.pagination,
        },
      });
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
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: result,
      });
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
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: result,
      });
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
      res.status(207).json({
        success: true,
        data: result,
      });
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
      res.status(207).json({
        success: true,
        data: result,
      });
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
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
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
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
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
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (error) {
      next(error);
    }
  })();
};
