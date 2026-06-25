import { MEDIA_PREFIXES, toMediaObject } from "@aimess/storage";
import type { MediaObject } from "@aimess/shared-types";
import { env } from "../config/env.js";
import { mediaUrlStrategy } from "../config/storage.js";

const AVATAR_PREFIXES = MEDIA_PREFIXES.userAvatars;

/**
 * Build MediaObject for a user avatar from the raw stored object key.
 * The key lives in the shared avatars bucket (cross-service).
 */
export function buildAvatarMedia(
  stored: string | null | undefined
): Promise<MediaObject> {
  return toMediaObject({
    bucket: env.MINIO_BUCKET_AVATARS,
    stored: stored ?? null,
    prefixes: AVATAR_PREFIXES,
    strategy: mediaUrlStrategy,
  });
}
