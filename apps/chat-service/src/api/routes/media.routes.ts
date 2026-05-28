import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import { createRateLimit } from "../../middleware/rate-limit.js";
import type { MediaController } from "../controllers/media.controller.js";

const uploadLimit = createRateLimit({
  windowMs: 60_000,
  maxRequests: 30,
  keyPrefix: "media:upload",
});
const downloadLimit = createRateLimit({
  windowMs: 60_000,
  maxRequests: 120,
  keyPrefix: "media:download",
});

export function createMediaRoutes(ctrl: MediaController): Router {
  const router = Router();

  router.post("/upload-url", authenticate, uploadLimit, ctrl.getUploadUrl);
  router.post(
    "/download-url",
    authenticate,
    downloadLimit,
    ctrl.getDownloadUrl
  );

  return router;
}
