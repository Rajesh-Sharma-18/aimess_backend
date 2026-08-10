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
  /** Permanent poster-frame key (videos / animated GIFs). */
  thumbnailObjectKey?: string | null;
  [k: string]: unknown;
}

/** The stored key an attachment resolves from: its objectKey, else a legacy url. */
export function fileMediaKey(file: MediaFileLike): string {
  return (
    (typeof file.objectKey === "string" ? file.objectKey : "") ||
    (typeof file.url === "string" ? file.url : "")
  );
}

const PUSH_IMAGE_TYPES = new Set(["IMAGE", "VIDEO", "GIF", "STICKER"]);

/**
 * The key a push should render inline: a video/GIF resolves to its poster frame,
 * an image to itself. Empty for every non-visual message type.
 */
export function pushImageKeyOf(messageType: string, content: unknown): string {
  if (!PUSH_IMAGE_TYPES.has((messageType ?? "").toUpperCase())) return "";
  const files = (content as { files?: MediaFileLike[] } | null)?.files;
  const file = Array.isArray(files) ? files[0] : undefined;
  if (!file) return "";
  const thumb =
    typeof file.thumbnailObjectKey === "string" ? file.thumbnailObjectKey : "";
  return thumb || fileMediaKey(file);
}

/**
 * Every stored key an attachment resolves from: the object itself plus its
 * poster frame. Collectors must push ALL of these into the page's
 * {@link resolveMediaUrlMap} batch, or {@link applyUrlMapToFiles} can't stamp
 * `thumbnailUrl` and the client pays a `/media/download-url` per video tile.
 */
export function fileMediaKeys(file: MediaFileLike): string[] {
  const thumb =
    typeof file.thumbnailObjectKey === "string" ? file.thumbnailObjectKey : "";
  return [fileMediaKey(file), thumb].filter(Boolean);
}

/**
 * Sync variant of {@link resolveContentFiles} using a pre-resolved url map:
 * stamp each attachment's `url` from its objectKey/legacy-url, and its
 * `thumbnailUrl` from `thumbnailObjectKey`. Returns a new array; entries whose
 * key did not resolve keep their original values.
 */
export function applyUrlMapToFiles<T extends MediaFileLike>(
  files: T[] | null | undefined,
  urlMap: Map<string, string>
): T[] {
  if (!Array.isArray(files) || files.length === 0) return files ?? [];
  return files.map((file) => {
    const url = urlFromMap(urlMap, fileMediaKey(file));
    const thumbnailUrl =
      typeof file.thumbnailObjectKey === "string"
        ? urlFromMap(urlMap, file.thumbnailObjectKey)
        : "";
    if (!url && !thumbnailUrl) return file;
    return {
      ...file,
      ...(url ? { url } : {}),
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
    };
  });
}

/**
 * Async batch form of {@link applyUrlMapToFiles} for a message's attachment
 * array (`content.files` / generic attachments): every entry gets a FRESH `url`
 * (and `thumbnailUrl`) resolved from its stored key. Non-array input passes
 * through. Returns a new array (inputs are not mutated).
 *
 * An entry with an `objectKey` is ALWAYS re-signed, even when the stored row
 * also carries a `url`: some clients persist the presigned upload/download URL
 * they got at upload time alongside the key, and that URL expires (~1h). Keeping
 * it made every live/catch-up broadcast (the paths that use this helper, unlike
 * REST history which already goes through `applyUrlMapToFiles`) hand the client
 * a dead link, so media rendered on send and broke on reopen/reconnect.
 * Keys with no `objectKey` (external Giphy/Tenor URLs) still pass through
 * unchanged via `urlFromMap`'s http(s) fallback.
 */
export async function resolveContentFiles<T extends MediaFileLike>(
  files: T[] | null | undefined
): Promise<T[]> {
  if (!Array.isArray(files) || files.length === 0) return files ?? [];
  const urlMap = await resolveMediaUrlMap(files.flatMap(fileMediaKeys));
  return applyUrlMapToFiles(files, urlMap);
}

/**
 * Resolve-on-read for a single sticker/GIF-style attachment object that lives
 * OUTSIDE `content.files[]` (e.g. `content.sticker`) and is therefore never
 * touched by {@link applyUrlMapToFiles}/{@link resolveContentFiles}. Same
 * contract as those: an external http(s) `objectKey` (e.g. a Giphy/Tenor URL)
 * resolves to itself via {@link urlFromMap}'s `isHttpUrl` fallback; a real
 * object key resolves via the page's batched `urlMap`. Add the sticker's key
 * to the same `resolveMediaUrlMap`/`resolveMediaUrl` call other fields use —
 * no extra round trip.
 */
export function resolveStickerField<T extends MediaFileLike | null | undefined>(
  sticker: T,
  urlMap: Map<string, string>
): T {
  if (!sticker || typeof sticker !== "object") return sticker;
  const url = urlFromMap(urlMap, fileMediaKey(sticker));
  return url ? ({ ...sticker, url } as T) : sticker;
}

/**
 * Resolve-on-read for a reply's `quoteData.thumbnail` — same contract as every
 * other stored media field: the persisted snapshot keeps the raw objectKey (or
 * `null`), and this stamps a fresh full URL from the page's already-resolved
 * `urlMap` (add the key to the same batch `resolveMediaUrlMap` call other
 * fields use — no extra round trip). Returns `null`, never a raw key, when
 * unresolved. Input is not mutated.
 */
export function resolveQuoteThumbnail<
  T extends { thumbnail?: string | null } | null | undefined,
>(quote: T, urlMap: Map<string, string>): T {
  if (!quote || typeof quote !== "object") return quote;
  if (!quote.thumbnail) return quote;
  return { ...quote, thumbnail: urlFromMap(urlMap, quote.thumbnail) || null };
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
      for (const file of files) keys.push(...fileMediaKeys(file));
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
