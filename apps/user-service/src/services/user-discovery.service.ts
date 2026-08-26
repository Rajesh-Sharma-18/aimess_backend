import { MEDIA_PREFIXES, toMediaObject } from "@aimess/storage";
import type { MediaObject } from "@aimess/shared-types";

import { avatarService } from "./avatar.service.js";
import { friendshipRepository } from "../repositories/friendship.repository.js";
import {
  canSendFriendRequest,
  canViewProfile,
  visibleIdentity,
  visibleIsOnline,
} from "../lib/privacy-scope.js";
import { userProfileRepository } from "../repositories/user-profile.repository.js";
import { splitBlocks } from "../lib/block-visibility.js";
import { messagingGrpcClient } from "../grpc/messaging.client.js";
import { communityGrpcClient } from "../grpc/community.client.js";
import { env } from "../config/env.js";
import { mediaUrlStrategy } from "../config/storage.js";
import type { SearchUsersQuery } from "../api/validators/user-discovery.validator.js";

export type RelationshipStatus = "FRIEND" | "PENDING" | "NONE";

export type UserDiscoveryResult = {
  userId: string;
  username: string;
  /** Null when the target's `whoCanViewProfile` excludes this viewer. */
  firstName: string | null;
  lastName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  avatarUrlExpiresIn: number | null;
  /**
   * Nested media object for the avatar. Inner fields are all null when no avatar
   * is set. Additive alongside the legacy `avatarUrl`/`avatarUrlExpiresIn`.
   */
  avatar: MediaObject;
  isOnline: boolean;
  /**
   * The VIEWER blocked this user. Blocks are one-way, so the blocker keeps
   * seeing (and can unblock) them; users who blocked the viewer never appear at
   * all, so this is never true in the other direction.
   */
  isBlockedByMe?: boolean;
  relationshipStatus?: RelationshipStatus;
  /**
   * Effective add-friend eligibility for this viewer — the target's
   * `whoCanSendFriendRequests` scope plus the self/block/friend/pending
   * preconditions (`canSendFriendRequest`), never the raw scope. Same field
   * user search and the public profile return; clients branch on it alone.
   */
  canSendRequest: boolean;
  friendshipId?: string | null;
  /** Who sent the PENDING request; null/absent when FRIEND/NONE. */
  requesterId?: string | null;
};

async function resolveAvatarUrl(
  avatarUrl: string | null
): Promise<{ url: string | null; expiresIn: number | null }> {
  const view = await avatarService.resolveViewUrlForClient(avatarUrl);
  return { url: view?.url ?? null, expiresIn: view?.expiresIn ?? null };
}

/** Builds the nested avatar MediaObject from the raw stored object key. */
async function resolveAvatarMedia(
  avatarUrl: string | null
): Promise<MediaObject> {
  return toMediaObject({
    bucket: env.MINIO_BUCKET_AVATARS,
    stored: avatarUrl,
    prefixes: MEDIA_PREFIXES.userAvatars,
    strategy: mediaUrlStrategy,
  });
}

const SPLIT_LIMIT = 5;

/** Which conversation an "Add Members" picker is filling, if any. */
export interface AddTargetRef {
  groupRoomId?: string;
  communityId?: string;
}

export const userDiscoveryService = {
  /**
   * The people an "Add Members" picker must NOT offer: everyone already an
   * ACTIVE member of the target group / community.
   *
   * Both lookups are owned by other services (chat-service holds group
   * membership, community-service holds community membership) and both already
   * expose the roster over gRPC, so this is a read, not a mirror. Both clients
   * fail OPEN — an outage degrades the picker to "shows everyone", and the add
   * endpoints still reject duplicates (`ALREADY_MEMBER`), so the worst case is
   * a wasted tap rather than an empty list.
   */
  async resolveExistingMemberIds(target: AddTargetRef): Promise<string[]> {
    const { groupRoomId, communityId } = target;
    if (!groupRoomId && !communityId) return [];
    const [groupMembers, communityMembers] = await Promise.all([
      groupRoomId
        ? messagingGrpcClient.getGroupMemberIds(groupRoomId)
        : Promise.resolve([] as string[]),
      communityId
        ? communityGrpcClient.getActiveMemberIds(communityId)
        : Promise.resolve([] as string[]),
    ]);
    return [...new Set([...groupMembers, ...communityMembers])];
  },

  /**
   * Split mode: runs friends and non-friends queries in parallel, returns
   * up to SPLIT_LIMIT results in each bucket. No pagination metadata.
   */
  async searchUsersSplit(
    viewerId: string,
    q: string | undefined,
    excludeUserIds: string[] = []
  ): Promise<{
    friends: UserDiscoveryResult[];
    otherPeople: UserDiscoveryResult[];
  }> {
    const [friendsResult, othersResult] = await Promise.all([
      userDiscoveryService._queryFriends(
        viewerId,
        q,
        0,
        SPLIT_LIMIT,
        excludeUserIds
      ),
      userDiscoveryService._queryOthers(
        viewerId,
        q,
        0,
        SPLIT_LIMIT,
        excludeUserIds
      ),
    ]);
    return { friends: friendsResult.users, otherPeople: othersResult.users };
  },

  async searchUsersGrouped(
    viewerId: string,
    params: SearchUsersQuery
  ): Promise<{
    friends: UserDiscoveryResult[];
    otherPeople: UserDiscoveryResult[];
    total: number;
  }> {
    const { q, page, limit } = params;
    const skip = (page - 1) * limit;

    const [allRelationships, allBlocks] = await Promise.all([
      friendshipRepository.findAllForUser(viewerId),
      friendshipRepository.findAllBlocks(viewerId),
    ]);

    const acceptedFriendIds = new Set<string>();
    const friendshipIdByPeer = new Map<string, string>();
    const pendingRelMap = new Map<
      string,
      { friendshipId: string; isRequester: boolean }
    >();

    for (const f of allRelationships) {
      const peerId = f.requesterId === viewerId ? f.addresseeId : f.requesterId;
      if (f.status === "ACCEPTED") {
        acceptedFriendIds.add(peerId);
        friendshipIdByPeer.set(peerId, f.id);
      } else if (f.status === "PENDING") {
        pendingRelMap.set(peerId, {
          friendshipId: f.id,
          isRequester: f.requesterId === viewerId,
        });
      }
    }

    const { hiddenIds, blockedByMe } = splitBlocks(viewerId, allBlocks);
    const excludeIds = [viewerId, ...hiddenIds];
    const viewerFriendIds = Array.from(acceptedFriendIds);
    const viewerGraph = await friendshipRepository.resolveViewerGraph(
      viewerId,
      viewerFriendIds
    );
    const fofIds = new Set(viewerGraph.friendOfFriendIds);

    const [profiles, total] = await Promise.all([
      userProfileRepository.findUsersNotInList(
        excludeIds,
        q,
        skip,
        limit,
        viewerGraph
      ),
      userProfileRepository.countUsersNotInList(excludeIds, q, viewerGraph),
    ]);

    const resolved = await Promise.all(
      profiles.map(async (p) => {
        const isFriend = acceptedFriendIds.has(p.userId);
        const relation = {
          isFriend,
          isFriendOfFriend: fofIds.has(p.userId),
        };
        const identity = visibleIdentity(p, relation);
        const storedAvatar = identity.avatarAllowed ? p.avatarUrl : null;
        const { url, expiresIn } = await resolveAvatarUrl(storedAvatar);
        const avatar = await resolveAvatarMedia(storedAvatar);
        const base = {
          userId: p.userId,
          username: p.username,
          firstName: identity.firstName,
          lastName: identity.lastName,
          bio: canViewProfile(p, relation) ? p.bio : null,
          avatarUrl: url,
          avatarUrlExpiresIn: expiresIn,
          avatar,
          isOnline: visibleIsOnline(p, { isFriend }),
          isBlockedByMe: blockedByMe.has(p.userId),
        };

        if (isFriend) {
          return {
            ...base,
            isFriend: true,
            relationshipStatus: "FRIEND" as RelationshipStatus,
            canSendRequest: false,
            friendshipId: friendshipIdByPeer.get(p.userId) ?? null,
            requesterId: null,
          };
        }
        const pending = pendingRelMap.get(p.userId);
        const relationshipStatus = (pending
          ? "PENDING"
          : "NONE") as RelationshipStatus;
        return {
          ...base,
          isFriend: false,
          relationshipStatus,
          // Same gate `friendshipService.sendRequest` enforces.
          canSendRequest: canSendFriendRequest(p, relation, {
            status: relationshipStatus,
            isBlockedEitherWay: blockedByMe.has(p.userId),
          }),
          friendshipId: pending?.friendshipId ?? null,
          requesterId: pending
            ? pending.isRequester
              ? viewerId
              : p.userId
            : null,
        };
      })
    );

    const friends: UserDiscoveryResult[] = [];
    const otherPeople: UserDiscoveryResult[] = [];
    for (const item of resolved) {
      const { isFriend, ...result } = item;
      if (isFriend) {
        friends.push(result);
      } else {
        otherPeople.push(result);
      }
    }

    return { friends, otherPeople, total };
  },

  async _queryFriends(
    viewerId: string,
    q: string | undefined,
    skip: number,
    limit: number,
    excludeUserIds: string[] = []
  ): Promise<{ users: UserDiscoveryResult[]; total: number }> {
    const friendships =
      await friendshipRepository.findAcceptedFriends(viewerId);
    if (friendships.length === 0) {
      return { users: [], total: 0 };
    }

    // Subtracted from the CANDIDATE set, not from the page: `total` and every
    // page boundary below are then computed over addable friends only.
    const excluded = new Set(excludeUserIds);
    const friendIds = friendships
      .map((f) => (f.requesterId === viewerId ? f.addresseeId : f.requesterId))
      .filter((id) => !excluded.has(id));
    if (friendIds.length === 0) {
      return { users: [], total: 0 };
    }

    const friendshipIdByPeer = new Map(
      friendships.map((f) => {
        const peerId =
          f.requesterId === viewerId ? f.addresseeId : f.requesterId;
        return [peerId, f.id];
      })
    );

    // Every row here is already a direct friend, so the one-hop expansion adds
    // nothing to who is visible — skip the extra query.
    const viewerGraph = { friendIds, friendOfFriendIds: [] };
    const [profiles, total] = await Promise.all([
      userProfileRepository.findUsersInList(
        friendIds,
        q,
        skip,
        limit,
        viewerGraph
      ),
      userProfileRepository.countUsersInList(friendIds, q, viewerGraph),
    ]);

    const users = await Promise.all(
      profiles.map(async (p) => {
        // NO_ONE applies even to accepted friends — name and avatar go with it.
        const identity = visibleIdentity(p, { isFriend: true });
        const storedAvatar = identity.avatarAllowed ? p.avatarUrl : null;
        const { url, expiresIn } = await resolveAvatarUrl(storedAvatar);
        const avatar = await resolveAvatarMedia(storedAvatar);
        return {
          userId: p.userId,
          username: p.username,
          firstName: identity.firstName,
          lastName: identity.lastName,
          bio: canViewProfile(p, { isFriend: true }) ? p.bio : null,
          avatarUrl: url,
          avatarUrlExpiresIn: expiresIn,
          avatar,
          isOnline: visibleIsOnline(p, { isFriend: true }),
          relationshipStatus: "FRIEND" as RelationshipStatus,
          // Already friends — there is nothing to request.
          canSendRequest: false,
          friendshipId: friendshipIdByPeer.get(p.userId) ?? null,
          requesterId: null,
        };
      })
    );

    return { users, total };
  },

  async _queryOthers(
    viewerId: string,
    q: string | undefined,
    skip: number,
    limit: number,
    excludeUserIds: string[] = []
  ): Promise<{ users: UserDiscoveryResult[]; total: number }> {
    const [allRelationships, allBlocks] = await Promise.all([
      friendshipRepository.findAllForUser(viewerId),
      friendshipRepository.findAllBlocks(viewerId),
    ]);

    const acceptedFriendIds = new Set<string>();
    const pendingRelMap = new Map<
      string,
      { friendshipId: string; isRequester: boolean }
    >();

    for (const f of allRelationships) {
      const peerId = f.requesterId === viewerId ? f.addresseeId : f.requesterId;
      if (f.status === "ACCEPTED") {
        acceptedFriendIds.add(peerId);
      } else if (f.status === "PENDING") {
        pendingRelMap.set(peerId, {
          friendshipId: f.id,
          isRequester: f.requesterId === viewerId,
        });
      }
    }

    const { hiddenIds, blockedByMe } = splitBlocks(viewerId, allBlocks);

    const viewerFriendIds = Array.from(acceptedFriendIds);
    const viewerGraph = await friendshipRepository.resolveViewerGraph(
      viewerId,
      viewerFriendIds
    );
    const fofIds = new Set(viewerGraph.friendOfFriendIds);
    // `excludeUserIds` (existing members of an "Add Members" target) joins the
    // same id-set the query already subtracts, so exclusion costs nothing extra
    // and `total`/`hasNext` stay honest.
    const excludeIds = [
      viewerId,
      ...viewerFriendIds,
      ...hiddenIds,
      ...excludeUserIds,
    ];

    const [profiles, total] = await Promise.all([
      userProfileRepository.findUsersNotInList(
        excludeIds,
        q,
        skip,
        limit,
        viewerGraph
      ),
      userProfileRepository.countUsersNotInList(excludeIds, q, viewerGraph),
    ]);

    const users = await Promise.all(
      profiles.map(async (p) => {
        const pending = pendingRelMap.get(p.userId);
        let relationshipStatus: RelationshipStatus = "NONE";
        let friendshipId: string | null = null;
        let requesterId: string | null = null;
        if (pending) {
          relationshipStatus = "PENDING";
          friendshipId = pending.friendshipId;
          requesterId = pending.isRequester ? viewerId : p.userId;
        }
        // Non-friends by construction (accepted friends are excluded above).
        const relation = {
          isFriend: false,
          isFriendOfFriend: fofIds.has(p.userId),
        };
        const identity = visibleIdentity(p, relation);
        const storedAvatar = identity.avatarAllowed ? p.avatarUrl : null;
        const { url, expiresIn } = await resolveAvatarUrl(storedAvatar);
        const avatar = await resolveAvatarMedia(storedAvatar);
        return {
          userId: p.userId,
          username: p.username,
          firstName: identity.firstName,
          lastName: identity.lastName,
          bio: canViewProfile(p, relation) ? p.bio : null,
          avatarUrl: url,
          avatarUrlExpiresIn: expiresIn,
          avatar,
          isOnline: visibleIsOnline(p, { isFriend: false }),
          isBlockedByMe: blockedByMe.has(p.userId),
          relationshipStatus,
          // Same gate `friendshipService.sendRequest` enforces.
          canSendRequest: canSendFriendRequest(p, relation, {
            status: relationshipStatus,
            isBlockedEitherWay: blockedByMe.has(p.userId),
          }),
          friendshipId,
          requesterId,
        };
      })
    );

    return { users, total };
  },
  async _queryAll(
    viewerId: string,
    q: string | undefined,
    skip: number,
    limit: number
  ): Promise<{ users: UserDiscoveryResult[]; total: number }> {
    // Friends are NOT excluded from this bucket, but the friend set is still
    // needed: it decides who passes a FRIENDS-scoped whoCanFindMe and whose
    // presence/bio this viewer may see.
    const [allBlocks, friendships] = await Promise.all([
      friendshipRepository.findAllBlocks(viewerId),
      friendshipRepository.findAcceptedFriends(viewerId),
    ]);
    const { hiddenIds, blockedByMe } = splitBlocks(viewerId, allBlocks);

    const friendIdSet = new Set(
      friendships.map((f) =>
        f.requesterId === viewerId ? f.addresseeId : f.requesterId
      )
    );
    const viewerFriendIds = Array.from(friendIdSet);
    const viewerGraph = await friendshipRepository.resolveViewerGraph(
      viewerId,
      viewerFriendIds
    );
    const fofIds = new Set(viewerGraph.friendOfFriendIds);
    const excludeIds = [viewerId, ...hiddenIds];

    const [profiles, total] = await Promise.all([
      userProfileRepository.findUsersNotInList(
        excludeIds,
        q,
        skip,
        limit,
        viewerGraph
      ),
      userProfileRepository.countUsersNotInList(excludeIds, q, viewerGraph),
    ]);

    const users = await Promise.all(
      profiles.map(async (p) => {
        const isFriend = friendIdSet.has(p.userId);
        const relation = {
          isFriend,
          isFriendOfFriend: fofIds.has(p.userId),
        };
        const identity = visibleIdentity(p, relation);
        const storedAvatar = identity.avatarAllowed ? p.avatarUrl : null;
        const { url, expiresIn } = await resolveAvatarUrl(storedAvatar);
        const avatar = await resolveAvatarMedia(storedAvatar);
        return {
          userId: p.userId,
          username: p.username,
          firstName: identity.firstName,
          lastName: identity.lastName,
          bio: canViewProfile(p, relation) ? p.bio : null,
          avatarUrl: url,
          avatarUrlExpiresIn: expiresIn,
          avatar,
          isOnline: visibleIsOnline(p, { isFriend }),
          isBlockedByMe: blockedByMe.has(p.userId),
          // This bucket carries no relationshipStatus, so PENDING is unknown
          // here — the flag answers the privacy half only, and the profile /
          // search response is authoritative once a row is opened.
          canSendRequest: canSendFriendRequest(p, relation, {
            status: isFriend ? "FRIEND" : "NONE",
            isBlockedEitherWay: blockedByMe.has(p.userId),
          }),
        };
      })
    );

    return { users, total };
  },
};
