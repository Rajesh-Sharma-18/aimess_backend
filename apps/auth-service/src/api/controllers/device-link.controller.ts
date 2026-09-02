import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type {
  InitiateDeviceLinkInput,
  ScanDeviceLinkInput,
  DeviceLinkResultInput,
} from "../validators/device-link.validator.js";
import { setRefreshCookie } from "../../lib/auth-cookie.js";
import { deviceLinkService } from "../../services/device-link.service.js";

export const initiateDeviceLink = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body as InitiateDeviceLinkInput;
    const result = await deviceLinkService.initiate(req, body);

    return res
      .status(HTTP_STATUS.CREATED)
      .json(
        new ApiResponse(result, t("AUTH_DEVICE_LINK_INITIATED", req.locale))
      );
  }
);

/**
 * Browser-side pull of a QR outcome. Always 200 — a still-PENDING or already-
 * expired QR is a normal poll answer, not an error, and must not be surfaced to
 * the waiting browser as a failure.
 */
export const getDeviceLinkResult = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body as DeviceLinkResultInput;
    const result = await deviceLinkService.result(body);

    // The waiting BROWSER is the caller here, so hand it the same httpOnly
    // cookie a password login gets. Session cookie: a QR login has no
    // remember-me choice. The token stays in the body too - the poller needs
    // the access token from the same envelope.
    if (result.session?.refreshToken) {
      setRefreshCookie(res, result.session.refreshToken);
    }

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("AUTH_DEVICE_LINK_STATUS", req.locale)));
  }
);

/** Telegram-style: scanning the QR IS logging in — no confirmation step. */
export const scanDeviceLink = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body as ScanDeviceLinkInput;
    const result = await deviceLinkService.login(req, req.auth.userId, body);

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("AUTH_DEVICE_LINK_APPROVED", req.locale))
      );
  }
);
