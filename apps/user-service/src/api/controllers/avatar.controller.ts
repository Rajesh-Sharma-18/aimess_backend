import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type { AvatarUploadUrlInput } from "../validators/avatar.validator.js";
import { avatarService } from "../../services/avatar.service.js";
import type { AllowedAvatarContentType } from "../../lib/avatar-storage.js";

export const createAvatarUploadUrl = asyncHandler(
  async (req: Request, res: Response) => {
    const { contentType, contentLength } = req.body as AvatarUploadUrlInput;

    const result = await avatarService.createUploadUrl({
      userId: req.auth.userId,
      contentType: contentType as AllowedAvatarContentType,
      contentLength,
    });

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("USER_AVATAR_UPLOAD_URL_CREATED", req.locale))
      );
  }
);
