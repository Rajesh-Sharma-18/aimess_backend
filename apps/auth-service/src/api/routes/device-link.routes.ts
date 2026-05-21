import { Router, type IRouter } from "express";

import {
  approveDeviceLink,
  getDeviceLinkStatus,
  initiateDeviceLink,
} from "../controllers/device-link.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import { validateQuery } from "../../middleware/validate-query.js";
import {
  approveDeviceLinkSchema,
  deviceLinkStatusQuerySchema,
  initiateDeviceLinkSchema,
} from "../validators/device-link.validator.js";

export const deviceLinkRoutes: IRouter = Router();

/** New device starts a link session and begins polling. No auth. */
deviceLinkRoutes.post(
  "/devices/link/initiate",
  validateBody(initiateDeviceLinkSchema),
  initiateDeviceLink
);

/** New device polls for approval + collects its tokens once. No auth. */
deviceLinkRoutes.get(
  "/devices/link/status",
  validateQuery(deviceLinkStatusQuerySchema),
  getDeviceLinkStatus
);

/** Already-signed-in device approves the link (scanned the QR). */
deviceLinkRoutes.post(
  "/devices/link/approve",
  authenticateAccessToken,
  validateBody(approveDeviceLinkSchema),
  approveDeviceLink
);
