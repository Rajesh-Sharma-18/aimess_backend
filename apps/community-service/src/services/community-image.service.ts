import {
  assertObjectKeyOwnedBy,
  createPresignedViewUrl,
  deleteObject,
  headObject,
} from "@aimess/storage";
import { BadRequestError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import { storageClient } from "../config/storage.js";
import { env } from "../config/env.js";
import { parseCommunityImageObjectKeyFromStored } from "../lib/community-image-storage.js";
import type { CommunityImageView } from "../types/community.types.js";

const COMMUNITY_BUCKET = env.MINIO_BUCKET_COMMUNITY;
const COMMUNITY_AVATAR_PREFIX = "community/avatar";

export class CommunityImageService {
  /** Validates upload ownership + existence; returns object key to persist. */
  async resolveObjectKeyForCommunity(
    userId: string,
    objectKey: string
  ): Promise<string> {
    if (!assertObjectKeyOwnedBy(objectKey, COMMUNITY_AVATAR_PREFIX, userId)) {
      throw new BadRequestError("COMMUNITY_IMAGE_INVALID_OBJECT_KEY");
    }

    const head = await headObject(storageClient, COMMUNITY_BUCKET, objectKey);
    if (!head.exists || head.contentLength === undefined) {
      throw new BadRequestError("COMMUNITY_IMAGE_NOT_UPLOADED");
    }

    if (head.contentLength > env.COMMUNITY_IMAGE_MAX_UPLOAD_BYTES) {
      await deleteObject(storageClient, COMMUNITY_BUCKET, objectKey);
      throw new BadRequestError("COMMUNITY_IMAGE_FILE_TOO_LARGE");
    }

    return objectKey;
  }

  /** Presigned GET — only way to read community images (private bucket). */
  async resolveViewUrlForClient(
    stored: string | null | undefined
  ): Promise<CommunityImageView | null> {
    const objectKey = parseCommunityImageObjectKeyFromStored(stored);
    if (!objectKey) {
      return null;
    }

    try {
      const head = await headObject(storageClient, COMMUNITY_BUCKET, objectKey);
      if (!head.exists) {
        return null;
      }

      const expiresIn = env.MINIO_IMAGE_VIEW_EXPIRES_IN;
      const url = await createPresignedViewUrl({
        client: storageClient,
        bucket: COMMUNITY_BUCKET,
        objectKey,
        expiresIn,
      });

      return { url, expiresIn };
    } catch (error) {
      logger.warn(
        `Community image view URL skipped for key=${objectKey} (MinIO unavailable or object missing)`
      );
      logger.warn(error);
      return null;
    }
  }
}

export const communityImageService = new CommunityImageService();
