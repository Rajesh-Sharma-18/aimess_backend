import type {
  PrivateRoomService,
  EnrichedPrivateRoom,
  PrivateRoomPeer,
  PeerFriendshipRelationship,
  PrivateConversationLastActivity,
} from "./private-room.service.js";
import { toPeerFriendshipRelationship } from "./private-room.service.js";
import type {
  GroupRoomService,
  EnrichedGroupRoom,
} from "./group-room.service.js";
import { toWireMessage } from "../lib/chat-message.serializer.js";

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
  /**
   * Telegram/WhatsApp-style tick for `lastMessage` — SENT/DELIVERED(PRIVATE only)/READ
   * when the CALLER sent it, else null (no tick on a peer/other-member's message).
   */
  lastMessageReadStatus: "SENT" | "DELIVERED" | "READ" | null;
  unreadCount: number;
  isMuted: boolean;
  pinnedCount: number;
  // PRIVATE-only
  peer: PrivateRoomPeer | null;
  /**
   * PRIVATE-only: community-style normalized last-activity DTO
   * ({type,userId,username,preview,dateTime}) — `username` always carries the
   * ACTUAL sender's live name (self included), so the client decides "You:" vs
   * "<name>:" purely from `userId === myUserId`, never from `peer.displayName`.
   * Null on GROUP rows (they carry sender info on `lastMessage` instead).
   */
  lastActivity: PrivateConversationLastActivity | null;
  /**
   * PRIVATE-only: user-search-shaped relationship metadata for the peer —
   * identical fields as `GET /api/v1/users/search` (isFriend, relationshipStatus,
   * friendshipId, requesterId, relationship{status,direction,can*}). All null
   * on GROUP rows.
   */
  isFriend: boolean | null;
  relationshipStatus: "FRIEND" | "PENDING" | "NONE" | null;
  friendshipId: string | null;
  requesterId: string | null;
  relationship: PeerFriendshipRelationship["relationship"] | null;
  // GROUP-only
  name: string | null;
  avatar: string | null;
  description: string | null;
  memberCount: number | null;
  role: string | null;
  /** GROUP-only: true when the caller is an active member; null for PRIVATE rows. */
  isJoined: boolean | null;
  /** GROUP-only: true when the caller voluntarily left; null for PRIVATE rows. */
  hasLeft: boolean | null;
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
    /** V2 keyset tiebreaker from a compound "<ms>_<roomId>" cursor. */
    boundaryId?: string | null;
    /** V1 inclusive bound (default); V2 passes false for a strict keyset. */
    inclusive?: boolean;
    /** V2 emits the compound "<ms>_<roomId>" token; V1 emits bare epoch-ms. */
    compoundCursor?: boolean;
    limit: number;
  }): Promise<InboxResult> {
    const { userId, direction, ts, boundaryId, inclusive, limit } = params;

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
          boundaryId,
          inclusive,
          limit: fetchLimit,
        }),
        this.groupRoomService.getInboxGroups({
          userId,
          direction,
          ts,
          boundaryId,
          inclusive,
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
        ? params.compoundCursor
          ? `${lastItem.lastMessageAt.getTime()}_${lastItem.roomId}`
          : String(lastItem.lastMessageAt.getTime())
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
    const rel = toPeerFriendshipRelationship(room.friendship);
    return {
      type: "PRIVATE",
      roomId: room.roomId,
      lastMessageAt: room.lastMessageAt,
      lastMessageId: room.lastMessageId,
      lastMessage: room.lastMessage ?? null,
      lastMessageReadStatus: room.lastMessageReadStatus ?? null,
      unreadCount: unreadByUser[userId] ?? 0,
      isMuted: room.isMuted,
      pinnedCount: room.pinnedCount,
      peer: room.peer,
      lastActivity: room.lastActivity,
      isFriend: rel.isFriend,
      relationshipStatus: rel.relationshipStatus,
      friendshipId: rel.friendshipId,
      requesterId: rel.requesterId,
      relationship: rel.relationship,
      name: null,
      avatar: null,
      description: null,
      memberCount: null,
      role: null,
      isJoined: null,
      hasLeft: null,
    };
  }

  private toGroupItem(room: EnrichedGroupRoom): InboxItem {
    return {
      type: "GROUP",
      roomId: room.roomId,
      lastMessageAt: room.lastMessageAt,
      lastMessageId: room.lastMessageId,
      // Normalize the group preview's kind field (messageType -> contentType).
      // (Private previews are already normalized upstream in enrichConversations.)
      lastMessage:
        room.lastMessagePreview && typeof room.lastMessagePreview === "object"
          ? toWireMessage(
              room.lastMessagePreview as { messageType?: string | null }
            )
          : (room.lastMessagePreview ?? null),
      lastMessageReadStatus: room.lastMessageReadStatus ?? null,
      unreadCount: room.unreadCount,
      isMuted: room.isMuted,
      pinnedCount: room.pinnedCount,
      peer: null,
      lastActivity: null,
      isFriend: null,
      relationshipStatus: null,
      friendshipId: null,
      requesterId: null,
      relationship: null,
      name: room.name,
      avatar: room.avatar,
      description: room.description,
      memberCount: room.memberCount,
      role: room.role,
      isJoined: room.isJoined,
      hasLeft: room.hasLeft,
    };
  }
}
