import { Router, type IRouter } from "express";

import { mediaController } from "../controllers/media.controller.js";
import { authenticateAccessToken } from "../../middleware/authenticate.js";
import {
  mediaGifRateLimiter,
  mediaRateLimiter,
  mediaScanStatusRateLimiter,
} from "../../middleware/rate-limiter.js";

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

  // No rate limiter: download-url issuance must never fail a legitimate
  // client with 429 (a chat/media-heavy view can fire many of these in a
  // burst). Upload and confirm keep mediaRateLimiter; scan-status has its own.
  router.post(
    "/download-url",
    authenticateAccessToken,
    mediaController.getDownloadUrl
  );

  // Poll async AV scan status. GET /media/scan-status?objectKey=...&category=...
  //
  // Its OWN bucket, not the write one. Poll volume is a property of how long
  // the scan takes, not of what the user did: confirm answers PENDING and the
  // client then polls that object repeatedly, for every item in a batch. A
  // single album could spend the whole write budget on scans and get the NEXT
  // upload thrown out with 429. See mediaScanStatusRateLimiter.
  router.get(
    "/scan-status",
    authenticateAccessToken,
    mediaScanStatusRateLimiter,
    mediaController.getScanStatus
  );

  // The caller's own upload-byte totals for the current calendar month.
  // GET /media/usage/me — no params, no by-id variant: usage is private.
  router.get(
    "/usage/me",
    authenticateAccessToken,
    mediaRateLimiter,
    mediaController.getDataUsage
  );

  router.get(
    "/gifs",
    authenticateAccessToken,
    mediaGifRateLimiter,
    mediaController.getGifs
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
