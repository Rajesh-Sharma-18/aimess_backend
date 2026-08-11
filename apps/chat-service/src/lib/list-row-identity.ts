/**
 * The identity + freshness quartet every list row (inbox `lastMessage`,
 * community `lastActivity`, the `conv:updated` / `community:updated` bumps)
 * carries for its last message.
 *
 * Offline-first clients merge a list row against their local cache field by
 * field. A preview + timestamp alone cannot answer "is this the server's copy
 * of the message I just sent optimistically?" (needs `clientMessageId`) nor
 * "which of two rows sharing one millisecond is newer?" (needs `seq`), nor
 * "has this message been edited/deleted since?" (needs `revision`). All four
 * are ADDITIVE — every existing field on those payloads is untouched.
 *
 * `seq`/`revision` default to 0 and `clientMessageId` to null for pre-backfill
 * rows and server-generated messages, which is exactly what a client that has
 * never seen the field already assumes.
 */
export interface ListRowIdentity {
  messageId: string;
  clientMessageId: string | null;
  /** Per-room INSERT sequence — the tie-breaker for equal timestamps. */
  seq: number;
  /** Per-room CHANGE cursor at this message's latest mutation. */
  revision: number;
}

export function listRowIdentity(message: {
  id?: string | null;
  _id?: unknown;
  clientMessageId?: string | null;
  sequenceNumber?: number | null;
  revision?: number | null;
}): ListRowIdentity {
  return {
    messageId: String(message.id ?? message._id ?? ""),
    clientMessageId: message.clientMessageId ?? null,
    seq: message.sequenceNumber ?? 0,
    revision: message.revision ?? 0,
  };
}
