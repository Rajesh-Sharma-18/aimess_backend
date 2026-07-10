import { logger } from "@aimess/logger";

import { env } from "../config/env.js";
import { mediaUrlStrategy } from "../config/storage.js";

/**
 * Resolve-on-read boundary for comment `senderAvatar` (stores a raw MinIO
 * object key, same convention as chat-service's `senderAvatar` snapshots).
 * Mirrors chat-service's `media-resolve.ts` — best-effort, never persisted.
 */

const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

/**
 * Resolve a single stored avatar value to a full download URL.
 *  - falsy       → `""` (no avatar — matches existing empty-string default)
 *  - http(s) URL → returned unchanged (legacy/external)
 *  - object key  → presigned/CDN download URL (or `""` on failure)
 */
export async function resolveAvatarUrl(
  stored: string | null | undefined
): Promise<string> {
  if (!stored) return "";
  if (isHttpUrl(stored)) return stored;

  try {
    const { url } = await mediaUrlStrategy.resolveDownloadUrl(
      env.MINIO_BUCKET_AVATARS,
      stored
    );
    return url;
  } catch (err) {
    logger.warn(`avatar-resolve|failed key=${stored}: ${String(err)}`);
    return "";
  }
}

/**
 * Batch-resolve a set of stored avatar keys, de-duplicating so a comments
 * page signs each distinct key once. Returns a Map keyed by the ORIGINAL
 * stored value → resolved URL.
 */
export async function resolveAvatarUrlMap(
  stored: Array<string | null | undefined>
): Promise<Map<string, string>> {
  const distinct = Array.from(
    new Set(stored.filter((s): s is string => Boolean(s)))
  );
  const entries = await Promise.all(
    distinct.map(async (key) => [key, await resolveAvatarUrl(key)] as const)
  );
  return new Map(entries);
}

/** Sync lookup against a pre-resolved {@link resolveAvatarUrlMap}. */
export function avatarUrlFromMap(
  urlMap: Map<string, string>,
  stored: string | null | undefined
): string {
  if (!stored) return "";
  return urlMap.get(stored) ?? (isHttpUrl(stored) ? stored : "");
}
