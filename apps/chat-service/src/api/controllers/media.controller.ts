import type { Request, Response } from "express";
import { z } from "zod/v4";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { BadRequestError, ForbiddenError } from "@aimess/errors";
import { HTTP_STATUS } from "@aimess/constants";
import type { MediaObject } from "@aimess/shared-types";
import {
  createPresignedUploadUrl,
  createPresignedViewUrl,
  buildObjectKey,
  parseFileMetaFromObjectKey,
  toMediaObject,
  assertObjectKeyOwnedBy,
} from "@aimess/storage";
import { mediaUrlStrategy, presignClient } from "../../config/storage.js";
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

    // Additive nested representation alongside the existing flat fields. Built
    // inline so the existing presign logic above is untouched.
    const { fileId } = parseFileMetaFromObjectKey(objectKey);
    const media: MediaObject = {
      fileId,
      objectKey,
      fileName: filename,
      contentType,
      size: null,
      downloadUrl: null,
      downloadUrlExpiresIn: null,
      uploadUrl,
      uploadUrlExpiresIn: env.MINIO_PRESIGN_EXPIRES_IN,
      uploadHeaders: { "Content-Type": contentType },
    };

    res.status(HTTP_STATUS.OK).json(
      new ApiResponse({
        objectKey,
        uploadUrl,
        contentType,
        media,
      })
    );
  });

  getDownloadUrl = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    // NOTE: per-message-file MediaObject embedding (presigning files on message
    // read, where room participation is enforced) is the deferred follow-up;
    // this endpoint resolves a single key the CALLER OWNS.
    const parsed = downloadUrlSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError("CHAT_DOWNLOAD_REQUEST_INVALID");
    }

    const { objectKey } = parsed.data;
    if (!objectKey.startsWith(`${CHAT.keyPrefix}/`)) {
      throw new BadRequestError("CHAT_INVALID_OBJECT_KEY");
    }
    // IDOR guard: the key embeds the uploader id as `{prefix}/{ownerId}/{file}`.
    // A prefix-only check let any authenticated user presign another user's
    // attachment — require the caller to own the key (AUDIT H7).
    if (!assertObjectKeyOwnedBy(objectKey, CHAT.keyPrefix, userId)) {
      throw new ForbiddenError("CHAT_MEDIA_FORBIDDEN");
    }

    const downloadUrl = await createPresignedViewUrl({
      client: presignClient,
      bucket: CHAT.bucket,
      objectKey,
      expiresIn: env.MINIO_VIEW_EXPIRES_IN,
    });

    // Additive nested representation alongside the existing flat fields.
    const media: MediaObject = await toMediaObject({
      bucket: CHAT.bucket,
      stored: objectKey,
      prefixes: [CHAT.keyPrefix],
      strategy: mediaUrlStrategy,
    });

    res.status(HTTP_STATUS.OK).json(
      new ApiResponse({
        objectKey,
        downloadUrl,
        media,
      })
    );
  });
}
