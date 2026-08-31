/**
 * Who is LOOKING at a conversation right now.
 *
 * The one subtle rule behind read-at-delivery, shared by /chat and /community
 * so the two can never drift: presence is the socket's declared ACTIVE room
 * (`conv:join {active:true}` / `community:join {active:true}`), never its
 * membership of the broadcast room. Both clients subscribe to rooms they are
 * NOT looking at — the DM sidebar joins every visible thread for typing
 * indicators, the community sidebar subscribes for list bumps — so selecting on
 * room membership would mark half the inbox read.
 *
 * The sender is excluded: a sender is not a reader, and the room they sent to
 * may well be open in another of their tabs.
 *
 * Returns USER ids, deduped: read state is per-user, so one present device is
 * enough and a user with five tabs open is marked exactly once.
 */
export function presentReaders(
  sockets: ReadonlyArray<{ data: { userId?: string; [k: string]: unknown } }>,
  activeKey: "activeConvId" | "activeCommunityId",
  targetId: string,
  senderId: string
): string[] {
  const readers = new Set<string>();
  for (const s of sockets) {
    const viewerId = s.data.userId;
    if (!viewerId || viewerId === senderId) continue;
    if (s.data[activeKey] !== targetId) continue;
    readers.add(viewerId);
  }
  return [...readers];
}
