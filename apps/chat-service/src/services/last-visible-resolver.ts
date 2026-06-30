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
  /**
   * Of `userIds`, the subset who have PERSONALLY hidden `messageId` (delete-for-me).
   * Used by the delete-for-everyone broadcast to find which recipients cannot see
   * the new shared previous-visible message, so they get their own preview instead.
   */
  hidersAmong(messageId: string, userIds: string[]): Promise<Set<string>>;
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

  // `?? new Set()` guards against a source/mock returning undefined (the test
  // repo proxy default) — the real repositories always return a Set.
  const hidden =
    (await source.filterHidden(sharedIds, userId)) ?? new Set<string>();
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
 * Pure predicate (the SINGLE source of truth for the "was-last" gate): given the
 * viewer's newest-still-visible message's createdAt AFTER a delete (null = none
 * remain) and the deleted message's createdAt, was the deleted message the
 * viewer's effective last visible message? If so, a targeted delete-for-me list
 * bump is warranted; otherwise hiding it changed nothing and the bump is a no-op.
 *
 * The three delete-for-me recalc methods already hold `prev` (they need it for
 * the preview), so they call this directly instead of re-querying. A
 * same-millisecond tie resolves to `true` (treat as last) — a harmless extra
 * refresh in a rare edge, never a wrong preview.
 */
export function deletedWasEffectiveLast(
  prevVisibleCreatedAt: Date | null,
  deletedMessageCreatedAt: Date
): boolean {
  if (!prevVisibleCreatedAt) return true; // nothing visible remains → it was last
  return prevVisibleCreatedAt.getTime() <= deletedMessageCreatedAt.getTime();
}

/** A per-recipient list-preview override for the delete-for-everyone fan-out. */
export interface RecipientOverride {
  lastMessageId: string;
  /** epoch ms */
  lastMessageAt: number;
  senderId: string;
  senderName: string;
  messageType: string;
  /** raw content for the caller's preview renderer */
  content: unknown;
}

/**
 * After a delete-for-everyone rolls the SHARED snapshot back to `sharedPrev`
 * (the new community-wide previous-visible message), some recipients may have
 * PERSONALLY hidden `sharedPrev` too — for them the fanned-out preview would
 * point at a message they cannot see. This resolves a per-recipient override for
 * exactly those recipients (the others receive the shared preview unchanged).
 *
 * Cost is bounded: ONE `hidersAmong` lookup over the recipient list, then
 * `findPreviousVisibleForUser` only for the (usually zero) recipients who hid it.
 * When `sharedPrev` is null (the room was emptied) every recipient who still has
 * a personal message gets their own; here we only special-case the hiders since a
 * null shared preview already renders as the empty state for everyone.
 */
export async function resolveForEveryoneOverrides(
  source: VisibilitySource,
  roomId: string,
  sharedPrevMessageId: string | null,
  recipientIds: string[]
): Promise<Map<string, RecipientOverride | null>> {
  const overrides = new Map<string, RecipientOverride | null>();
  if (!sharedPrevMessageId || !recipientIds.length) return overrides;

  const hiders =
    (await source.hidersAmong(sharedPrevMessageId, recipientIds)) ??
    new Set<string>();
  if (!hiders.size) return overrides;

  const hiderList = [...hiders];
  const resolved = await Promise.all(
    hiderList.map((uid) => source.findPreviousVisibleForUser(roomId, uid))
  );
  hiderList.forEach((uid, i) => {
    const v = resolved[i];
    overrides.set(
      uid,
      v
        ? {
            lastMessageId: v.messageId,
            lastMessageAt: v.createdAt.getTime(),
            senderId: v.senderId,
            senderName: v.senderName,
            messageType: v.messageType,
            content: v.content,
          }
        : null // the recipient has hidden everything → empty preview for them
    );
  });
  return overrides;
}
