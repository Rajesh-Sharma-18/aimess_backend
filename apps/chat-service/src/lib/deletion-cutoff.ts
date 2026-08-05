/**
 * Per-user "delete conversation" cutoff. When a user deletes a private chat or
 * group chat, messages created at/before this instant must never be visible to
 * them again — even after a new message restores the room to their inbox
 * (Telegram-style "Delete Chat" semantics). Every message-read path (history
 * pagination, socket catchup/changes, search, media, unread, last-message
 * preview) must clamp to `createdAt > cutoff` for the requesting user.
 */

/** Private room: cutoff lives in `PrivateRoom.deletedFor` — a `{ [userId]: ISO-ts }` map. */
export function getPrivateDeletionCutoff(
  room: { deletedFor?: unknown } | null | undefined,
  userId: string
): Date | undefined {
  const ts = (room?.deletedFor as Record<string, unknown> | undefined)?.[
    userId
  ];
  return typeof ts === "string" ? new Date(ts) : undefined;
}

/**
 * Group read cutoff: the LATER of the member's own "delete conversation"
 * cutoff (`clearedAt`) and their `joinedAt` — a member must never see history
 * from before they joined (or before they rejoined, since `joinedAt` is
 * re-stamped on every add/invite-link redemption), on top of whatever they've
 * cleared themselves. Every group read path (history pagination, socket
 * catchup/changes, search, media, unread, last-message preview) must clamp to
 * `createdAt > cutoff` for the requesting member.
 */
export function getGroupVisibilityCutoff(
  member: { clearedAt?: Date | null; joinedAt?: Date | null } | null | undefined
): Date | undefined {
  const clearedAt = member?.clearedAt ?? undefined;
  const joinedAt = member?.joinedAt ?? undefined;
  if (!joinedAt) return clearedAt;
  if (!clearedAt) return joinedAt;
  return clearedAt > joinedAt ? clearedAt : joinedAt;
}
