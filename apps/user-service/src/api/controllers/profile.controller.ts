import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type { UpdateProfileInput } from "../validators/profile.validator.js";
import { extractBearerToken } from "../../lib/extract-bearer-token.js";
import { userProfileService } from "../../services/user-profile.service.js";

export const getMyProfile = asyncHandler(
  async (req: Request, res: Response) => {
    console.log("Fetching profile for user:", req.auth.userId);
    const profile = await userProfileService.getMyProfile(
      req.auth.userId,
      extractBearerToken(req)
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(profile, t("USER_PROFILE_FETCHED", req.locale)));
  }
);

export const updateProfile = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body as UpdateProfileInput;

    const profile = await userProfileService.updateProfile(
      req.auth.userId,
      extractBearerToken(req),
      body
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(profile, t("USER_PROFILE_UPDATED", req.locale)));
  }
);
