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
