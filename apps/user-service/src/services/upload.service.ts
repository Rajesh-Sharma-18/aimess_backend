import {
  buildUploadMediaObject,
  createUploadUrl,
  StorageValidationError,
} from "@aimess/storage";
import type { MediaObject } from "@aimess/shared-types";
import { BadRequestError, UnsupportedMediaTypeError } from "@aimess/errors";

import { presignClient } from "../config/storage.js";
import { UPLOAD_TYPES, type UploadType } from "../config/uploads.js";
import { env } from "../config/env.js";

export type CreateUploadUrlParams = {
  type: UploadType;
  contentType: string;
  contentLength: number;
  ownerId: string;
};

export type CreateUploadUrlResult = {
  uploadUrl: string;
  objectKey: string;
  uploadExpiresIn: number;
  maxBytes: number;
  headers: { "Content-Type": string };
  media: MediaObject;
};

export const uploadService = {
  async createUploadUrl(
    params: CreateUploadUrlParams
  ): Promise<CreateUploadUrlResult> {
    try {
      const result = await createUploadUrl({
        client: presignClient,
        def: UPLOAD_TYPES[params.type],
        contentType: params.contentType,
        contentLength: params.contentLength,
        ownerId: params.ownerId,
        expiresIn: env.MINIO_PRESIGN_EXPIRES_IN,
      });
      return {
        ...result,
        media: buildUploadMediaObject({
          result,
          contentType: params.contentType,
        }),
      };
    } catch (error) {
      if (error instanceof StorageValidationError) {
        switch (error.code) {
          case "UNSUPPORTED_CONTENT_TYPE":
            throw new UnsupportedMediaTypeError(
              "UPLOAD_UNSUPPORTED_CONTENT_TYPE"
            );
          case "FILE_TOO_LARGE":
            throw new BadRequestError("UPLOAD_FILE_TOO_LARGE");
          case "FILE_EMPTY":
            throw new BadRequestError("UPLOAD_FILE_EMPTY");
        }
      }
      throw error;
    }
  },
};
