import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type {
  UpdateSettingsInput,
  FriendIdParam,
  ListCallAllowedFriendsQuery,
} from "../validators/settings.validator.js";
import { userSettingsService } from "../../services/user-settings.service.js";

export const getMySettings = asyncHandler(
  async (req: Request, res: Response) => {
    const settings = await userSettingsService.getMySettings(req.auth.userId);

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(settings, t("USER_SETTINGS_FETCHED", req.locale)));
  }
);

export const listCallAllowedFriends = asyncHandler(
  async (req: Request, res: Response) => {
    const { cursor, limit } =
      req.query as unknown as ListCallAllowedFriendsQuery;

    const result = await userSettingsService.listCallAllowedFriends(
      req.auth.userId,
      { cursor, limit }
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("USER_SETTINGS_FETCHED", req.locale)));
  }
);

export const addCallAllowedFriend = asyncHandler(
  async (req: Request, res: Response) => {
    const { friendId } = req.params as unknown as FriendIdParam;

    await userSettingsService.addCallAllowedFriend(req.auth.userId, friendId);

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(null, t("USER_SETTINGS_UPDATED", req.locale)));
  }
);

export const removeCallAllowedFriend = asyncHandler(
  async (req: Request, res: Response) => {
    const { friendId } = req.params as unknown as FriendIdParam;

    await userSettingsService.removeCallAllowedFriend(
      req.auth.userId,
      friendId
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(null, t("USER_SETTINGS_UPDATED", req.locale)));
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
