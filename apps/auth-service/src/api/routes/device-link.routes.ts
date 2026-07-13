import { Router, type IRouter } from "express";

import {
  initiateDeviceLink,
  scanDeviceLink,
} from "../controllers/device-link.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import {
  qrGenerationRateLimiter,
  qrScanRateLimiter,
} from "../../middleware/rate-limiters.js";
import {
  initiateDeviceLinkSchema,
  scanDeviceLinkSchema,
} from "../validators/device-link.validator.js";

export const deviceLinkRoutes: IRouter = Router();

/** New device starts a link session and renders it as a QR. No auth. */
deviceLinkRoutes.post(
  "/devices/link/initiate",
  qrGenerationRateLimiter,
  validateBody(initiateDeviceLinkSchema),
  initiateDeviceLink
);

/**
 * Already-signed-in device scans the QR — validates it, immediately issues a
 * NEW web session/tokens, marks the QR USED, and pushes `auth:qr:success` to
 * the browser. Telegram-style: scan IS login, no approve/reject step.
 */
deviceLinkRoutes.post(
  "/devices/link/scan",
  authenticateAccessToken,
  qrScanRateLimiter,
  validateBody(scanDeviceLinkSchema),
  scanDeviceLink
);
