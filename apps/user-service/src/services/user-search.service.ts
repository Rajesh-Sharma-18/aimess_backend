import { MEDIA_PREFIXES, toMediaObject } from "@aimess/storage";
import type { MediaObject } from "@aimess/shared-types";

import { avatarService } from "./avatar.service.js";
import { friendshipRepository } from "../repositories/friendship.repository.js";
import {
  buildRelationshipLookup,
  type PeerRelationship,
  type RelationshipStatus,
} from "../lib/relationship-lookup.js";
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
  firstName: string;
  lastName: string;
  fullName: string;
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
  /** Friendship row id when FRIEND/PENDING; null when NONE. */
  friendshipId: string | null;
  /** Who sent the PENDING request; null when FRIEND/NONE. */
  requesterId: string | null;
};

export type SearchGroupItem = {
  type: "GROUP";
  /** Also the group's stable id (chat-service GroupRoom.roomId). */
  roomId: string;
  name: string;
  avatar: string;
  description: string;
  memberCount: number;
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
  relationship: PeerRelationship
): Promise<SearchUserItem> {
  const { url, expiresIn, avatar } = await resolveAvatar(profile.avatarUrl);
  return {
    type: "USER",
    userId: profile.userId,
    username: profile.username,
    firstName: profile.firstName,
    lastName: profile.lastName,
    fullName: `${profile.firstName} ${profile.lastName}`.trim(),
    avatarUrl: url,
    avatarUrlExpiresIn: expiresIn,
    avatar,
    isOnline: profile.isOnline,
    roomId,
    isFriend: relationship.isFriend,
    relationshipStatus: relationship.relationshipStatus,
    friendshipId: relationship.friendshipId,
    requesterId: relationship.requesterId,
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

    const blockedIds = new Set(
      blocks.map((b) => (b.blockerId === viewerId ? b.blockedId : b.blockerId))
    );
    const relationshipOf = buildRelationshipLookup(viewerId, relationships);
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
          ? userProfileRepository.findByUserIds(recentUserIds)
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
        if (!profile || blockedIds.has(profile.userId)) continue;
        recent.push(
          await toUserItem(
            profile,
            recentRoomByUserId.get(profile.userId) ??
              peerRoomByUserId.get(profile.userId) ??
              null,
            relationshipOf(profile.userId)
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

    const blockedIds = new Set(
      blocks.map((b) => (b.blockerId === viewerId ? b.blockedId : b.blockerId))
    );
    const relationshipOf = buildRelationshipLookup(viewerId, relationships);
    // `peers` arrives ordered by lastMessageAt desc from chat-service.
    const peerRoomByUserId = new Map(
      peers.map((p) => [p.peerUserId, p.roomId])
    );
    const chatPeerIds = [...peerRoomByUserId.keys()].filter(
      (id) => !blockedIds.has(id)
    );

    // ---------------------------------------------------------------------
    // Chat — max 10: private peers with a room + groups the viewer actively
    // belongs to.
    // ---------------------------------------------------------------------
    const [chatUserProfiles, chatGroupSummaries] = await Promise.all([
      chatPeerIds.length
        ? userProfileRepository.findUsersInList(chatPeerIds, q, 0, CHAT_LIMIT)
        : Promise.resolve([]),
      messagingGrpcClient.listActiveGroups(viewerId, q, CHAT_LIMIT),
    ]);

    const chatOrderIndex = new Map(chatPeerIds.map((id, idx) => [id, idx]));
    chatUserProfiles.sort(
      (a, b) =>
        (chatOrderIndex.get(a.userId) ?? 0) -
        (chatOrderIndex.get(b.userId) ?? 0)
    );

    const chat: SearchResultItem[] = [];
    for (const p of chatUserProfiles) {
      if (chat.length >= CHAT_LIMIT) break;
      chat.push(
        await toUserItem(
          p,
          peerRoomByUserId.get(p.userId) ?? null,
          relationshipOf(p.userId)
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
    // Other — max `limit` (default 10, paginated): users without a room,
    // groups the viewer isn't an active member of. Excludes Chat.
    // ---------------------------------------------------------------------
    const excludeUserIds = [
      viewerId,
      ...blockedIds,
      ...chatPeerIds, // anyone with an existing room is never "other"
    ];
    const excludeGroupIds = [...chatGroupIdSet];

    const [otherUserProfiles, otherGroupSummaries] = await Promise.all([
      userProfileRepository.findUsersNotInList(
        excludeUserIds,
        q,
        skip,
        otherTake
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
      other.push(await toUserItem(p, null, relationshipOf(p.userId)));
    }
    for (const g of otherGroupSummaries) {
      if (other.length >= otherTake) break;
      other.push(toGroupItem(g));
    }

    return { chat, other };
  },
};
