import { Router, type IRouter } from "express";

import { mediaController } from "../controllers/media.controller.js";
import { authenticateAccessToken } from "../../middleware/authenticate.js";
import { mediaRateLimiter } from "../../middleware/rate-limiter.js";

export function createMediaRoutes(): IRouter {
  const router = Router();

  // authenticateAccessToken runs before mediaRateLimiter so the limiter can
  // key off req.auth.userId (per-user buckets) instead of req.ip.
  router.post(
    "/upload-url",
    authenticateAccessToken,
    mediaRateLimiter,
    mediaController.getUploadUrl
  );

  // Called after the client PUT to MinIO. Runs magic-byte + AV scan; the file
  // is only downloadable once this returns scanStatus: "CLEAN".
  router.post(
    "/confirm",
    authenticateAccessToken,
    mediaRateLimiter,
    mediaController.confirmUpload
  );

  router.post(
    "/download-url",
    authenticateAccessToken,
    mediaRateLimiter,
    mediaController.getDownloadUrl
  );

  // Poll async AV scan status. GET /media/scan-status?objectKey=...&category=...
  router.get(
    "/scan-status",
    authenticateAccessToken,
    mediaRateLimiter,
    mediaController.getScanStatus
  );

  // Cancel an in-progress upload and delete the object from storage.
  // DELETE /uploads/:objectKey?category=CHAT_ATTACHMENT
  // objectKey must be URL-encoded if it contains slashes.
  router.delete(
    "/uploads/:objectKey",
    authenticateAccessToken,
    mediaRateLimiter,
    mediaController.cancelUpload
  );

  return router;
}
