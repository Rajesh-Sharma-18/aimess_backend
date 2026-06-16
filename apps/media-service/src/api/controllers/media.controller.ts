import type { Request, Response } from "express";
import { asyncHandler, ApiResponse } from "@aimess/utils";
import { BadRequestError } from "@aimess/errors";
import { HTTP_STATUS } from "@aimess/constants";

import {
  uploadUrlSchema,
  downloadUrlSchema,
  cancelUploadSchema,
  confirmUploadSchema,
  scanStatusQuerySchema,
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

  /**
   * POST /media/confirm
   *
   * Called by the client after it has successfully PUT the file to the
   * presigned MinIO URL. Triggers magic-byte validation, ZIP inspection, and
   * antivirus scan. The file is only downloadable once this returns
   * scanStatus: "CLEAN".
   *
   * Safe-serving: sets X-Content-Type-Options on the response (belt + braces
   * for API clients that inadvertently render the JSON body).
   */
  confirmUpload = asyncHandler(async (req: Request, res: Response) => {
    const parsed = confirmUploadSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError("MEDIA_REQUEST_INVALID");

    const { objectKey, category, contentType } = parsed.data;
    const result = await mediaService.confirmUpload({
      objectKey,
      category,
      contentType,
      requesterId: req.auth.userId,
    });

    res.setHeader("X-Content-Type-Options", "nosniff");
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

    // Defence in depth: instruct clients not to MIME-sniff the response.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
  });

  /**
   * GET /media/scan-status?objectKey=...&category=...
   *
   * Polls the async AV scan status for an uploaded object. Returns "PENDING"
   * while the Bull worker scans (or when no status is recorded yet), "CLEAN"
   * once downloadable, "QUARANTINED"/"INFECTED" if rejected.
   */
  getScanStatus = asyncHandler(async (req: Request, res: Response) => {
    const parsed = scanStatusQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new BadRequestError("MEDIA_REQUEST_INVALID");

    const { objectKey, category } = parsed.data;
    const result = await mediaService.getScanStatus({
      objectKey,
      category,
      requesterId: req.auth.userId,
    });

    res.setHeader("X-Content-Type-Options", "nosniff");
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
  });
}

export const mediaController = new MediaController();
