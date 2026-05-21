import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type {
  ApproveDeviceLinkInput,
  DeviceLinkStatusQuery,
  InitiateDeviceLinkInput,
} from "../validators/device-link.validator.js";
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

export const getDeviceLinkStatus = asyncHandler(
  async (req: Request, res: Response) => {
    const { linkToken, pollSecret } =
      req.query as unknown as DeviceLinkStatusQuery;
    const result = await deviceLinkService.getStatus(linkToken, pollSecret);

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("AUTH_DEVICE_LINK_STATUS", req.locale)));
  }
);

export const approveDeviceLink = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body as ApproveDeviceLinkInput;
    const result = await deviceLinkService.approve(req, req.auth.userId, body);

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("AUTH_DEVICE_LINK_APPROVED", req.locale))
      );
  }
);
