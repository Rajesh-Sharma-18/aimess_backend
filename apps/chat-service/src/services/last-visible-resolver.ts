/**
 * LastVisibleResolver — the single, room-type-agnostic answer to
 * "what is the latest message visible to THIS user?".
 *
 * Per-user message deletion is stored in three incompatible shapes across the
 * chat surfaces:
 *   - Community (GeneralRoomMessage): `deletedForAll: boolean` + `deletedBy: string[]`
 *   - Private   (PrivateMessage):     `isDeleted: boolean`     + `deletedFor: { [userId]: ts }` MAP
 *   - Group     (GroupMessage):       `isDeleted: boolean`     + `deletedForUserIds: string[]` ARRAY
 *
 * Each repository already exposes a per-shape `filterHidden*` (batch hidden-check)
 * and `findPreviousVisibleForUser` (newest message visible to a user). This module
 * is a THIN orchestration layer over those — it adds NO new queries and changes
 * NO storage shape. Every list builder (community `getChatSummaries`, private
 * `enrichConversations`, group `getInboxGroups`/`getUserGroups`) and every
 * delete-for-me gate routes through it, so the REST list and the realtime socket
 * finally derive the same per-user preview.
 *
 * Each caller adapts its own repository into a `VisibilitySource` (a 2-method
 * interface) that normalizes that surface's message shape into `VisibleLast`.
 * The resolver never imports a repository directly, so it stays trivially
 * unit-testable and free of the DI graph.
 */

/** Normalized "latest visible message" — the common shape across all room types. */
export interface VisibleLast {
  messageId: string;
  /** sentBy (community) | senderId (private/group). "" when unknown. */
  senderId: string;
  /** senderName (community/group) | "" (private messages carry no senderName). */
  senderName: string;
  /** Canonical content-type (TEXT/IMAGE/SYSTEM/…); rendering is the caller's job. */
  messageType: string;
  /** Raw content: a plain string for community (`message`), a JSON object for
   *  private/group (`content`). Callers pass this straight to their existing
   *  preview renderer (convertMessageToPreview / buildMessagePreview both accept
   *  either shape). */
  content: unknown;
  createdAt: Date;
}

/**
 * Per-room-type adapter the resolver needs. Built inline by each list service
 * from its message repository, normalizing into `VisibleLast`.
 */
export interface VisibilitySource {
  /**
   * Of `messageIds`, the subset hidden from `userId` — globally deleted OR
   * personally hidden by that user. Normalizes the three deletion shapes
   * (deletedBy[] / deletedFor{} / deletedForUserIds[]) behind one call.
   */
  filterHidden(messageIds: string[], userId: string): Promise<Set<string>>;
  /**
   * The newest message visible to `userId` in `roomId` (excludes global deletes
   * AND that user's personal hides), normalized; null when none remain.
   */
  findPreviousVisibleForUser(
    roomId: string,
    userId: string
  ): Promise<VisibleLast | null>;
}

/** A room's shared (global) last-message pointer — the list snapshot to validate. */
export interface RoomSharedLast {
  roomId: string;
  sharedLastMessageId: string | null;
}

/**
 * The per-user override decision for a room's list preview:
 *   - the resolver returns a Map keyed by roomId containing ONLY rooms whose
 *     shared last message is hidden from the viewer.
 *   - value `VisibleLast`  → substitute this previous-visible message.
 *   - value `null`         → no visible message remains (the viewer has hidden
 *                            everything); caller renders its empty state.
 *   - key ABSENT           → the shared last message is visible; caller keeps the
 *                            shared snapshot unchanged (the overwhelmingly common
 *                            path — zero extra queries).
 *
 * This mirrors EXACTLY the `perUserFallback` / `perUserLastMessage` maps the
 * private and community list builders already construct by hand, so swapping
 * them onto the resolver is behavior-preserving.
 */
export type VisibleLastOverrides = Map<string, VisibleLast | null>;

/**
 * Batch resolver for a page of rooms. One `filterHidden` over every shared
 * last-message id, then `findPreviousVisibleForUser` ONLY for the (usually zero)
 * rooms whose shared last is hidden from the viewer. The per-room fallback
 * queries run concurrently — bounded by the page size — so a viewer who has
 * hidden the last message in many rooms does not serialize N round-trips.
 */
export async function resolveVisibleLastBulk(
  source: VisibilitySource,
  rooms: RoomSharedLast[],
  userId: string
): Promise<VisibleLastOverrides> {
  const overrides: VisibleLastOverrides = new Map();
  if (!rooms.length) return overrides;

  const sharedIds = rooms
    .map((r) => r.sharedLastMessageId)
    .filter((id): id is string => Boolean(id));
  if (!sharedIds.length) return overrides;

  const hidden = await source.filterHidden(sharedIds, userId);
  if (!hidden.size) return overrides;

  const hiddenRooms = rooms.filter(
    (r) => r.sharedLastMessageId && hidden.has(r.sharedLastMessageId)
  );
  // Concurrent (not serial) per-room previous-visible lookups for the hidden set.
  const resolved = await Promise.all(
    hiddenRooms.map((r) => source.findPreviousVisibleForUser(r.roomId, userId))
  );
  hiddenRooms.forEach((r, i) => overrides.set(r.roomId, resolved[i] ?? null));
  return overrides;
}

/**
 * Single-room resolution: the viewer's effective last visible message.
 *   - `{ override: null }`         → shared last is visible; use the snapshot.
 *   - `{ override: VisibleLast }`  → shared last hidden; use this fallback.
 *   - `{ override: null, empty: true }` → no visible message remains.
 */
export async function resolveVisibleLast(
  source: VisibilitySource,
  roomId: string,
  sharedLastMessageId: string | null,
  userId: string
): Promise<{ override: VisibleLast | null; empty: boolean }> {
  if (!sharedLastMessageId) {
    // No shared last at all — fall back to the viewer's newest visible (covers
    // rooms whose snapshot was never set but messages exist).
    const prev = await source.findPreviousVisibleForUser(roomId, userId);
    return { override: prev, empty: prev === null };
  }
  const hidden = await source.filterHidden([sharedLastMessageId], userId);
  if (!hidden.has(sharedLastMessageId)) {
    return { override: null, empty: false }; // shared last visible — use snapshot
  }
  const prev = await source.findPreviousVisibleForUser(roomId, userId);
  return { override: prev, empty: prev === null };
}

/**
 * Was `deletedMessageCreatedAt` the viewer's effective last visible message
 * before this delete? Called AFTER the mutation, so the deleted row is already
 * hidden: the deletion was the viewer's last iff nothing currently visible is
 * newer than it. Replaces the dead `recalc === null` guard so a delete-for-me on
 * a NON-last message no longer emits a redundant targeted list bump.
 *
 * A same-millisecond tie resolves to `true` (treat as last) — a harmless extra
 * refresh in a rare edge, never a wrong preview.
 */
export async function wasEffectiveLastForUser(
  source: VisibilitySource,
  roomId: string,
  userId: string,
  deletedMessageCreatedAt: Date
): Promise<boolean> {
  const prev = await source.findPreviousVisibleForUser(roomId, userId);
  if (!prev) return true; // nothing visible remains → the deleted msg was the last
  return prev.createdAt.getTime() <= deletedMessageCreatedAt.getTime();
}
