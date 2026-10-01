/**
 * Stable tray-card tags, one per thing a card stands for.
 *
 * The tag is the push's `collapseKey`, and push.service carries it everywhere a
 * card is drawn so any device can find the card again and close it:
 *  - Android: `data.tag`, used as the `NotificationManager` tag,
 *  - iOS: `apns-collapse-id`, which becomes the delivered request's identifier,
 *  - Web: `webpush.notification.tag` and `data.tag`.
 *
 * Never derived from text, sender, device or message id (except `msg:` cards,
 * which have none today). Changing a builder orphans every card already in a
 * tray, so these are contract, like the payload keys.
 */
export const pushTag = {
  /** Chat summary for one conversation (private, group or community room). */
  conversation: (conversationId: string) => `conv:${conversationId}`,
  /** "X mentioned you" / "@all" for one conversation. Kept apart from `conv:`
   *  so a later plain summary cannot replace it. */
  mention: (conversationId: string) => `mention:${conversationId}`,
  /** Livestream started / ended in one community. Ended replaces started. */
  live: (communityId: string) => `live:${communityId}`,
  /** "You were added to …" for one group or community. */
  added: (roomId: string) => `added:${roomId}`,
  /** Incoming friend request. */
  friendRequest: (friendshipId: string) => `fr:${friendshipId}`,
} as const;

/**
 * Every card that belongs to one room. Read, clear, delete, leave, kick and ban
 * all close the same set. A private chat has no live/added cards; closing a tag
 * that was never shown is a no-op on every platform.
 */
export function roomTags(roomId: string): string[] {
  return [
    pushTag.conversation(roomId),
    pushTag.mention(roomId),
    pushTag.live(roomId),
    pushTag.added(roomId),
  ];
}
