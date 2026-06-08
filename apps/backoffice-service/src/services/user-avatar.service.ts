import { createPresignedViewUrl, toMediaObject } from "@aimess/storage";
import type { MediaObject } from "@aimess/shared-types";
import { logger } from "@aimess/logger";

import { mediaUrlStrategy, presignClient } from "../config/storage.js";
import { env } from "../config/env.js";

const AVATAR_BUCKET = env.MINIO_BUCKET_AVATARS;

/** Storage-key prefix the shared media layer strips/validates for avatars. */
const AVATAR_PREFIXES = ["avatars"];

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

  /**
   * Nested {@link MediaObject} for a stored avatar value, routed through the
   * shared media layer. Handles all three `toMediaObject` cases uniformly:
   *   - a bare MinIO object key (user avatar) → presigned `downloadUrl`,
   *   - a legacy full MinIO URL → normalized then presigned,
   *   - an EXTERNAL http(s) URL (e.g. an admin's DiceBear default) → passed
   *     through as `downloadUrl` with null `objectKey`/`fileId`/expiry.
   *
   * `stored` null/empty yields an all-null MediaObject. Presign-only (no HEAD),
   * matching {@link resolveViewUrl}; `toMediaObject` swallows resolve failures
   * internally so a broken avatar never throws into the admin response.
   */
  async resolveMediaObject(
    stored: string | null | undefined
  ): Promise<MediaObject> {
    return toMediaObject({
      bucket: AVATAR_BUCKET,
      stored: stored ?? null,
      prefixes: AVATAR_PREFIXES,
      strategy: mediaUrlStrategy,
    });
  }
}

export const userAvatarService = new UserAvatarService();
