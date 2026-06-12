import type { Request, Response } from "express";
import { asyncHandler, ApiResponse } from "@aimess/utils";
import { BadRequestError } from "@aimess/errors";
import { HTTP_STATUS } from "@aimess/constants";

import {
  uploadUrlSchema,
  downloadUrlSchema,
  cancelUploadSchema,
} from "../validators/media.validator.js";
import { mediaService } from "../../services/media.service.js";

export class MediaController {
  getUploadUrl = asyncHandler(async (req: Request, res: Response) => {
    const parsed = uploadUrlSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError("MEDIA_REQUEST_INVALID");

    const { category, contentType, contentLength, ownerId } = parsed.data;
    const result = await mediaService.generateUploadUrl({
      category,
      contentType,
      contentLength,
      ownerId: ownerId ?? req.auth.userId,
    });

    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
  });

  cancelUpload = asyncHandler(async (req: Request, res: Response) => {
    const parsed = cancelUploadSchema.safeParse({
      ...req.params,
      ...req.query,
    });
    if (!parsed.success) throw new BadRequestError("MEDIA_REQUEST_INVALID");

    await mediaService.cancelUpload({
      objectKey: decodeURIComponent(parsed.data.objectKey),
      category: parsed.data.category,
      requesterId: req.auth.userId,
    });

    res.status(HTTP_STATUS.OK).json(new ApiResponse(null, "Upload cancelled"));
  });

  getDownloadUrl = asyncHandler(async (req: Request, res: Response) => {
    const parsed = downloadUrlSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError("MEDIA_REQUEST_INVALID");

    const { objectKey, category } = parsed.data;
    const result = await mediaService.generateDownloadUrl({
      objectKey,
      category,
      requesterId: req.auth.userId,
    });

    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
  });
}

export const mediaController = new MediaController();
