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
  GroupConversationLastActivity,
} from "./group-room.service.js";
import { toWireMessage } from "../lib/chat-message.serializer.js";
import {
  localizedActivityPreview,
  withLocalizedSystemPreview,
} from "../lib/localize-system-preview.js";
import {
  buildAutoDeleteWire,
  readPolicyVersion,
  readRoomAutoDelete,
} from "../lib/auto-delete.js";

export type InboxDirection = "before" | "after";

/**
 * A single normalized entry in the unified inbox — either a 1:1 private room
 * or a group chat. Type-specific fields are populated per `type`; the rest are
 * null for the other kind so the client can render a single list uniformly.
 */
export interface InboxItem {
  type: "PRIVATE" | "GROUP";
  roomId: string;
  /**
   * The SHARED room snapshot timestamp — what the underlying repository queries
   * page on. It is deliberately NOT per-viewer: after a delete-for-me / clear it
   * still points at a message this viewer can no longer see. Render and sort on
   * `lastActivity.dateTime` (always present now, on GROUP rows too), which is the
   * per-viewer effective value; keep using this one only for cursors.
   */
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
   * Community-style normalized last-activity DTO
   * ({type,userId,username,preview,dateTime}) — `username` always carries the
   * ACTUAL sender's live name (self included), so the client decides "You:" vs
   * "<name>:" purely from `userId === myUserId`, never from `peer.displayName`.
   *
   * Populated for GROUP rows too (it used to be PRIVATE-only, hardcoded null),
   * because this is the ONE field carrying the PER-VIEWER effective timestamp:
   * `lastMessageAt` is the shared snapshot and stays stale for a viewer who
   * deleted-for-me or cleared. `dateTime === 0` = nothing visible remains.
   */
  lastActivity:
    | PrivateConversationLastActivity
    | GroupConversationLastActivity
    | null;
  /**
   * Epoch-ms mirror of `lastActivity.dateTime` — the PER-VIEWER effective
   * timestamp, and the one a list row must RENDER and SORT on.
   *
   * It used to be missing from this DTO even though both enriched rooms already
   * carried it, which left every client with only `lastMessageAt` (the shared
   * snapshot) to render. A group row therefore showed the shared timestamp next
   * to its per-viewer preview, so the list read "2:12 PM" while the newest
   * message the viewer can actually see in that chat was from yesterday. Same
   * divergence on a private row carrying a reaction overlay, whose
   * `lastActivity.dateTime` is deliberately newer than `lastActivityAt` was.
   *
   * `0` = this viewer has nothing visible left (cleared / deleted-for-me the
   * whole tail) — render no timestamp, do NOT fall back to `lastMessageAt`.
   */
  lastActivityAt: number;
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
  /** GROUP-only: true when an admin REMOVED the caller (kicked). Read-only row,
   *  same as `hasLeft`, different notice wording. Null for PRIVATE rows. */
  isRemoved: boolean | null;
  /** GROUP-only: raw `GroupMember.status` ("ACTIVE" | "LEFT" | "KICKED") so the
   *  client renders the right composer state on a cold start without inferring
   *  it from `isJoined === false`. Null for PRIVATE rows. */
  membershipStatus: string | null;
  /**
   * GROUP-only: an admin/moderator has silenced the CALLER (read stays open,
   * every write is rejected with CHAT_MUTED_IN_GROUP). Distinct from `isMuted`,
   * the caller's own NOTIFICATION mute. `getInboxGroups` already computed this
   * — the unified inbox simply dropped it on the floor, so a client that was
   * offline when the mute landed had no way to restore its disabled composer
   * on a cold start. Null for PRIVATE rows.
   */
  isMemberMuted: boolean | null;
  /** GROUP-only: ISO-8601 expiry of a timed member-mute; null = indefinite. */
  memberMutedUntil: string | null;
  /** GROUP-only: epoch-ms mirror of `memberMutedUntil` (§6 — every timestamp a
   *  client consumes is an integer epoch-ms UTC). null = indefinite / not muted. */
  memberMutedUntilMs: number | null;
  /**
   * GROUP-only: the group was disbanded by an admin. Membership stays ACTIVE
   * (history remains readable) so `membershipStatus` cannot express this — but
   * every write is rejected with CHAT_GROUP_DISBANDED. Carried on the row so a
   * cold open renders the read-only composer without waiting for the
   * `group:disbanded` socket event. Null for PRIVATE rows.
   */
  isDisbanded: boolean | null;
  /**
   * The room's effective auto-delete policy — the SAME DTO the
   * GET/PUT `/auto-delete` endpoints and the `conv:auto_delete:updated` socket
   * event return (see `lib/auto-delete.ts#buildAutoDeleteWire`), including
   * `capabilities.supportsAfterViewing` and the caller's `canEdit`.
   *
   * Carried on the row so a cold-started client can render the timer icon on
   * every conversation from ONE inbox response, instead of issuing a per-room
   * request for a field that is three integers wide.
   */
  autoDelete: Record<string, unknown>;
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
/**
 * The per-viewer effective activity timestamp a row must be ORDERED by:
 * `lastActivity.dateTime` (0 when the viewer has nothing visible left), falling
 * back to the shared snapshot only for a row that somehow carries no activity
 * DTO at all.
 */
function effectiveAt(item: InboxItem): number {
  return item.lastActivityAt;
}

/**
 * The same resolution applied while BUILDING a row: the activity DTO's own
 * timestamp, falling back to the shared snapshot only for a row that carries no
 * activity DTO at all. Keeps `lastActivityAt` (what the client renders) and the
 * display sort below reading one value.
 */
function effectiveAtOf(
  lastActivity:
    | PrivateConversationLastActivity
    | GroupConversationLastActivity
    | null
    | undefined,
  lastMessageAt: Date | null
): number {
  if (lastActivity) return lastActivity.dateTime;
  return lastMessageAt ? lastMessageAt.getTime() : 0;
}

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
      ...groupRooms.map((room) => this.toGroupItem(room, userId)),
    ];

    // PAGE SELECTION stays on the SHARED `lastMessageAt` — that is the column
    // both repository queries bound on, so which rows belong to this page (and
    // the cursor that continues it) must be decided by the same key. Choosing
    // the page by the per-viewer timestamp instead would let a row with a newer
    // shared timestamp fall out of the page while the cursor moved past it —
    // silently skipping it forever.
    const bySharedTs = (a: InboxItem, b: InboxItem): number => {
      const at = a.lastMessageAt ? a.lastMessageAt.getTime() : 0;
      const bt = b.lastMessageAt ? b.lastMessageAt.getTime() : 0;
      if (at !== bt) return direction === "before" ? bt - at : at - bt;
      return direction === "before"
        ? b.roomId.localeCompare(a.roomId)
        : a.roomId.localeCompare(b.roomId);
    };
    merged.sort(bySharedTs);

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

    // DISPLAY order is per-viewer (Telegram-style): a row whose last visible
    // message this viewer deleted or cleared sits where its previous visible
    // message actually is, not where the shared snapshot puts it. Applied to the
    // already-selected page only, so pagination is byte-identical to before.
    // A row that drops a long way can therefore trail into a later page's range;
    // clients merge pages and re-sort on `lastActivity.dateTime` anyway, which is
    // exactly the field this order is derived from.
    page.sort((a, b) => {
      const at = effectiveAt(a);
      const bt = effectiveAt(b);
      if (at !== bt) return direction === "before" ? bt - at : at - bt;
      return direction === "before"
        ? b.roomId.localeCompare(a.roomId)
        : a.roomId.localeCompare(b.roomId);
    });

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
      // SYSTEM previews are re-rendered from the snapshot's systemEvent/
      // systemData in THIS reader's language — the same rebuild the message
      // history does — so the list row and the transcript never disagree.
      lastMessage:
        withLocalizedSystemPreview(
          room.lastMessage as Parameters<typeof withLocalizedSystemPreview>[0],
          "PRIVATE",
          userId
        ) ?? null,
      lastMessageReadStatus: room.lastMessageReadStatus ?? null,
      unreadCount: unreadByUser[userId] ?? 0,
      isMuted: room.isMuted,
      pinnedCount: room.pinnedCount,
      peer: room.peer,
      lastActivity: room.lastActivity,
      lastActivityAt: effectiveAtOf(room.lastActivity, room.lastMessageAt),
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
      isRemoved: null,
      membershipStatus: null,
      isMemberMuted: null,
      memberMutedUntil: null,
      memberMutedUntilMs: null,
      isDisbanded: null,
      autoDelete: buildAutoDeleteWire(readRoomAutoDelete(room), {
        conversationType: "PRIVATE",
        policyVersion: readPolicyVersion(room),
        // Either participant may change a private conversation's timer.
        canEdit: true,
      }),
    };
  }

  private toGroupItem(room: EnrichedGroupRoom, userId: string): InboxItem {
    // Same per-reader SYSTEM rebuild as the private row above, applied BEFORE
    // the wire normalization so it sees the stored `messageType`.
    const groupPreview = withLocalizedSystemPreview(
      room.lastMessagePreview as Parameters<
        typeof withLocalizedSystemPreview
      >[0],
      "GROUP",
      userId
    );
    return {
      type: "GROUP",
      roomId: room.roomId,
      lastMessageAt: room.lastMessageAt,
      lastMessageId: room.lastMessageId,
      // Normalize the group preview's kind field (messageType -> contentType).
      // (Private previews are already normalized upstream in enrichConversations.)
      lastMessage:
        groupPreview && typeof groupPreview === "object"
          ? toWireMessage(groupPreview as { messageType?: string | null })
          : (groupPreview ?? null),
      lastMessageReadStatus: room.lastMessageReadStatus ?? null,
      unreadCount: room.unreadCount,
      isMuted: room.isMuted,
      pinnedCount: room.pinnedCount,
      peer: null,
      // The normalized activity line previews the SAME message as `lastMessage`
      // above, so it has to follow the same language or one row shows two.
      lastActivity:
        room.lastActivity && groupPreview
          ? {
              ...room.lastActivity,
              preview: localizedActivityPreview(
                String(room.lastActivity.preview ?? ""),
                groupPreview,
                "GROUP",
                userId
              ),
            }
          : room.lastActivity,
      lastActivityAt: effectiveAtOf(room.lastActivity, room.lastMessageAt),
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
      isRemoved: room.isRemoved ?? false,
      membershipStatus: room.membershipStatus ?? null,
      isMemberMuted: room.isMemberMuted ?? false,
      memberMutedUntil: room.memberMutedUntil ?? null,
      memberMutedUntilMs: room.memberMutedUntilMs ?? null,
      isDisbanded: room.status === "DISBANDED",
      autoDelete: buildAutoDeleteWire(readRoomAutoDelete(room), {
        conversationType: "GROUP",
        policyVersion: readPolicyVersion(room),
        // Only ADMIN/MODERATOR may change a group's timer — same rule the PUT
        // enforces, surfaced so the client can grey out the picker rather than
        // discovering it via a 403.
        canEdit: room.role === "ADMIN" || room.role === "MODERATOR",
      }),
    };
  }
}
