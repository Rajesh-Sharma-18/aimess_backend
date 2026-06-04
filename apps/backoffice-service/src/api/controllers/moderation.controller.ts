import { NotFoundError } from "@aimess/errors";
import type { RequestHandler } from "express";

import { getRequestContext } from "../../lib/request-context.js";
import { buildMeta } from "../../lib/response-meta.js";
import { moderationService } from "../../services/index.js";
import type { ListReportsQuery } from "../../types/moderation.types.js";
import type {
  BulkDismissInput,
  BulkResolveInput,
  DismissReportInput,
  ListReportsQueryInput,
  ResolveReportInput,
} from "../validators/index.js";

/** GET /v1/moderation/reports — paginated, filtered list. */
export const listReports: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const query = req.query as unknown as ListReportsQueryInput;
      const result = await moderationService.listReports(
        query as ListReportsQuery
      );
      res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
        meta: buildMeta(req),
      });
    } catch (error) {
      next(error);
    }
  })();
};

/** GET /v1/moderation/reports/:reportId — full detail. */
export const getReportDetails: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      // Narrowed by reportIdParamSchema on the route.
      const reportId = req.params.reportId as string;
      const report = await moderationService.getReport(reportId);
      if (!report) throw new NotFoundError("REPORT_NOT_FOUND");
      res.status(200).json({
        success: true,
        data: report,
        meta: buildMeta(req),
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
      res.status(200).json({
        success: true,
        data: result,
        meta: buildMeta(req),
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
      res.status(200).json({
        success: true,
        data: result,
        meta: buildMeta(req),
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
        meta: buildMeta(req),
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
        meta: buildMeta(req),
      });
    } catch (error) {
      next(error);
    }
  })();
};
