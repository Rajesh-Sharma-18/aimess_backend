/**
 * Bridge so the Chats/Community nav-badge summary can be pushed from wherever
 * a user's unread state actually changes, without threading UnreadSummaryService
 * through the 30+ existing call sites of publishConvUpdated/publishCommunityUpdated
 * (REST controllers, gRPC handlers, system-message services) or creating a
 * circular constructor dependency (UnreadSummaryService itself depends on
 * CommunityMessageService, which needs to trigger a push on message read).
 *
 * server.ts calls `registerUnreadSummaryPusher` once, after UnreadSummaryService
 * exists. Every other file just imports and calls `notifyUnreadChanged(userId)`
 * — a safe no-op if called before registration (e.g. in unit tests).
 *
 * The pusher takes a BATCH. One message into an N-member room changes the
 * badge for every recipient at once, and the pusher needs to see them together
 * to answer "which of these can actually receive a push?" in one round trip
 * instead of N. Single-user callers (mark-read, and the like) go through
 * `notifyUnreadChanged`, which is just a batch of one.
 */
type UnreadSummaryPusher = (userIds: string[]) => void;

let pusher: UnreadSummaryPusher | null = null;

export function registerUnreadSummaryPusher(fn: UnreadSummaryPusher): void {
  pusher = fn;
}

/** One user's unread total changed. */
export function notifyUnreadChanged(userId: string): void {
  if (!userId) return;
  pusher?.([userId]);
}

/**
 * Several users' unread totals changed at once — the message fan-out case.
 * Callers accumulate ids through their per-recipient loop and flush ONCE, so
 * the pusher can batch the presence lookup it needs to decide who to serve.
 */
export function notifyUnreadChangedMany(userIds: string[]): void {
  if (userIds.length === 0) return;
  pusher?.(userIds);
}
