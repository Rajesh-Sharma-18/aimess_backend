import { createPresignedViewUrl } from "@aimess/storage";
import { logger } from "@aimess/logger";

import { presignClient } from "../config/storage.js";
import { env } from "../config/env.js";

const AVATAR_BUCKET = env.MINIO_BUCKET_AVATARS;

export type AdminUserAvatarView = {
  url: string;
  expiresIn: number;
};

export class UserAvatarService {
  /**
   * Presigned GET for a user's avatar. The key is sourced from user-service via
   * gRPC and lives in the SHARED avatars bucket on MinIO. We presign directly
   * with NO HEAD existence check: the admin user list resolves many avatars per
   * request and presigning is local signing (no network round-trip), so mapping
   * over a page is NOT an N+1.
   *
   * Failures are swallowed (logged + null) so a broken avatar never fails the
   * admin list/detail response.
   *
   * TODO: the stored value may be a legacy full MinIO URL rather than a bare
   * key. user-service owns the canonical normalizer
   * (`parseAvatarObjectKeyFromStored` in apps/user-service/src/lib/
   * avatar-storage.ts) but it is not exported from @aimess/storage, so we
   * presign the value as-is. Lift the normalizer into @aimess/storage and reuse
   * it here if legacy-URL rows surface.
   */
  async resolveViewUrl(
    objectKey: string | null | undefined
  ): Promise<AdminUserAvatarView | null> {
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
      logger.warn(`Admin user avatar view URL skipped for key=${objectKey}`);
      logger.warn(error);
      return null;
    }
  }
}

export const userAvatarService = new UserAvatarService();
