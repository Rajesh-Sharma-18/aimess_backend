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
 */
type UnreadSummaryPusher = (userId: string) => void;

let pusher: UnreadSummaryPusher | null = null;

export function registerUnreadSummaryPusher(fn: UnreadSummaryPusher): void {
  pusher = fn;
}

export function notifyUnreadChanged(userId: string): void {
  pusher?.(userId);
}
