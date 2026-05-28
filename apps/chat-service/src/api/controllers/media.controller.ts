import type { Request, Response } from "express";
import { z } from "zod/v4";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { BadRequestError } from "@aimess/errors";
import { HTTP_STATUS } from "@aimess/constants";
import {
  createPresignedUploadUrl,
  createPresignedViewUrl,
  buildObjectKey,
} from "@aimess/storage";
import { presignClient } from "../../config/storage.js";
import { env } from "../../config/env.js";
import { UPLOAD_TYPES } from "../../config/uploads.js";

const CHAT = UPLOAD_TYPES.CHAT_ATTACHMENT;

const uploadUrlSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.enum(Object.keys(CHAT.allowedMime) as [string, ...string[]]),
});

const downloadUrlSchema = z.object({
  objectKey: z.string().min(1).max(500),
});

export class MediaController {
  getUploadUrl = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;

    const parsed = uploadUrlSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError("CHAT_UPLOAD_REQUEST_INVALID");
    }

    const { filename, contentType } = parsed.data;
    const ext = filename.includes(".") ? filename.split(".").pop()! : "bin";

    const objectKey = buildObjectKey({
      prefix: CHAT.keyPrefix,
      ownerId: userId,
      ext,
    });

    const uploadUrl = await createPresignedUploadUrl({
      client: presignClient,
      bucket: CHAT.bucket,
      objectKey,
      contentType,
      expiresIn: env.MINIO_PRESIGN_EXPIRES_IN,
    });

    res.status(HTTP_STATUS.OK).json(
      new ApiResponse({
        objectKey,
        uploadUrl,
        contentType,
      })
    );
  });

  getDownloadUrl = asyncHandler(async (req: Request, res: Response) => {
    const parsed = downloadUrlSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError("CHAT_DOWNLOAD_REQUEST_INVALID");
    }

    const { objectKey } = parsed.data;
    if (!objectKey.startsWith(`${CHAT.keyPrefix}/`)) {
      throw new BadRequestError("CHAT_INVALID_OBJECT_KEY");
    }

    const downloadUrl = await createPresignedViewUrl({
      client: presignClient,
      bucket: CHAT.bucket,
      objectKey,
      expiresIn: env.MINIO_VIEW_EXPIRES_IN,
    });

    res.status(HTTP_STATUS.OK).json(
      new ApiResponse({
        objectKey,
        downloadUrl,
      })
    );
  });
}
