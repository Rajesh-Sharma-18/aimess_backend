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

/** Group: cutoff lives directly on the caller's own `GroupMember.clearedAt` row. */
export function getGroupDeletionCutoff(
  member: { clearedAt?: Date | null } | null | undefined
): Date | undefined {
  return member?.clearedAt ?? undefined;
}
