import { Router, type IRouter } from "express";

import {
  getDeviceLinkResult,
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
  deviceLinkResultSchema,
  initiateDeviceLinkSchema,
  scanDeviceLinkSchema,
} from "../validators/device-link.validator.js";

export const deviceLinkRoutes: IRouter = Router();

/** New device starts a link session and renders it as a QR. No auth. */
deviceLinkRoutes.post(
  "/devices/link/initiate",
  validateBody(initiateDeviceLinkSchema),
  initiateDeviceLink
);

/**
 * The waiting browser pulls its own QR's outcome. No auth — the browser has no
 * session yet, and the linkToken it generated is the credential. This is the
 * delivery path that does not depend on a live socket: it collects the same
 * one-shot success envelope `auth:qr:success` carries, so a missed, delayed, or
 * impossible push no longer strands a login the phone already completed.
 */
deviceLinkRoutes.post(
  "/devices/link/result",
  qrGenerationRateLimiter,
  validateBody(deviceLinkResultSchema),
  getDeviceLinkResult
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
