import { markIdempotentReplay } from "./idempotency.js";

const ALBUM_MESSAGES = Symbol.for("aimess.chat.albumMessages");

/** Attach the full ordered album batch (oldest → newest) to the primary row. */
export function attachAlbumMessages<T extends object>(
  primary: T,
  messages: T[]
): T {
  (primary as Record<symbol, unknown>)[ALBUM_MESSAGES] = messages;
  return primary;
}

/** All persisted rows for this send (single-message sends return `[msg]`). */
export function getAlbumMessages<T>(msg: T): T[] {
  const batch = (msg as Record<symbol, unknown>)[ALBUM_MESSAGES];
  return Array.isArray(batch) && batch.length > 0 ? (batch as T[]) : [msg];
}

/** Tag a replay and preserve the full album batch for fan-out suppression. */
export function markAlbumIdempotentReplay<T extends object>(
  primary: T,
  messages: T[]
): T {
  attachAlbumMessages(primary, messages);
  return markIdempotentReplay(primary);
}

const ALBUM_ID_PREFIX = "album-";

/**
 * Resolve an album ID or a plain message ID to the underlying MongoDB ObjectId
 * string. Album IDs are client-facing composite keys of the form
 * `album-<24-hex-ObjectId>` that identify the primary row of a multi-image/video
 * send. Stripping the prefix recovers the real message ID so callers can safely
 * pass it to repository `findById` methods.
 *
 * A plain message ID (already a 24-hex ObjectId) is returned unchanged.
 * An empty string / null / undefined is returned as-is; callers should still
 * guard on falsy before calling `findById`.
 */
export function resolveMessageId(id: string | null | undefined): string {
  if (!id) return id ?? "";
  return id.startsWith(ALBUM_ID_PREFIX) ? id.slice(ALBUM_ID_PREFIX.length) : id;
}

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/**
 * Resolve a reply parent ID for safe persistence into a MongoDB ObjectId column.
 * Strips the `album-` prefix then validates the result is a 24-hex ObjectId.
 * Returns null for anything that is not (or cannot be resolved to) a valid
 * message ObjectId, preventing Prisma from crashing with "Malformed ObjectID".
 */
export function resolveParentMessageId(
  id: string | null | undefined
): string | null {
  const resolved = resolveMessageId(id);
  if (!resolved) return null;
  return OBJECT_ID_RE.test(resolved) ? resolved : null;
}

/**
 * Reverse of `albumSiblingClientMessageId` (split-media-album.ts): a sibling
 * row's `clientMessageId` is `<baseId>:<index>` (index 0 keeps the bare base
 * id). Strips the `:<index>` suffix so a reply-to-an-album-row lookup can find
 * the FULL sibling batch via `findAlbumBatchByClientMessageId` — a single
 * row's own `content.files` never reveals the true album size (album sends
 * are split one-row-per-file).
 */
export function albumBaseClientMessageId(
  clientMessageId: string | null | undefined
): string | null {
  if (!clientMessageId) return null;
  const idx = clientMessageId.lastIndexOf(":");
  return idx > 0 ? clientMessageId.slice(0, idx) : clientMessageId;
}

export interface AlbumBatchRepo<T> {
  findAlbumBatchByClientMessageId(
    roomId: string,
    senderId: string,
    baseClientMessageId: string
  ): Promise<T[]>;
}

/**
 * True album size for a reply's parent row — `undefined` when the parent
 * isn't part of a multi-row album (single send, or no clientMessageId at
 * all), so callers fall back to `content.files.length` (0 or 1). Shared by
 * private/group/community so the "📷 N Photos" reply preview counts the SAME
 * way everywhere.
 */
export async function resolveReplyAttachmentCount<
  T extends { clientMessageId?: string | null },
>(
  repo: AlbumBatchRepo<T>,
  roomId: string,
  senderId: string,
  originalMsg: T
): Promise<number | undefined> {
  const baseId = albumBaseClientMessageId(originalMsg.clientMessageId);
  if (!baseId) return undefined;
  const batch = await repo.findAlbumBatchByClientMessageId(
    roomId,
    senderId,
    baseId
  );
  return batch.length > 1 ? batch.length : undefined;
}
