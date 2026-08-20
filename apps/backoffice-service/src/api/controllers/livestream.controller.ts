import { NotFoundError, BadRequestError } from "@aimess/errors";
import { StorageValidationError } from "@aimess/storage";
import type { RequestHandler } from "express";
import { ApiResponse } from "@aimess/utils";

import { getRequestContext } from "../../lib/request-context.js";
import { livestreamService, thumbnailService } from "../../services/index.js";
import { apiResponseWith, paginated } from "../lib/respond.js";
import type {
  ListLivestreamsQuery,
  ListLivestreamCommentsQuery,
  ListLivestreamReportsQuery,
  ListLivestreamUsersQuery,
} from "../../types/livestream.types.js";
import type {
  BulkEndInput,
  BulkReviewReportsInput,
  EndLivestreamInput,
  ListLivestreamCommentsQueryInput,
  ListLivestreamReportsQueryInput,
  ListLivestreamUsersQueryInput,
  ListLivestreamsQueryInput,
  ThumbnailPresignInput,
  ThumbnailSaveInput,
} from "../validators/index.js";
import { HTTP_STATUS, t } from "@aimess/constants";

/** GET /v1/livestreams — paginated, filtered list. */
export const listLivestreams: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const query = req.query as unknown as ListLivestreamsQueryInput;
      const result = await livestreamService.listLivestreams(
        query as ListLivestreamsQuery
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          paginated(
            result.data,
            result.pagination,
            t("ADMIN_LIVESTREAMS_FETCHED", req.locale)
          )
        );
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
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(livestream, t("ADMIN_LIVESTREAM_FETCHED", req.locale))
        );
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
      res
        .status(HTTP_STATUS.OK)
        .json(
          paginated(
            result.data,
            result.pagination,
            t("ADMIN_LIVESTREAM_REPORTS_FETCHED", req.locale)
          )
        );
    } catch (error) {
      next(error);
    }
  })();
};

/** GET /v1/livestreams/:livestreamId/users — paginated actual viewers (join/leave/watch-duration history). */
export const listLivestreamUsers: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      // Narrowed by livestreamIdParamSchema on the route.
      const livestreamId = req.params.livestreamId as string;
      const query = req.query as unknown as ListLivestreamUsersQueryInput;
      const result = await livestreamService.listLivestreamUsers(
        livestreamId,
        query as ListLivestreamUsersQuery
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          paginated(
            result.data,
            result.pagination,
            t("ADMIN_LIVESTREAM_VIEWERS_FETCHED", req.locale)
          )
        );
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * GET /v1/livestreams/:livestreamId/comments — cursor page of chat comments,
 * newest-first. Backs the read-only comment feed in the admin monitor; live
 * comments arrive separately over the /admin socket.
 */
export const listLivestreamComments: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      // Narrowed by livestreamIdParamSchema on the route.
      const livestreamId = req.params.livestreamId as string;
      const query = req.query as unknown as ListLivestreamCommentsQueryInput;
      const result = await livestreamService.listLivestreamComments(
        livestreamId,
        query as ListLivestreamCommentsQuery
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          apiResponseWith(
            result.data,
            t("ADMIN_LIVESTREAM_COMMENTS_FETCHED", req.locale),
            { nextCursor: result.nextCursor, hasMore: result.hasMore }
          )
        );
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
      res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse(result, t("ADMIN_LIVESTREAM_ENDED", req.locale)));
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
      res
        .status(207)
        .json(
          new ApiResponse(result, t("ADMIN_LIVESTREAMS_BULK_ENDED", req.locale))
        );
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * POST /v1/livestreams/:livestreamId/thumbnail/presign
 *
 * Returns a presigned PUT URL + objectKey. The admin client PUTs the image
 * directly to MinIO, then calls PATCH .../thumbnail to commit the key.
 */
export const presignThumbnailUpload: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const livestreamId = req.params.livestreamId as string;
      const body = req.body as ThumbnailPresignInput;
      const result = await thumbnailService.presignUpload(livestreamId, {
        contentType: body.contentType,
        contentLength: body.contentLength,
      });
      res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
          {
            uploadUrl: result.uploadUrl,
            objectKey: result.objectKey,
            expiresIn: result.expiresIn,
            maxBytes: result.maxBytes,
            headers: result.headers,
          },
          t("ADMIN_LIVESTREAM_THUMBNAIL_UPLOAD_READY", req.locale)
        )
      );
    } catch (error) {
      if (error instanceof StorageValidationError) {
        return next(new BadRequestError(error.code));
      }
      next(error);
    }
  })();
};

/**
 * PATCH /v1/livestreams/:livestreamId/thumbnail
 *
 * Commits an already-uploaded objectKey to the stream record via gRPC.
 * Audited as LIVESTREAM_THUMBNAIL_UPDATED.
 */
export const saveThumbnail: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const livestreamId = req.params.livestreamId as string;
      const body = req.body as ThumbnailSaveInput;
      await thumbnailService.saveThumbnail(
        livestreamId,
        body.objectKey,
        req.admin!,
        getRequestContext(req)
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            { livestreamId, thumbnail: body.objectKey },
            t("ADMIN_LIVESTREAM_THUMBNAIL_UPDATED", req.locale)
          )
        );
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
      res
        .status(207)
        .json(
          new ApiResponse(
            result,
            t("ADMIN_LIVESTREAM_REPORTS_BULK_REVIEWED", req.locale)
          )
        );
    } catch (error) {
      next(error);
    }
  })();
};
