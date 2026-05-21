import { env } from "../config/env.js";

const COMMUNITY_AVATAR_PREFIX = "community/avatar";
const COMMUNITY_COVER_PREFIX = "community/cover";

/**
 * DB may store object key or legacy full MinIO URL. Cover prefix is still
 * recognized so legacy rows that stored a cover key keep resolving.
 */
export function parseCommunityImageObjectKeyFromStored(
  stored: string | null | undefined
): string | null {
  if (!stored) {
    return null;
  }

  if (
    stored.startsWith(`${COMMUNITY_AVATAR_PREFIX}/`) ||
    stored.startsWith(`${COMMUNITY_COVER_PREFIX}/`)
  ) {
    return stored;
  }

  try {
    const pathname = new URL(stored).pathname;
    const bucketPrefix = `/${env.MINIO_BUCKET_COMMUNITY}/`;
    if (pathname.startsWith(bucketPrefix)) {
      return pathname.slice(bucketPrefix.length);
    }
  } catch {
    // Not a URL — ignore.
  }

  return null;
}
