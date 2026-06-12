import { logger } from "@aimess/logger";
import { bucketForKey as resolveBucketForKey } from "@aimess/storage";

import { mediaUrlStrategy } from "../config/storage.js";
import { env } from "../config/env.js";

/**
 * Resolve-on-read media boundary for chat-service.
 *
 * Chat persists/echoes raw MinIO object keys in many snapshot fields
 * (`senderAvatar`, room logos, `content.files[].objectKey`, reaction avatars,
 * pin snapshots). The FE must always receive a full, usable URL — never a raw
 * object key. This helper turns a stored value (object key OR legacy/external
 * URL) into a presigned (or CDN) download URL via the shared `@aimess/storage`
 * strategy configured in `config/storage.ts`.
 *
 * Two invariants:
 *  1. **Best-effort** — any failure (MinIO down, unknown prefix) yields `""`
 *     instead of throwing, so a read/broadcast never fails because a URL could
 *     not be signed.
 *  2. **Resolve on READ, never persist** the resolved URL — presigned URLs
 *     expire, so the snapshot/cache must keep the stable object key and the URL
 *     must be (re)derived at each serialization.
 */

/**
 * Pick the bucket a stored object key belongs to from its leading prefix.
 * The prefix→bucket routing table is the shared `@aimess/storage` contract
 * ({@link resolveBucketForKey}); this binds it to chat-service's three MinIO
 * buckets. chat-uploads / group-chat-uploads / community-chat-uploads — and any
 * unrecognized key — fall through to the chat bucket.
 */
function bucketForKey(key: string): string {
  return resolveBucketForKey(key, {
    avatarsBucket: env.MINIO_BUCKET_AVATARS,
    communityBucket: env.MINIO_BUCKET_COMMUNITY,
    chatBucket: env.MINIO_BUCKET,
  });
}

const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

/**
 * Resolve a single stored media value to a full download URL.
 *  - falsy        → `""` (no media)
 *  - http(s) URL  → returned unchanged (legacy/external)
 *  - object key   → presigned/CDN download URL (or `""` on failure)
 */
export async function resolveMediaUrl(
  stored: string | null | undefined
): Promise<string> {
  if (!stored) return "";
  if (isHttpUrl(stored)) return stored;

  const bucket = bucketForKey(stored);
  try {
    const { url } = await mediaUrlStrategy.resolveDownloadUrl(bucket, stored);
    return url;
  } catch (err) {
    logger.warn(`media-resolve|failed key=${stored}: ${String(err)}`);
    return "";
  }
}

/**
 * Batch-resolve a set of stored values, de-duplicating keys so a roster/history
 * page signs each distinct key once. Returns a Map keyed by the ORIGINAL stored
 * value → resolved URL.
 */
export async function resolveMediaUrlMap(
  stored: Array<string | null | undefined>
): Promise<Map<string, string>> {
  const distinct = Array.from(
    new Set(stored.filter((s): s is string => Boolean(s)))
  );
  const entries = await Promise.all(
    distinct.map(async (key) => [key, await resolveMediaUrl(key)] as const)
  );
  return new Map(entries);
}

/**
 * Sync lookup of a stored value against a pre-resolved {@link resolveMediaUrlMap}.
 * Lets a read path resolve ALL its keys once (one async batch) and then map each
 * message synchronously. http(s) values that were never signed pass through.
 */
export function urlFromMap(
  urlMap: Map<string, string>,
  stored: string | null | undefined
): string {
  if (!stored) return "";
  return urlMap.get(stored) ?? (isHttpUrl(stored) ? stored : "");
}

export interface MediaFileLike {
  objectKey?: string | null;
  url?: string | null;
  [k: string]: unknown;
}

/** The stored key an attachment resolves from: its objectKey, else a legacy url. */
export function fileMediaKey(file: MediaFileLike): string {
  return (
    (typeof file.objectKey === "string" ? file.objectKey : "") ||
    (typeof file.url === "string" ? file.url : "")
  );
}

/**
 * Sync variant of {@link resolveContentFiles} using a pre-resolved url map:
 * stamp each attachment's `url` from its objectKey/legacy-url. Returns a new
 * array; entries whose key did not resolve keep their original `url`.
 */
export function applyUrlMapToFiles<T extends MediaFileLike>(
  files: T[] | null | undefined,
  urlMap: Map<string, string>
): T[] {
  if (!Array.isArray(files) || files.length === 0) return files ?? [];
  return files.map((file) => {
    const url = urlFromMap(urlMap, fileMediaKey(file));
    return url ? { ...file, url } : file;
  });
}

/**
 * Resolve a message's attachment array (`content.files` / generic attachments).
 * Each entry gains a `url` resolved from its `objectKey`; an entry that already
 * carries a full http(s) `url` is left untouched. Non-array input passes
 * through. Returns a new array (inputs are not mutated).
 */
export async function resolveContentFiles<T extends MediaFileLike>(
  files: T[] | null | undefined
): Promise<T[]> {
  if (!Array.isArray(files) || files.length === 0) return files ?? [];
  return Promise.all(
    files.map(async (file) => {
      const existing = typeof file.url === "string" ? file.url : "";
      if (existing && isHttpUrl(existing)) return file;
      const url = await resolveMediaUrl(file.objectKey ?? existing);
      return url ? { ...file, url } : file;
    })
  );
}

/**
 * Resolve-on-read for a page of pinned-message snapshots (private/group/
 * community pins share the same shape: a stored `senderAvatar` object key and a
 * frozen `contentPinned` JSON blob whose `files[]` carry attachment object
 * keys). The persisted snapshot keeps the raw keys; this stamps fresh download
 * URLs on the READ boundary (pin list) so the FE never receives a raw key, while
 * the DB row keeps the stable key. Collects every key on the page and presigns
 * ONCE (deduped) — no per-pin N+1. Returns new rows; inputs are not mutated.
 *
 * Typed loosely (`Record<string, unknown>`) because Prisma types `contentPinned`
 * as the broad `JsonValue`; the row is narrowed defensively at access time.
 */
export async function resolvePinsMedia<T>(pins: T[]): Promise<T[]> {
  if (!Array.isArray(pins) || pins.length === 0) return pins ?? [];

  const asRecord = (pin: T): Record<string, unknown> =>
    pin as unknown as Record<string, unknown>;

  const filesOf = (pin: T): MediaFileLike[] | null => {
    const content = asRecord(pin).contentPinned;
    if (!content || typeof content !== "object") return null;
    const files = (content as Record<string, unknown>).files;
    return Array.isArray(files) ? (files as MediaFileLike[]) : null;
  };

  const keys: string[] = [];
  for (const pin of pins) {
    const avatar = asRecord(pin).senderAvatar;
    if (typeof avatar === "string" && avatar) keys.push(avatar);
    const files = filesOf(pin);
    if (files) {
      for (const file of files) {
        const key = fileMediaKey(file);
        if (key) keys.push(key);
      }
    }
  }
  const urlMap = await resolveMediaUrlMap(keys);

  return pins.map((pin) => {
    const rec = asRecord(pin);
    const next: Record<string, unknown> = { ...rec };
    if (typeof rec.senderAvatar === "string") {
      next.senderAvatar = urlFromMap(urlMap, rec.senderAvatar);
    }
    const files = filesOf(pin);
    if (files) {
      next.contentPinned = {
        ...(rec.contentPinned as Record<string, unknown>),
        files: applyUrlMapToFiles(files, urlMap),
      };
    }
    return next as T;
  });
}
