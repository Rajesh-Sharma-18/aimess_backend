/**
 * Resolves an account-wide notification count into the count ONE session sees.
 *
 * A notification badge is per user in the database but per session on screen: a
 * login-detected row is withheld from the device that login created — from the
 * list, the per-tab counts and `/unread-count` alike — while every other device
 * of the same account sees it. So a broadcast, which has one payload and many
 * recipients, cannot carry a single finished number. chat-service publishes the
 * account-wide count plus `selfHiddenSessions` (one entry per unread
 * login-detected row, naming the session it is hidden from) and every count
 * that reaches a socket is resolved here, against that socket's own session.
 *
 * Without this the device that had just logged in was told it had 1 unread
 * while its own notification list — correctly — showed none, and only a
 * refetch ever corrected it.
 */

/** The count `sessionId` sees, given the account-wide total and the hidden set. */
export function unreadCountForSession(
  unreadCount: number,
  selfHiddenSessions: string[] | undefined,
  sessionId: string | undefined | null
): number {
  if (!sessionId || !selfHiddenSessions?.length) return unreadCount;
  const hidden = selfHiddenSessions.filter((s) => s === sessionId).length;
  return Math.max(0, unreadCount - hidden);
}

/**
 * Per-socket rewrite of a `/notify` frame: resolves `unreadCount` / `count`
 * for this session and drops `selfHiddenSessions`, which is routing detail and
 * never leaves the gateway. A frame without it is returned untouched, so this
 * is safe to run over every event type.
 */
export function scopeUnreadFrame(
  data: unknown,
  sessionId: string | undefined
): unknown {
  if (!data || typeof data !== "object") return data;
  const frame = data as Record<string, unknown>;
  if (!("selfHiddenSessions" in frame)) return data;
  const { selfHiddenSessions, ...rest } = frame;
  const hidden = Array.isArray(selfHiddenSessions)
    ? (selfHiddenSessions as string[])
    : undefined;
  const scope = (value: unknown) =>
    typeof value === "number"
      ? unreadCountForSession(value, hidden, sessionId)
      : value;
  return {
    ...rest,
    ...("unreadCount" in rest ? { unreadCount: scope(rest.unreadCount) } : {}),
    ...("count" in rest ? { count: scope(rest.count) } : {}),
  };
}
