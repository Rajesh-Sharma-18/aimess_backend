import { MEDIA_PREFIXES, toMediaObject } from "@aimess/storage";
import type { MediaObject } from "@aimess/shared-types";

import { avatarService } from "./avatar.service.js";
import { friendshipRepository } from "../repositories/friendship.repository.js";
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

/** Case-insensitive substring match across any of the given fields. */
function matchesQuery(
  q: string | undefined,
  ...fields: Array<string | null | undefined>
): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return fields.some((f) => (f ?? "").toLowerCase().includes(needle));
}

async function toUserItem(
  profile: BasicProfile,
  roomId: string | null
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

  async search(
    viewerId: string,
    query: UnifiedSearchQuery
  ): Promise<{
    recent: SearchResultItem[];
    chat: SearchResultItem[];
    other: SearchResultItem[];
  }> {
    const q = query.q?.trim() || undefined;
    const skip = (query.page - 1) * query.limit;
    const otherTake = query.limit;

    const [blocks, recentRows, peers] = await Promise.all([
      friendshipRepository.findAllBlocks(viewerId),
      recentUserSearchRepository.findByUserId(viewerId),
      messagingGrpcClient.listPrivateRoomPeers(viewerId, PRIVATE_ROOM_PEER_CAP),
    ]);

    const blockedIds = new Set(
      blocks.map((b) => (b.blockerId === viewerId ? b.blockedId : b.blockerId))
    );
    // `peers` arrives ordered by lastMessageAt desc from chat-service.
    const peerRoomByUserId = new Map(
      peers.map((p) => [p.peerUserId, p.roomId])
    );
    const chatPeerIds = [...peerRoomByUserId.keys()].filter(
      (id) => !blockedIds.has(id)
    );

    // ---------------------------------------------------------------------
    // Recent — latest 4 (after q filter), roomId resolved dynamically.
    // ---------------------------------------------------------------------
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
        if (
          !matchesQuery(
            q,
            profile.username,
            profile.firstName,
            profile.lastName,
            `${profile.firstName} ${profile.lastName}`
          )
        )
          continue;
        recent.push(
          await toUserItem(
            profile,
            recentRoomByUserId.get(profile.userId) ??
              peerRoomByUserId.get(profile.userId) ??
              null
          )
        );
      } else {
        const group = recentGroupById.get(row.targetId);
        if (!group) continue; // group deleted/disbanded since last view
        if (!matchesQuery(q, group.name)) continue;
        recent.push(toGroupItem(group));
      }
    }
    const recentUserIdSet = new Set(
      recent
        .filter((i): i is SearchUserItem => i.type === "USER")
        .map((i) => i.userId)
    );
    const recentGroupIdSet = new Set(
      recent
        .filter((i): i is SearchGroupItem => i.type === "GROUP")
        .map((i) => i.roomId)
    );

    // ---------------------------------------------------------------------
    // Chat — max 10: private peers with a room + groups the viewer actively
    // belongs to. Without q, take the most-recently-active peers first.
    // ---------------------------------------------------------------------
    const chatCandidateIds = q ? chatPeerIds : chatPeerIds.slice(0, CHAT_LIMIT);
    const [chatUserProfiles, chatGroupSummaries] = await Promise.all([
      chatCandidateIds.length
        ? userProfileRepository.findUsersInList(
            chatCandidateIds,
            q,
            0,
            CHAT_LIMIT
          )
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
      chat.push(await toUserItem(p, peerRoomByUserId.get(p.userId) ?? null));
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
    // groups the viewer isn't an active member of. Excludes Recent + Chat.
    // ---------------------------------------------------------------------
    const excludeUserIds = [
      viewerId,
      ...blockedIds,
      ...chatPeerIds, // anyone with an existing room is never "other"
    ];
    const excludeGroupIds = [...recentGroupIdSet, ...chatGroupIdSet];

    const [otherUserProfiles, otherGroupSummaries] = await Promise.all([
      userProfileRepository.findUsersNotInList(
        excludeUserIds,
        q,
        skip,
        otherTake + recentUserIdSet.size
      ),
      messagingGrpcClient.listOtherGroups(
        viewerId,
        q,
        excludeGroupIds,
        otherTake + recentGroupIdSet.size
      ),
    ]);

    const other: SearchResultItem[] = [];
    for (const p of otherUserProfiles) {
      if (other.length >= otherTake) break;
      if (recentUserIdSet.has(p.userId)) continue; // already surfaced in Recent
      other.push(await toUserItem(p, null));
    }
    for (const g of otherGroupSummaries) {
      if (other.length >= otherTake) break;
      if (recentGroupIdSet.has(g.roomId)) continue;
      other.push(toGroupItem(g));
    }

    return { recent, chat, other };
  },
};
