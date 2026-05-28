import { createPresignedViewUrl } from "@aimess/storage";
import { logger } from "@aimess/logger";

import { presignClient } from "../config/storage.js";
import { env } from "../config/env.js";

const AVATAR_BUCKET = env.MINIO_BUCKET_AVATARS;

export type MemberAvatarView = {
  url: string;
  expiresIn: number;
};

export class MemberAvatarService {
  /**
   * Presigned GET for a member's snapshot avatar. The key belongs to
   * user-service's avatars bucket on the shared MinIO. We presign directly
   * with no HEAD existence check: a member roster resolves many avatars at
   * once, so a per-row round-trip to MinIO would dominate the response — and
   * the key was already validated at upload time and kept fresh via the
   * user.profile_updated event.
   */
  async resolveViewUrl(
    objectKey: string | null | undefined
  ): Promise<MemberAvatarView | null> {
    if (!objectKey) {
      return null;
    }

    try {
      const expiresIn = env.MINIO_AVATAR_VIEW_EXPIRES_IN;
      const url = await createPresignedViewUrl({
        client: presignClient,
        bucket: AVATAR_BUCKET,
        objectKey,
        expiresIn,
      });
      return { url, expiresIn };
    } catch (error) {
      logger.warn(`Member avatar view URL skipped for key=${objectKey}`);
      logger.warn(error);
      return null;
    }
  }
}

export const memberAvatarService = new MemberAvatarService();
