import { Router, type IRouter } from "express";

import { PERMISSIONS } from "../../constants/index.js";
import {
  bulkEndLivestreams,
  bulkReviewLivestreamReports,
  endLivestream,
  getLivestreamDetails,
  listLivestreamComments,
  listLivestreamReports,
  listLivestreamUsers,
  listLivestreams,
  presignThumbnailUpload,
  saveThumbnail,
} from "../controllers/index.js";
import {
  adminAuth,
  requirePermission,
  validateBody,
  validateParams,
  validateQuery,
} from "../middleware/index.js";
import {
  bulkEndSchema,
  bulkReviewReportsSchema,
  endLivestreamSchema,
  listLivestreamCommentsQuerySchema,
  listLivestreamReportsQuerySchema,
  listLivestreamUsersQuerySchema,
  listLivestreamsQuerySchema,
  livestreamIdParamSchema,
  thumbnailPresignSchema,
  thumbnailSaveSchema,
} from "../validators/index.js";

/** Livestream Management admin API — self-prefixed with `/livestreams`. */
export const livestreamRoutes: IRouter = Router();

// Every route requires a valid admin bearer.
livestreamRoutes.use(adminAuth);

// Read.
livestreamRoutes.get(
  "/livestreams",
  requirePermission(PERMISSIONS.LIVESTREAMS_READ),
  validateQuery(listLivestreamsQuerySchema),
  listLivestreams
);

// Bulk actions — MUST be declared before the `/:livestreamId/*` routes so
// Express does not capture "bulk" as a livestreamId path param.
livestreamRoutes.post(
  "/livestreams/bulk/end",
  requirePermission(PERMISSIONS.LIVESTREAMS_MODERATE),
  validateBody(bulkEndSchema),
  bulkEndLivestreams
);
livestreamRoutes.post(
  "/livestreams/bulk/review-reports",
  requirePermission(PERMISSIONS.LIVESTREAMS_MODERATE),
  validateBody(bulkReviewReportsSchema),
  bulkReviewLivestreamReports
);

// Single-livestream detail + actions. Detail/viewers/comments/reports now
// require LIVESTREAMS_VIEW so a view-only admin can watch a stream without
// being able to end it. LIVESTREAMS_MODERATE implies LIVESTREAMS_VIEW.
livestreamRoutes.get(
  "/livestreams/:livestreamId",
  requirePermission(PERMISSIONS.LIVESTREAMS_VIEW),
  validateParams(livestreamIdParamSchema),
  getLivestreamDetails
);
livestreamRoutes.get(
  "/livestreams/:livestreamId/reports",
  requirePermission(PERMISSIONS.LIVESTREAMS_VIEW),
  validateParams(livestreamIdParamSchema),
  validateQuery(listLivestreamReportsQuerySchema),
  listLivestreamReports
);
livestreamRoutes.get(
  "/livestreams/:livestreamId/users",
  requirePermission(PERMISSIONS.LIVESTREAMS_VIEW),
  validateParams(livestreamIdParamSchema),
  validateQuery(listLivestreamUsersQuerySchema),
  listLivestreamUsers
);
livestreamRoutes.get(
  "/livestreams/:livestreamId/comments",
  requirePermission(PERMISSIONS.LIVESTREAMS_VIEW),
  validateParams(livestreamIdParamSchema),
  validateQuery(listLivestreamCommentsQuerySchema),
  listLivestreamComments
);
livestreamRoutes.post(
  "/livestreams/:livestreamId/end",
  requirePermission(PERMISSIONS.LIVESTREAMS_MODERATE),
  validateParams(livestreamIdParamSchema),
  validateBody(endLivestreamSchema),
  endLivestream
);

// Thumbnail management — two-step: presign → client PUT to MinIO → confirm.
livestreamRoutes.post(
  "/livestreams/:livestreamId/thumbnail/presign",
  requirePermission(PERMISSIONS.LIVESTREAMS_MODERATE),
  validateParams(livestreamIdParamSchema),
  validateBody(thumbnailPresignSchema),
  presignThumbnailUpload
);
livestreamRoutes.patch(
  "/livestreams/:livestreamId/thumbnail",
  requirePermission(PERMISSIONS.LIVESTREAMS_MODERATE),
  validateParams(livestreamIdParamSchema),
  validateBody(thumbnailSaveSchema),
  saveThumbnail
);
