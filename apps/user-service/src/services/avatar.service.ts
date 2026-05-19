import { BadRequestError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import {
  createAvatarUploadPresignedUrl,
  createAvatarViewUrl,
  deleteAvatarObject,
  getAvatarViewUrlExpiresIn,
  headAvatarObject,
} from "../config/minio.js";
import {
  isAvatarObjectKeyOwnedByUser,
  parseAvatarObjectKeyFromStored,
} from "../lib/avatar-storage.js";
import type { AllowedAvatarContentType } from "../lib/avatar-storage.js";
import { assertAvatarFileSize } from "../lib/media-limits.js";
import { env } from "../config/env.js";

export type AvatarViewUrl = {
  url: string;
  expiresIn: number;
};

export class AvatarService {
  async createUploadUrl(params: {
    userId: string;
    contentType: AllowedAvatarContentType;
    contentLength: number;
  }) {
    try {
      assertAvatarFileSize(params.contentLength);
    } catch {
      throw new BadRequestError("AVATAR_FILE_TOO_LARGE");
    }

    return createAvatarUploadPresignedUrl(params);
  }

  /** Validates upload; returns object key to persist (never a public URL). */
  async resolveAvatarObjectKeyForProfile(
    userId: string,
    avatarObjectKey: string
  ): Promise<string> {
    if (!isAvatarObjectKeyOwnedByUser(avatarObjectKey, userId)) {
      throw new BadRequestError("INVALID_AVATAR_OBJECT_KEY");
    }

    const head = await headAvatarObject(avatarObjectKey);
    if (!head.exists || head.contentLength === undefined) {
      throw new BadRequestError("AVATAR_NOT_UPLOADED");
    }

    if (head.contentLength > env.AVATAR_MAX_UPLOAD_BYTES) {
      await deleteAvatarObject(avatarObjectKey);
      throw new BadRequestError("AVATAR_FILE_TOO_LARGE");
    }

    return avatarObjectKey;
  }

  /** Presigned GET — only way to read avatars (private bucket). */
  async resolveViewUrlForClient(
    stored: string | null | undefined
  ): Promise<AvatarViewUrl | null> {
    const objectKey = parseAvatarObjectKeyFromStored(stored);
    if (!objectKey) {
      return null;
    }

    try {
      const head = await headAvatarObject(objectKey);
      if (!head.exists) {
        return null;
      }

      const expiresIn = getAvatarViewUrlExpiresIn();
      const url = await createAvatarViewUrl(objectKey);

      return { url, expiresIn };
    } catch (error) {
      logger.warn(
        `Avatar view URL skipped for key=${objectKey} (MinIO unavailable or object missing)`
      );
      logger.warn(error);
      return null;
    }
  }
}

export const avatarService = new AvatarService();
