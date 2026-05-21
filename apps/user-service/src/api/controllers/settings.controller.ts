import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type { UpdateSettingsInput } from "../validators/settings.validator.js";
import { userSettingsService } from "../../services/user-settings.service.js";

export const getMySettings = asyncHandler(
  async (req: Request, res: Response) => {
    const settings = await userSettingsService.getMySettings(req.auth.userId);

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(settings, t("USER_SETTINGS_FETCHED", req.locale)));
  }
);

export const updateMySettings = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body as UpdateSettingsInput;

    const settings = await userSettingsService.updateMySettings(
      req.auth.userId,
      body
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(settings, t("USER_SETTINGS_UPDATED", req.locale)));
  }
);
