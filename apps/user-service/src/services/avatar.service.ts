import {
  assertObjectKeyOwnedBy,
  createPresignedViewUrl,
  deleteObject,
  headObject,
  parseObjectKeyFromStored,
} from "@aimess/storage";
import { BadRequestError, ServiceUnavailableError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import { presignClient, storageClient } from "../config/storage.js";
import { env } from "../config/env.js";
import { getMediaVerifyClient } from "../grpc/media.client.js";

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
      // A failed delete must not be silent — the oversize object stays in the
      // bucket and nothing else will ever clean it up.
      try {
        await deleteObject(storageClient, AVATAR_BUCKET, avatarObjectKey);
      } catch (err) {
        logger.error("avatar: FAILED to delete oversize object", {
          severity: "critical",
          event: "media.cleanup_failed",
          objectKey: avatarObjectKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw new BadRequestError("AVATAR_FILE_TOO_LARGE");
    }

    // The object must have PASSED media-service's security pipeline. Existence +
    // size + key ownership say nothing about the bytes: `/media/confirm` is
    // client-driven, so a client that simply never calls it produced an
    // unscanned avatar that this service then presigned for every viewer.
    await this.assertAvatarVerified(userId, avatarObjectKey);

    return avatarObjectKey;
  }

  /**
   * Reject an avatar object that media-service has not cleared.
   *
   * Fail-closed on transport failure: 503 (retryable), never "assume clean".
   */
  private async assertAvatarVerified(
    userId: string,
    avatarObjectKey: string
  ): Promise<void> {
    if (!env.AVATAR_MEDIA_VERIFY_ENABLED) return;

    let verdict;
    try {
      verdict = await getMediaVerifyClient().checkOne(avatarObjectKey);
    } catch (err) {
      logger.warn("avatar: media-service unreachable — refusing to persist", {
        objectKey: avatarObjectKey,
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new ServiceUnavailableError("MEDIA_REGISTRY_UNAVAILABLE");
    }

    if (!verdict?.scanStatus) {
      logger.warn("media-security", {
        event: "media.attachment_unverified",
        reason: "unknown",
        objectKey: avatarObjectKey,
        userId,
      });
      throw new BadRequestError("MEDIA_NOT_VERIFIED");
    }
    if (!verdict.downloadable) {
      logger.warn("media-security", {
        event: "media.attachment_unverified",
        reason: verdict.scanStatus,
        objectKey: avatarObjectKey,
        userId,
      });
      throw new BadRequestError(
        verdict.scanStatus === "INFECTED" ||
          verdict.scanStatus === "QUARANTINED"
          ? "MEDIA_MALWARE_DETECTED"
          : verdict.scanStatus === "REJECTED"
            ? "MEDIA_SECURITY_VALIDATION_FAILED"
            : "MEDIA_NOT_VERIFIED"
      );
    }
  }

  /** Presigned GET — only way to read avatars (private bucket). */
  async resolveViewUrlForClient(
    stored: string | null | undefined
  ): Promise<AvatarViewUrl | null> {
    const objectKey = parseObjectKeyFromStored(stored, {
      prefixes: [AVATAR_KEY_PREFIX],
      bucket: env.MINIO_BUCKET_AVATARS,
    });
    if (!objectKey) {
      return null;
    }

    try {
      // No existence probe. `headObject` was a MinIO round trip PER ROW, and
      // every caller here is a list — friends, discovery, recent searches,
      // search results — so a 20-row page paid 20 sequential-ish round trips
      // before it could answer. Under the gateway's 5s search timeout that is
      // what turned a wider `limit` into a 503 rather than a slower page.
      // Presigning is local HMAC and costs nothing; a key with no object behind
      // it yields a URL that 404s, which is exactly what an expired presign
      // already does and what every client already handles. chat-service's
      // `resolveMediaUrlMap` has always worked this way.
      const expiresIn = env.MINIO_AVATAR_VIEW_EXPIRES_IN;
      const url = await createPresignedViewUrl({
        client: presignClient,
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
