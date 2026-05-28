import { env } from "../config/env.js";

const AVATAR_KEY_PREFIX = "avatars";

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
    const bucketPrefix = `/${env.MINIO_BUCKET_AVATARS}/`;
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
