import { NotFoundError } from "@aimess/errors";
import type { RequestHandler } from "express";

import { getRequestContext } from "../../lib/request-context.js";
import { buildMeta } from "../../lib/response-meta.js";
import { livestreamService } from "../../services/index.js";
import type {
  ListLivestreamsQuery,
  ListLivestreamReportsQuery,
} from "../../types/livestream.types.js";
import type {
  BulkEndInput,
  BulkReviewReportsInput,
  EndLivestreamInput,
  ListLivestreamReportsQueryInput,
  ListLivestreamsQueryInput,
} from "../validators/index.js";

/** GET /v1/livestreams — paginated, filtered list. */
export const listLivestreams: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const query = req.query as unknown as ListLivestreamsQueryInput;
      const result = await livestreamService.listLivestreams(
        query as ListLivestreamsQuery
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

/** GET /v1/livestreams/:livestreamId — full detail. */
export const getLivestreamDetails: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      // Narrowed by livestreamIdParamSchema on the route.
      const livestreamId = req.params.livestreamId as string;
      const livestream = await livestreamService.getLivestream(livestreamId);
      if (!livestream) throw new NotFoundError("LIVESTREAM_NOT_FOUND");
      res.status(200).json({
        success: true,
        data: livestream,
        meta: buildMeta(req),
      });
    } catch (error) {
      next(error);
    }
  })();
};

/** GET /v1/livestreams/:livestreamId/reports — paginated reports for a stream. */
export const listLivestreamReports: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      // Narrowed by livestreamIdParamSchema on the route.
      const livestreamId = req.params.livestreamId as string;
      const query = req.query as unknown as ListLivestreamReportsQueryInput;
      const result = await livestreamService.listLivestreamReports(
        livestreamId,
        query as ListLivestreamReportsQuery
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

/** POST /v1/livestreams/:livestreamId/end. */
export const endLivestream: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      // Narrowed by livestreamIdParamSchema on the route.
      const livestreamId = req.params.livestreamId as string;
      const body = req.body as EndLivestreamInput;
      const result = await livestreamService.endLivestream(
        livestreamId,
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

/** POST /v1/livestreams/bulk/end — 207 Multi-Status. */
export const bulkEndLivestreams: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const { livestreamIds, ...input } = req.body as BulkEndInput;
      const result = await livestreamService.bulkEnd(
        livestreamIds,
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

/** POST /v1/livestreams/bulk/review-reports — 207 Multi-Status. */
export const bulkReviewLivestreamReports: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const { reportIds, ...input } = req.body as BulkReviewReportsInput;
      const result = await livestreamService.bulkReviewReports(
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
