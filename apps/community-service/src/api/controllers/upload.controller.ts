import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type { UploadType } from "../../config/uploads.js";
import { uploadService } from "../../services/upload.service.js";
import type { UploadUrlInput } from "../validators/upload.validator.js";

export const createUploadUrl = asyncHandler(
  async (req: Request, res: Response) => {
    const { type, contentType, contentLength } = req.body as UploadUrlInput;

    const result = await uploadService.createUploadUrl({
      type: type as UploadType,
      contentType,
      contentLength,
      ownerId: req.auth.userId,
    });

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          result,
          t("COMMUNITY_IMAGE_UPLOAD_URL_CREATED", req.locale)
        )
      );
  }
);
