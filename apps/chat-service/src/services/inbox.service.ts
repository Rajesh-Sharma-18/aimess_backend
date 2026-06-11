import type {
  PrivateRoomService,
  EnrichedPrivateRoom,
  PrivateRoomPeer,
} from "./private-room.service.js";
import type {
  GroupRoomService,
  EnrichedGroupRoom,
} from "./group-room.service.js";

export type InboxDirection = "before" | "after";

/**
 * A single normalized entry in the unified inbox — either a 1:1 private room
 * or a group chat. Type-specific fields are populated per `type`; the rest are
 * null for the other kind so the client can render a single list uniformly.
 */
export interface InboxItem {
  type: "PRIVATE" | "GROUP";
  roomId: string;
  lastMessageAt: Date | null;
  lastMessageId: string | null;
  lastMessage: unknown | null;
  unreadCount: number;
  isMuted: boolean;
  pinnedCount: number;
  // PRIVATE-only
  peer: PrivateRoomPeer | null;
  // GROUP-only
  name: string | null;
  avatar: string | null;
  description: string | null;
  memberCount: number | null;
  role: string | null;
  /** GROUP-only: true when the caller is an active member; null for PRIVATE rows. */
  isJoined: boolean | null;
}

export interface InboxResult {
  items: InboxItem[];
  total: number;
  hasMore: boolean;
  /** Epoch-ms string to pass back as the next before_ts/after_ts, or null. */
  nextCursor: string | null;
}

/**
 * Merges a user's private rooms and group chats into one timestamp-ordered
 * list. Each side is queried with the same time bound + limit from its own
 * collection, then merged in memory and sliced to `limit`.
 *
 * - before_ts → lastMessageAt <= ts, newest-first (desc)
 * - after_ts  → lastMessageAt >= ts, oldest-first (asc)
 *
 * Boundaries are inclusive (as specified by the API contract), so consecutive
 * pages may share the boundary item when timestamps tie — clients should
 * de-duplicate by `roomId`.
 */
export class InboxService {
  constructor(
    private readonly privateRoomService: PrivateRoomService,
    private readonly groupRoomService: GroupRoomService
  ) {}

  async getInbox(params: {
    userId: string;
    direction: InboxDirection;
    ts: Date;
    limit: number;
  }): Promise<InboxResult> {
    const { userId, direction, ts, limit } = params;

    // Over-fetch one extra row per side so we can tell — after the in-memory
    // merge — whether a (limit+1)th item exists globally, giving an exact
    // `hasMore` instead of a per-side guess.
    const fetchLimit = limit + 1;

    const [privateRooms, groupRooms, privateTotal, groupTotal] =
      await Promise.all([
        this.privateRoomService.getInboxConversations({
          userId,
          direction,
          ts,
          limit: fetchLimit,
        }),
        this.groupRoomService.getInboxGroups({
          userId,
          direction,
          ts,
          limit: fetchLimit,
        }),
        this.privateRoomService.countConversations(userId),
        this.groupRoomService.countUserGroups(userId),
      ]);

    const merged: InboxItem[] = [
      ...privateRooms.map((room) => this.toPrivateItem(room, userId)),
      ...groupRooms.map((room) => this.toGroupItem(room)),
    ];

    // Sort by lastMessageAt in the requested direction, with roomId as a
    // deterministic tiebreaker so two items sharing the same millisecond order
    // identically here and in each repository query (stable cross-page order).
    merged.sort((a, b) => {
      const at = a.lastMessageAt ? a.lastMessageAt.getTime() : 0;
      const bt = b.lastMessageAt ? b.lastMessageAt.getTime() : 0;
      if (at !== bt) return direction === "before" ? bt - at : at - bt;
      return direction === "before"
        ? b.roomId.localeCompare(a.roomId)
        : a.roomId.localeCompare(b.roomId);
    });

    // `hasMore` is exact: with limit+1 fetched per side, a merged length beyond
    // `limit` is the only way more rows can remain.
    const hasMore = merged.length > limit;
    const page = merged.slice(0, limit);

    const lastItem = page[page.length - 1];
    const nextCursor =
      hasMore && lastItem?.lastMessageAt
        ? String(lastItem.lastMessageAt.getTime())
        : null;

    return {
      items: page,
      total: privateTotal + groupTotal,
      hasMore,
      nextCursor,
    };
  }

  private toPrivateItem(room: EnrichedPrivateRoom, userId: string): InboxItem {
    const unreadByUser = (room.unreadCountByUser ?? {}) as Record<
      string,
      number
    >;
    return {
      type: "PRIVATE",
      roomId: room.roomId,
      lastMessageAt: room.lastMessageAt,
      lastMessageId: room.lastMessageId,
      lastMessage: room.lastMessage ?? null,
      unreadCount: unreadByUser[userId] ?? 0,
      isMuted: room.isMuted,
      pinnedCount: room.pinnedCount,
      peer: room.peer,
      name: null,
      avatar: null,
      description: null,
      memberCount: null,
      role: null,
      isJoined: null,
    };
  }

  private toGroupItem(room: EnrichedGroupRoom): InboxItem {
    return {
      type: "GROUP",
      roomId: room.roomId,
      lastMessageAt: room.lastMessageAt,
      lastMessageId: room.lastMessageId,
      lastMessage: room.lastMessagePreview ?? null,
      unreadCount: room.unreadCount,
      isMuted: room.isMuted,
      pinnedCount: room.pinnedCount,
      peer: null,
      name: room.name,
      avatar: room.avatar,
      description: room.description,
      memberCount: room.memberCount,
      role: room.role,
      isJoined: room.isJoined,
    };
  }
}
