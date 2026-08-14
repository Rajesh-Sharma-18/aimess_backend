/**
 * Is this message hidden from `userId` by their own delete-for-me?
 *
 * Each conversation kind stores that per-user state in its own column, and all
 * three read paths already filter on it — this is the SINGLE shape-agnostic
 * predicate so the pin paths can ask the same question without re-deriving it:
 *   PrivateMessage.deletedFor       Json MAP   { [userId]: ts }
 *   GroupMessage.deletedForUserIds  Json ARRAY [userId, ...]
 *   GeneralRoomMessage.deletedBy    Json ARRAY [userId, ...]
 *
 * Order matters: PrivateMessage ALSO has a `deletedBy` (a single actor id
 * String, not an array), so the map check runs first and the array checks are
 * `Array.isArray`-guarded.
 */
export function isHiddenForUser(message: unknown, userId: string): boolean {
  if (!message || !userId) return false;
  const m = message as {
    deletedFor?: unknown;
    deletedForUserIds?: unknown;
    deletedBy?: unknown;
  };
  if (
    m.deletedFor &&
    typeof m.deletedFor === "object" &&
    !Array.isArray(m.deletedFor)
  ) {
    return userId in (m.deletedFor as Record<string, unknown>);
  }
  if (Array.isArray(m.deletedForUserIds))
    return m.deletedForUserIds.includes(userId);
  if (Array.isArray(m.deletedBy)) return m.deletedBy.includes(userId);
  return false;
}
