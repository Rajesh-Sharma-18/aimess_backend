import { Router, type IRouter } from "express";

import {
  approveDeviceLink,
  getDeviceLinkPendingDetails,
  getDeviceLinkStatus,
  initiateDeviceLink,
  rejectDeviceLink,
  scanDeviceLink,
} from "../controllers/device-link.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import {
  qrGenerationRateLimiter,
  qrScanRateLimiter,
} from "../../middleware/rate-limiters.js";
import { validateParams } from "../../middleware/validate-params.js";
import { validateQuery } from "../../middleware/validate-query.js";
import {
  approveDeviceLinkSchema,
  deviceLinkStatusQuerySchema,
  initiateDeviceLinkSchema,
  linkTokenParamsSchema,
  rejectDeviceLinkSchema,
  scanDeviceLinkSchema,
} from "../validators/device-link.validator.js";

export const deviceLinkRoutes: IRouter = Router();

/** New device starts a link session and begins polling. No auth. */
deviceLinkRoutes.post(
  "/devices/link/initiate",
  qrGenerationRateLimiter,
  validateBody(initiateDeviceLinkSchema),
  initiateDeviceLink
);

/** New device polls for approval + collects its tokens once. No auth. */
deviceLinkRoutes.get(
  "/devices/link/status",
  validateQuery(deviceLinkStatusQuerySchema),
  getDeviceLinkStatus
);

/** Any authenticated user may preview a pending QR before scanning/approving it. */
deviceLinkRoutes.get(
  "/devices/link/:linkToken",
  authenticateAccessToken,
  validateParams(linkTokenParamsSchema),
  getDeviceLinkPendingDetails
);

/** Already-signed-in device scans the QR — flips PENDING → SCANNED. */
deviceLinkRoutes.post(
  "/devices/link/scan",
  authenticateAccessToken,
  qrScanRateLimiter,
  validateBody(scanDeviceLinkSchema),
  scanDeviceLink
);

/** Scanning device approves the link it already scanned. */
deviceLinkRoutes.post(
  "/devices/link/approve",
  authenticateAccessToken,
  validateBody(approveDeviceLinkSchema),
  approveDeviceLink
);

/** Scanning device declines the link it already scanned. */
deviceLinkRoutes.post(
  "/devices/link/reject",
  authenticateAccessToken,
  validateBody(rejectDeviceLinkSchema),
  rejectDeviceLink
);
