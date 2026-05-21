import {
  assertObjectKeyOwnedBy,
  createPresignedViewUrl,
  deleteObject,
  headObject,
} from "@aimess/storage";
import { BadRequestError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import { storageClient } from "../config/storage.js";
import { parseAvatarObjectKeyFromStored } from "../lib/avatar-storage.js";
import { env } from "../config/env.js";

const AVATAR_BUCKET = env.MINIO_BUCKET_AVATARS;
const AVATAR_KEY_PREFIX = "avatars";

export type AvatarViewUrl = {
  url: string;
  expiresIn: number;
};

export class AvatarService {
  /** Validates upload; returns object key to persist (never a public URL). */
  async resolveAvatarObjectKeyForProfile(
    userId: string,
    avatarObjectKey: string
  ): Promise<string> {
    if (!assertObjectKeyOwnedBy(avatarObjectKey, AVATAR_KEY_PREFIX, userId)) {
      throw new BadRequestError("INVALID_AVATAR_OBJECT_KEY");
    }

    const head = await headObject(
      storageClient,
      AVATAR_BUCKET,
      avatarObjectKey
    );
    if (!head.exists || head.contentLength === undefined) {
      throw new BadRequestError("AVATAR_NOT_UPLOADED");
    }

    if (head.contentLength > env.AVATAR_MAX_UPLOAD_BYTES) {
      await deleteObject(storageClient, AVATAR_BUCKET, avatarObjectKey);
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
      const head = await headObject(storageClient, AVATAR_BUCKET, objectKey);
      if (!head.exists) {
        return null;
      }

      const expiresIn = env.MINIO_AVATAR_VIEW_EXPIRES_IN;
      const url = await createPresignedViewUrl({
        client: storageClient,
        bucket: AVATAR_BUCKET,
        objectKey,
        expiresIn,
      });

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
