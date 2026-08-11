import { MEDIA_PREFIXES, toMediaObject } from "@aimess/storage";
import type { MediaObject } from "@aimess/shared-types";

import { avatarService } from "./avatar.service.js";
import { friendshipRepository } from "../repositories/friendship.repository.js";
import {
  buildRelationshipLookup,
  getFriendPeerIds,
  type PeerRelationship,
  type RelationshipStatus,
} from "../lib/relationship-lookup.js";
import { visibleIdentity, visibleIsOnline } from "../lib/privacy-scope.js";
import { splitBlocks } from "../lib/block-visibility.js";
import { userProfileRepository } from "../repositories/user-profile.repository.js";
import { recentUserSearchRepository } from "../repositories/recent-user-search.repository.js";
import { RecentSearchTargetType } from "../generated/prisma/client.js";
import {
  messagingGrpcClient,
  type GroupSummary,
} from "../grpc/messaging.client.js";
import { env } from "../config/env.js";
import { mediaUrlStrategy } from "../config/storage.js";
import type { UnifiedSearchQuery } from "../api/validators/user-search.validator.js";

const RECENT_LIMIT = 4;
const CHAT_LIMIT = 10;
// const OTHER_LIMIT = 10;
/** Cap on how many of the viewer's private-room peers we pull per request. */
const PRIVATE_ROOM_PEER_CAP = 500;

export type SearchUserItem = {
  type: "USER";
  userId: string;
  username: string;
  /** Null when `whoCanViewProfile` denies this viewer — see `visibleIdentity`. */
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  avatarUrl: string | null;
  avatarUrlExpiresIn: number | null;
  avatar: MediaObject;
  isOnline: boolean;
  /** Existing private-room id with the viewer, resolved dynamically; null if none. */
  roomId: string | null;
  /**
   * Explicit friendship indicator — an ACCEPTED friendship with the viewer,
   * independent of whether a private room (`roomId`) exists. Never infer
   * friendship from `roomId`.
   */
  isFriend: boolean;
  /** Relationship: FRIEND | PENDING | NONE. */
  relationshipStatus: RelationshipStatus;
  /**
   * The VIEWER blocked this user. Blocks are one-way, so such rows stay in the
   * blocker's results — this flag lets the client offer "Unblock" instead of a
   * friend-request action the API would reject with FRIEND_BLOCKED. Users who
   * blocked the viewer never reach the client at all, so this is never true in
   * the other direction.
   */
  isBlockedByMe: boolean;
  /** Friendship row id when FRIEND/PENDING; null when NONE. */
  friendshipId: string | null;
  /** Who sent the PENDING request; null when FRIEND/NONE. */
  requesterId: string | null;
  /**
   * Normalized relationship the FE merges live `friend:*` socket updates
   * into by `userId` — status/direction/action flags, never re-derived
   * client-side. Additive alongside the legacy flat fields above.
   */
  relationship: {
    status: RelationshipStatus;
    direction: "OUTGOING" | "INCOMING" | null;
    canAccept: boolean;
    canReject: boolean;
    canCancel: boolean;
  };
};

export type SearchGroupItem = {
  type: "GROUP";
  /** Also the group's stable id (chat-service GroupRoom.roomId). */
  roomId: string;
  name: string;
  avatar: string;
  description: string;
  memberCount: number;
  /**
   * True when the viewer is an ACTIVE member. `false` here does NOT mean "any
   * group that happens to match the query" — a row only exists at all when the
   * viewer is an active member OR the group is still in their conversation
   * list, so `false` specifically means "left/removed, conversation kept".
   */
  isActiveMember: boolean;
};

export type SearchResultItem = SearchUserItem | SearchGroupItem;

type BasicProfile = {
  userId: string;
  username: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  isOnline: boolean;
  privacySettings?: {
    whoCanSeeOnlineStatus?: string | null;
    whoCanViewProfile?: string | null;
  } | null;
};

async function resolveAvatar(stored: string | null) {
  const view = await avatarService.resolveViewUrlForClient(stored);
  const avatar = await toMediaObject({
    bucket: env.MINIO_BUCKET_AVATARS,
    stored,
    prefixes: MEDIA_PREFIXES.userAvatars,
    strategy: mediaUrlStrategy,
  });
  return {
    url: view?.url ?? null,
    expiresIn: view?.expiresIn ?? null,
    avatar,
  };
}

async function toUserItem(
  profile: BasicProfile,
  roomId: string | null,
  relationship: PeerRelationship,
  friendOfFriendIds: ReadonlySet<string>,
  blockedByMe: ReadonlySet<string>
): Promise<SearchUserItem> {
  // `whoCanViewProfile` — a denied viewer keeps the handle (the row must stay
  // actionable) but gets no real name and no photo.
  const identity = visibleIdentity(profile, {
    isFriend: relationship.isFriend,
    isFriendOfFriend: friendOfFriendIds.has(profile.userId),
  });
  const { url, expiresIn, avatar } = await resolveAvatar(
    identity.avatarAllowed ? profile.avatarUrl : null
  );
  return {
    type: "USER",
    userId: profile.userId,
    username: profile.username,
    firstName: identity.firstName,
    lastName: identity.lastName,
    fullName: identity.fullName,
    avatarUrl: url,
    avatarUrlExpiresIn: expiresIn,
    avatar,
    // `whoCanSeeOnlineStatus` — a denied viewer sees `false`, indistinguishable
    // from genuinely offline. Never leak the real flag here.
    isOnline: visibleIsOnline(profile, { isFriend: relationship.isFriend }),
    roomId,
    isFriend: relationship.isFriend,
    relationshipStatus: relationship.relationshipStatus,
    isBlockedByMe: blockedByMe.has(profile.userId),
    friendshipId: relationship.friendshipId,
    requesterId: relationship.requesterId,
    relationship: {
      status: relationship.relationshipStatus,
      direction: relationship.direction,
      canAccept: relationship.canAccept,
      canReject: relationship.canReject,
      canCancel: relationship.canCancel,
    },
  };
}

function toGroupItem(g: GroupSummary): SearchGroupItem {
  return {
    type: "GROUP",
    roomId: g.roomId,
    name: g.name,
    avatar: g.avatar,
    description: g.description,
    memberCount: g.memberCount,
    isActiveMember: g.isActiveMember,
  };
}

export const userSearchService = {
  /** Upsert a recently-viewed User/Group target — never stores roomId. */
  async recordRecent(params: {
    userId: string;
    targetType: "USER" | "GROUP";
    targetId: string;
  }): Promise<void> {
    await recentUserSearchRepository.upsert({
      userId: params.userId,
      targetType:
        params.targetType === "GROUP"
          ? RecentSearchTargetType.GROUP
          : RecentSearchTargetType.USER,
      targetId: params.targetId,
    });
  },

  /** Remove one recently-viewed target. Returns false if no matching row existed. */
  async removeRecent(params: {
    userId: string;
    targetType: "USER" | "GROUP";
    targetId: string;
  }): Promise<boolean> {
    const result = await recentUserSearchRepository.deleteOne({
      userId: params.userId,
      targetType:
        params.targetType === "GROUP"
          ? RecentSearchTargetType.GROUP
          : RecentSearchTargetType.USER,
      targetId: params.targetId,
    });
    return result.count > 0;
  },

  /** Clear every recently-viewed target for this user. */
  async clearRecent(userId: string): Promise<void> {
    await recentUserSearchRepository.clearAll(userId);
  },

  /** `q` empty/whitespace → Recent only. No search logic runs. */
  async searchRecent(
    viewerId: string
  ): Promise<{ recent: SearchResultItem[] }> {
    const [blocks, relationships, recentRows, peers] = await Promise.all([
      friendshipRepository.findAllBlocks(viewerId),
      friendshipRepository.findAllForUser(viewerId),
      recentUserSearchRepository.findByUserId(viewerId),
      messagingGrpcClient.listPrivateRoomPeers(viewerId, PRIVATE_ROOM_PEER_CAP),
    ]);

    const { hiddenIds, blockedByMe } = splitBlocks(viewerId, blocks);
    const relationshipOf = buildRelationshipLookup(viewerId, relationships);
    const viewerFriendIds = getFriendPeerIds(viewerId, relationships);
    // FRIENDS_OF_FRIENDS needs the one-hop expansion, not just direct friends.
    const viewerGraph = await friendshipRepository.resolveViewerGraph(
      viewerId,
      viewerFriendIds
    );
    // Reused for `whoCanViewProfile` masking on every row below — the same
    // one-hop set discovery already paid for, never a second traversal.
    const fofIds = new Set(viewerGraph.friendOfFriendIds);
    // `peers` arrives ordered by lastMessageAt desc from chat-service.
    const peerRoomByUserId = new Map(
      peers.map((p) => [p.peerUserId, p.roomId])
    );

    const recentUserIds = recentRows
      .filter((r) => r.targetType === RecentSearchTargetType.USER)
      .map((r) => r.targetId);
    const recentGroupIds = recentRows
      .filter((r) => r.targetType === RecentSearchTargetType.GROUP)
      .map((r) => r.targetId);

    const [recentProfiles, recentGroups, recentRoomMatches] = await Promise.all(
      [
        recentUserIds.length
          ? userProfileRepository.findDiscoverableByUserIds(
              recentUserIds,
              viewerGraph
            )
          : Promise.resolve([]),
        recentGroupIds.length
          ? messagingGrpcClient.getGroupsByIds(viewerId, recentGroupIds)
          : Promise.resolve([]),
        recentUserIds.length
          ? messagingGrpcClient.resolvePrivateRooms(viewerId, recentUserIds)
          : Promise.resolve([]),
      ]
    );
    const recentProfileById = new Map(recentProfiles.map((p) => [p.userId, p]));
    const recentGroupById = new Map(recentGroups.map((g) => [g.roomId, g]));
    const recentRoomByUserId = new Map(
      recentRoomMatches.map((m) => [m.peerUserId, m.roomId])
    );

    const recent: SearchResultItem[] = [];
    for (const row of recentRows) {
      if (recent.length >= RECENT_LIMIT) break;
      if (row.targetType === RecentSearchTargetType.USER) {
        const profile = recentProfileById.get(row.targetId);
        // Only users who blocked the VIEWER drop out — a user the viewer
        // blocked stays in their own Recent list (they can still open and
        // unblock them).
        if (!profile || hiddenIds.has(profile.userId)) continue;
        recent.push(
          await toUserItem(
            profile,
            recentRoomByUserId.get(profile.userId) ??
              peerRoomByUserId.get(profile.userId) ??
              null,
            relationshipOf(profile.userId),
            fofIds,
            blockedByMe
          )
        );
      } else {
        const group = recentGroupById.get(row.targetId);
        if (!group) continue; // group deleted/disbanded since last view
        recent.push(toGroupItem(group));
      }
    }

    return { recent };
  },

  /** `q` has a value → Chat + Other only. Never returns Recent. */
  async searchByQuery(
    viewerId: string,
    query: UnifiedSearchQuery
  ): Promise<{ chat: SearchResultItem[]; other: SearchResultItem[] }> {
    const q = query.q?.trim() || undefined;
    const skip = (query.page - 1) * query.limit;
    const otherTake = query.limit;

    const [blocks, relationships, peers] = await Promise.all([
      friendshipRepository.findAllBlocks(viewerId),
      friendshipRepository.findAllForUser(viewerId),
      messagingGrpcClient.listPrivateRoomPeers(viewerId, PRIVATE_ROOM_PEER_CAP),
    ]);

    const { hiddenIds, blockedByMe } = splitBlocks(viewerId, blocks);
    const relationshipOf = buildRelationshipLookup(viewerId, relationships);
    // `peers` arrives ordered by lastMessageAt desc from chat-service; used
    // only to attach `roomId` metadata and to order friends by recency —
    // never to decide bucket membership.
    const peerRoomByUserId = new Map(
      peers.map((p) => [p.peerUserId, p.roomId])
    );
    const roomOrderIndex = new Map(peers.map((p, idx) => [p.peerUserId, idx]));
    const friendIds = getFriendPeerIds(viewerId, relationships).filter(
      (id) => !hiddenIds.has(id)
    );
    // Resolved once and reused by both buckets — a FRIENDS_OF_FRIENDS target is
    // discoverable when the viewer shares at least one mutual friend with them.
    const viewerGraph = await friendshipRepository.resolveViewerGraph(
      viewerId,
      friendIds
    );
    // Reused for `whoCanViewProfile` masking on every row below.
    const fofIds = new Set(viewerGraph.friendOfFriendIds);

    // ---------------------------------------------------------------------
    // Chat — max 10: accepted friends (isFriend === true), regardless of
    // whether a private room exists yet, + groups the viewer actively
    // belongs to.
    // ---------------------------------------------------------------------
    const [chatUserProfiles, chatGroupSummaries] = await Promise.all([
      friendIds.length
        ? userProfileRepository.findUsersInList(
            friendIds,
            q,
            0,
            CHAT_LIMIT,
            viewerGraph
          )
        : Promise.resolve([]),
      messagingGrpcClient.listActiveGroups(viewerId, q, CHAT_LIMIT),
    ]);

    // Friends with an existing room sort by recency first; roomless friends
    // fall to the end in query order.
    chatUserProfiles.sort(
      (a, b) =>
        (roomOrderIndex.get(a.userId) ?? Infinity) -
        (roomOrderIndex.get(b.userId) ?? Infinity)
    );

    const chat: SearchResultItem[] = [];
    for (const p of chatUserProfiles) {
      if (chat.length >= CHAT_LIMIT) break;
      chat.push(
        await toUserItem(
          p,
          peerRoomByUserId.get(p.userId) ?? null,
          relationshipOf(p.userId),
          fofIds,
          blockedByMe
        )
      );
    }
    for (const g of chatGroupSummaries) {
      if (chat.length >= CHAT_LIMIT) break;
      chat.push(toGroupItem(g));
    }
    const chatGroupIdSet = new Set(
      chat
        .filter((i): i is SearchGroupItem => i.type === "GROUP")
        .map((i) => i.roomId)
    );

    // ---------------------------------------------------------------------
    // Other — max `limit` (default 10, paginated): non-friends (isFriend
    // === false), plus groups the viewer is no longer an active member of but
    // which are STILL in their conversation list (left/removed, conversation
    // not deleted). Groups the viewer has no relationship with never reach
    // this bucket — chat-service enforces that, not this filter. A user here
    // may still carry a `roomId` (e.g. unfriended peers) — that's fine,
    // roomId is conversation metadata only and plays no role in bucketing.
    // ---------------------------------------------------------------------
    const excludeUserIds = [
      viewerId,
      // Blocks are one-way: only users who blocked the VIEWER are removed.
      // Users the viewer blocked stay searchable to their own blocker, carrying
      // `isBlockedByMe` so the row renders as blocked rather than addable.
      ...hiddenIds,
      ...friendIds, // only accepted friends are excluded from "other"
    ];
    const excludeGroupIds = [...chatGroupIdSet];

    const [otherUserProfiles, otherGroupSummaries] = await Promise.all([
      userProfileRepository.findUsersNotInList(
        excludeUserIds,
        q,
        skip,
        otherTake,
        viewerGraph
      ),
      messagingGrpcClient.listOtherGroups(
        viewerId,
        q,
        excludeGroupIds,
        otherTake
      ),
    ]);

    const other: SearchResultItem[] = [];
    for (const p of otherUserProfiles) {
      if (other.length >= otherTake) break;
      other.push(
        await toUserItem(
          p,
          peerRoomByUserId.get(p.userId) ?? null,
          relationshipOf(p.userId),
          fofIds,
          blockedByMe
        )
      );
    }
    for (const g of otherGroupSummaries) {
      if (other.length >= otherTake) break;
      other.push(toGroupItem(g));
    }

    return { chat, other };
  },
};
