import { Router, type IRouter } from "express";

import { mediaController } from "../controllers/media.controller.js";
import { authenticateAccessToken } from "../../middleware/authenticate.js";
import { mediaRateLimiter } from "../../middleware/rate-limiter.js";

export function createMediaRoutes(): IRouter {
  const router = Router();

  router.post(
    "/upload-url",
    mediaRateLimiter,
    authenticateAccessToken,
    mediaController.getUploadUrl
  );

  // Called after the client PUT to MinIO. Runs magic-byte + AV scan; the file
  // is only downloadable once this returns scanStatus: "CLEAN".
  router.post(
    "/confirm",
    mediaRateLimiter,
    authenticateAccessToken,
    mediaController.confirmUpload
  );

  router.post(
    "/download-url",
    mediaRateLimiter,
    authenticateAccessToken,
    mediaController.getDownloadUrl
  );

  // Poll async AV scan status. GET /media/scan-status?objectKey=...&category=...
  router.get(
    "/scan-status",
    mediaRateLimiter,
    authenticateAccessToken,
    mediaController.getScanStatus
  );

  // Cancel an in-progress upload and delete the object from storage.
  // DELETE /uploads/:objectKey?category=CHAT_ATTACHMENT
  // objectKey must be URL-encoded if it contains slashes.
  router.delete(
    "/uploads/:objectKey",
    mediaRateLimiter,
    authenticateAccessToken,
    mediaController.cancelUpload
  );

  return router;
}
