import type {
  GeneralRoomMessage,
  GroupMessage,
  PrivateMessage,
} from "../generated/prisma/index.js";
import type { MessageSearchRepository } from "../repositories/message-search.repository.js";
import type { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import type { GroupRoomRepository } from "../repositories/group-room.repository.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { GeneralRoomRepository } from "../repositories/general-room.repository.js";
import type { RoomMemberRepository } from "../repositories/room-member.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import { isVisibleToUser } from "../repositories/general-room-message.repository.js";
import {
  buildSearchCursor,
  newestSearchCursor,
} from "../repositories/message-search.js";
import {
  getGroupVisibilityCutoff,
  getPrivateDeletionCutoff,
  isHiddenByCutoff,
} from "../lib/deletion-cutoff.js";
import { resolveMediaUrlMap, urlFromMap } from "../lib/media-resolve.js";
import {
  resolveDisplayName,
  type UserSnapshotService,
} from "./user-snapshot.service.js";

export type SearchConversationType = "PRIVATE" | "GROUP" | "COMMUNITY";

/**
 * One match, flattened across the three conversation types so a client renders
 * a single list. `roomId` + `conversationType` are exactly the pair
 * `GET /api/chat/messages/:messageId/context` takes, so a row is directly
 * navigable.
 */
export interface MessageSearchHit {
  messageId: string;
  conversationType: SearchConversationType;
  roomId: string;
  conversationName: string;
  conversationAvatarUrl: string;
  senderId: string | null;
  senderName: string;
  text: string;
  createdAt: string;
}

/**
 * Over-fetch factor per collection. Room-scoped visibility (clear cutoffs, ban
 * cutoffs, personal messages) is applied AFTER the query, so asking for exactly
 * `limit` rows would under-fill a page whenever anything is filtered out.
 *
 * ponytail: one over-fetched round, not a fill loop. A page can come back short
 * when a caller has an unusual amount of cleared history; raise OVERFETCH or
 * loop if that shows up in practice.
 */
const OVERFETCH = 3;
const MAX_SCAN = 150;

interface RankedHit {
  at: number;
  id: string;
  hit: MessageSearchHit;
}

const textOf = (content: unknown): string => {
  const text = (content as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : "";
};

/**
 * Cross-conversation message-body search — the "Messages" section of global
 * search, alongside the conversation / community / people name matches the
 * gateway assembles from the other services.
 *
 * The permission model mirrors the per-room searches one for one: private rooms
 * the caller participates in, groups they are an ACTIVE member of, and community
 * rooms they hold an active or banned membership in (a banned member reads only
 * up to `bannedAt`). Every per-room cutoff is applied here, on the returned rows,
 * because a single `$in` query cannot carry one cutoff per room.
 */
export class MessageSearchService {
  constructor(
    private readonly searchRepo: MessageSearchRepository,
    private readonly privateRoomRepo: PrivateRoomRepository,
    private readonly groupRoomRepo: GroupRoomRepository,
    private readonly groupMemberRepo: GroupMemberRepository,
    private readonly generalRoomRepo: GeneralRoomRepository,
    private readonly roomMemberRepo: RoomMemberRepository,
    private readonly userSnapshotService: UserSnapshotService,
    private readonly cacheRepo: CacheRepository
  ) {}

  async search(params: {
    userId: string;
    query: string;
    limit: number;
    cursor?: string | null;
  }): Promise<{
    hits: MessageSearchHit[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    const { userId, query, limit, cursor } = params;
    const scan = Math.min(limit * OVERFETCH, MAX_SCAN);

    const [privateRooms, groupMembers, communityMembers] = await Promise.all([
      this.privateRoomRepo.findSearchScope(userId),
      this.groupMemberRepo.findSearchScope(userId),
      this.roomMemberRepo.findSearchScope(userId),
    ]);

    const privateCutoffs = new Map<string, Date | undefined>();
    const peerByRoom = new Map<string, string | null>();
    for (const room of privateRooms) {
      privateCutoffs.set(room.roomId, getPrivateDeletionCutoff(room, userId));
      peerByRoom.set(
        room.roomId,
        room.participants.find((id) => id !== userId) ?? null
      );
    }
    const groupCutoffs = new Map<string, Date | undefined>();
    for (const member of groupMembers) {
      groupCutoffs.set(member.roomId, getGroupVisibilityCutoff(member));
    }
    // A banned member keeps read access only up to the instant of the ban.
    const communityBanCutoffs = new Map<string, Date | null>();
    const communityActive = new Map<string, boolean>();
    for (const member of communityMembers) {
      const banned = member.status === "banned";
      communityBanCutoffs.set(member.roomId, banned ? member.bannedAt : null);
      communityActive.set(member.roomId, !banned);
    }

    const [priv, grp, comm] = await Promise.all([
      this.searchRepo.searchPrivate({
        roomIds: [...privateCutoffs.keys()],
        userId,
        query,
        cursor,
        limit: scan,
      }),
      this.searchRepo.searchGroup({
        roomIds: [...groupCutoffs.keys()],
        userId,
        query,
        cursor,
        limit: scan,
      }),
      this.searchRepo.searchCommunity({
        roomIds: [...communityActive.keys()],
        query,
        cursor,
        limit: scan,
      }),
    ]);

    const visiblePrivate = priv.messages.filter(
      (m) => !isHiddenByCutoff(m.createdAt, privateCutoffs.get(m.roomId))
    );
    const visibleGroup = grp.messages.filter(
      (m) => !isHiddenByCutoff(m.createdAt, groupCutoffs.get(m.roomId))
    );
    const visibleCommunity = comm.messages.filter((m) => {
      const banCutoff = communityBanCutoffs.get(m.roomId);
      if (banCutoff && m.createdAt > banCutoff) return false;
      const deletedBy = (m.deletedBy ?? []) as string[];
      if (deletedBy.includes(userId)) return false;
      return isVisibleToUser(m, userId, communityActive.get(m.roomId) ?? true);
    });

    // Same ordering key the three pipelines sorted on, so one cursor pages the
    // merged list.
    const ranked = [
      ...visiblePrivate.map((m) => this.rankPrivate(m)),
      ...visibleGroup.map((m) => this.rankGroup(m)),
      ...visibleCommunity.map((m) => this.rankCommunity(m)),
    ].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));

    const page = ranked.slice(0, limit);
    const hasMore =
      ranked.length > limit || priv.hasMore || grp.hasMore || comm.hasMore;
    const last = page[page.length - 1];
    // Per-room visibility filtering can empty the merged page while the legs still
    // have matches. Falling back to the shallowest leg floor keeps a cursor client
    // moving instead of stopping on {data:[], hasMore:true, nextCursor:null}; every
    // scanned row is strictly older than the request cursor, so it always advances.
    let nextCursor: string | null = null;
    if (hasMore) {
      nextCursor = last
        ? buildSearchCursor(new Date(last.at), last.id)
        : newestSearchCursor([priv.nextCursor, grp.nextCursor, comm.nextCursor]);
    }

    await this.decorate(page, peerByRoom);
    // A leg that cannot name where to resume is exhausted: hasMore never outlives
    // the cursor, or the client dead-ends on the next request.
    return {
      hits: page.map((r) => r.hit),
      hasMore: nextCursor !== null,
      nextCursor,
    };
  }

  private rankPrivate(m: PrivateMessage): RankedHit {
    return {
      at: m.createdAt.getTime(),
      id: m.id,
      hit: {
        messageId: m.id,
        conversationType: "PRIVATE",
        roomId: m.roomId,
        // Labels are filled by `decorate` from live snapshots / room rows.
        conversationName: "",
        conversationAvatarUrl: "",
        senderId: m.senderId ?? null,
        senderName: "",
        text: textOf(m.content),
        createdAt: m.createdAt.toISOString(),
      },
    };
  }

  private rankGroup(m: GroupMessage): RankedHit {
    return {
      at: m.createdAt.getTime(),
      id: m.id,
      hit: {
        messageId: m.id,
        conversationType: "GROUP",
        roomId: m.roomId,
        conversationName: "",
        conversationAvatarUrl: "",
        senderId: m.senderId ?? null,
        // Frozen-at-send name. `decorate` prefers the live snapshot when there
        // is one, so a rename shows without rewriting stored rows.
        senderName: m.senderName ?? "",
        text: textOf(m.content),
        createdAt: m.createdAt.toISOString(),
      },
    };
  }

  private rankCommunity(m: GeneralRoomMessage): RankedHit {
    return {
      at: m.createdAt.getTime(),
      id: m.id,
      hit: {
        messageId: m.id,
        conversationType: "COMMUNITY",
        roomId: m.roomId,
        conversationName: "",
        conversationAvatarUrl: "",
        senderId: m.sentBy ?? null,
        senderName: m.senderName ?? "",
        text: m.message ?? "",
        createdAt: m.createdAt.toISOString(),
      },
    };
  }

  /**
   * Fill in sender names and conversation labels for one page: three bulk
   * lookups plus one presign batch, however many rooms the page spans — never
   * per row.
   */
  private async decorate(
    page: RankedHit[],
    peerByRoom: Map<string, string | null>
  ): Promise<void> {
    if (!page.length) return;

    const groupRoomIds = new Set<string>();
    const communityRoomIds = new Set<string>();
    const userIds = new Set<string>();
    for (const { hit } of page) {
      if (hit.senderId) userIds.add(hit.senderId);
      if (hit.conversationType === "GROUP") groupRoomIds.add(hit.roomId);
      if (hit.conversationType === "COMMUNITY") communityRoomIds.add(hit.roomId);
      if (hit.conversationType === "PRIVATE") {
        const peer = peerByRoom.get(hit.roomId);
        if (peer) userIds.add(peer);
      }
    }

    const [snapshots, groupRooms, communityRooms] = await Promise.all([
      this.userSnapshotService.getUserSnapshotsMap([...userIds], this.cacheRepo),
      this.groupRoomRepo.findManyByRoomIds([...groupRoomIds]),
      this.generalRoomRepo.findManyByIds([...communityRoomIds]),
    ]);

    const groupById = new Map(groupRooms.map((r) => [r.roomId, r]));
    const communityById = new Map(communityRooms.map((r) => [r.id, r]));

    const avatarKeys: string[] = [];
    for (const snapshot of snapshots.values()) {
      if (typeof snapshot.avatar === "string") avatarKeys.push(snapshot.avatar);
    }
    for (const room of groupRooms) avatarKeys.push(room.avatar);
    for (const room of communityRooms) avatarKeys.push(room.logo ?? "");
    const urlMap = await resolveMediaUrlMap(avatarKeys);

    for (const { hit } of page) {
      if (hit.senderId) {
        const snapshot = snapshots.get(hit.senderId);
        // Stale beats blank: a degraded lookup keeps the frozen name.
        if (snapshot) hit.senderName = resolveDisplayName(snapshot);
      }
      if (hit.conversationType === "PRIVATE") {
        const peer = peerByRoom.get(hit.roomId) ?? null;
        const snapshot = peer ? snapshots.get(peer) : null;
        hit.conversationName = resolveDisplayName(snapshot);
        hit.conversationAvatarUrl = urlFromMap(
          urlMap,
          typeof snapshot?.avatar === "string" ? snapshot.avatar : ""
        );
      } else if (hit.conversationType === "GROUP") {
        const room = groupById.get(hit.roomId);
        hit.conversationName = room?.name ?? "";
        hit.conversationAvatarUrl = urlFromMap(urlMap, room?.avatar);
      } else {
        const room = communityById.get(hit.roomId);
        hit.conversationName = room?.name ?? "";
        hit.conversationAvatarUrl = urlFromMap(urlMap, room?.logo);
      }
    }
  }
}
