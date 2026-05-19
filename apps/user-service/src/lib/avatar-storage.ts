import { ObjectKeyPrefix, StorageBuckets } from "./storage-buckets.js";

const AVATAR_KEY_PREFIX = ObjectKeyPrefix.avatars;

/** Object key: avatars/{userId}/{fileId}.{ext} */
export function buildAvatarObjectKey(
  userId: string,
  fileId: string,
  extension: string
): string {
  const safeExt = extension.replace(/^\./, "").toLowerCase();
  return `${AVATAR_KEY_PREFIX}/${userId}/${fileId}.${safeExt}`;
}

export function isAvatarObjectKeyOwnedByUser(
  objectKey: string,
  userId: string
): boolean {
  const prefix = `${AVATAR_KEY_PREFIX}/${userId}/`;
  return objectKey.startsWith(prefix) && !objectKey.includes("..");
}

/** DB may store object key or legacy full MinIO URL. */
export function parseAvatarObjectKeyFromStored(
  stored: string | null | undefined
): string | null {
  if (!stored) {
    return null;
  }

  if (stored.startsWith(`${AVATAR_KEY_PREFIX}/`)) {
    return stored;
  }

  try {
    const pathname = new URL(stored).pathname;
    const bucketPrefix = `/${StorageBuckets.avatars}/`;
    if (pathname.startsWith(bucketPrefix)) {
      return pathname.slice(bucketPrefix.length);
    }

    const marker = `${AVATAR_KEY_PREFIX}/`;
    const markerIndex = pathname.indexOf(`/${marker}`);
    if (markerIndex >= 0) {
      return pathname.slice(markerIndex + 1);
    }
  } catch {
    // Not a URL — ignore.
  }

  return null;
}

export const ALLOWED_AVATAR_CONTENT_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

export type AllowedAvatarContentType =
  keyof typeof ALLOWED_AVATAR_CONTENT_TYPES;
