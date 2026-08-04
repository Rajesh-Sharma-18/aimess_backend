import { MEDIA_PREFIXES, toMediaObject } from "@aimess/storage";
import type { MediaObject } from "@aimess/shared-types";

import { avatarService } from "./avatar.service.js";
import { friendshipRepository } from "../repositories/friendship.repository.js";
import { canViewProfile, visibleIsOnline } from "../lib/privacy-scope.js";
import { userProfileRepository } from "../repositories/user-profile.repository.js";
import { env } from "../config/env.js";
import { mediaUrlStrategy } from "../config/storage.js";
import type { SearchUsersQuery } from "../api/validators/user-discovery.validator.js";

export type RelationshipStatus = "FRIEND" | "PENDING" | "NONE";

export type UserDiscoveryResult = {
  userId: string;
  username: string;
  firstName: string;
  lastName: string;
  bio: string | null;
  avatarUrl: string | null;
  avatarUrlExpiresIn: number | null;
  /**
   * Nested media object for the avatar. Inner fields are all null when no avatar
   * is set. Additive alongside the legacy `avatarUrl`/`avatarUrlExpiresIn`.
   */
  avatar: MediaObject;
  isOnline: boolean;
  relationshipStatus?: RelationshipStatus;
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

export const userDiscoveryService = {
  /**
   * Split mode: runs friends and non-friends queries in parallel, returns
   * up to SPLIT_LIMIT results in each bucket. No pagination metadata.
   */
  async searchUsersSplit(
    viewerId: string,
    q: string | undefined
  ): Promise<{
    friends: UserDiscoveryResult[];
    otherPeople: UserDiscoveryResult[];
  }> {
    const [friendsResult, othersResult] = await Promise.all([
      userDiscoveryService._queryFriends(viewerId, q, 0, SPLIT_LIMIT),
      userDiscoveryService._queryOthers(viewerId, q, 0, SPLIT_LIMIT),
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

    const blockedIds = new Set<string>(
      allBlocks.map((b) =>
        b.blockerId === viewerId ? b.blockedId : b.blockerId
      )
    );
    const excludeIds = [viewerId, ...Array.from(blockedIds)];
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
        const { url, expiresIn } = await resolveAvatarUrl(p.avatarUrl);
        const avatar = await resolveAvatarMedia(p.avatarUrl);
        const isFriend = acceptedFriendIds.has(p.userId);
        const base = {
          userId: p.userId,
          username: p.username,
          firstName: p.firstName,
          lastName: p.lastName,
          bio: canViewProfile(p, {
            isFriend,
            isFriendOfFriend: fofIds.has(p.userId),
          })
            ? p.bio
            : null,
          avatarUrl: url,
          avatarUrlExpiresIn: expiresIn,
          avatar,
          isOnline: visibleIsOnline(p, { isFriend }),
        };

        if (isFriend) {
          return {
            ...base,
            isFriend: true,
            relationshipStatus: "FRIEND" as RelationshipStatus,
            friendshipId: friendshipIdByPeer.get(p.userId) ?? null,
            requesterId: null,
          };
        }
        const pending = pendingRelMap.get(p.userId);
        return {
          ...base,
          isFriend: false,
          relationshipStatus: (pending
            ? "PENDING"
            : "NONE") as RelationshipStatus,
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
    limit: number
  ): Promise<{ users: UserDiscoveryResult[]; total: number }> {
    const friendships =
      await friendshipRepository.findAcceptedFriends(viewerId);
    if (friendships.length === 0) {
      return { users: [], total: 0 };
    }

    const friendIds = friendships.map((f) =>
      f.requesterId === viewerId ? f.addresseeId : f.requesterId
    );

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
        const { url, expiresIn } = await resolveAvatarUrl(p.avatarUrl);
        const avatar = await resolveAvatarMedia(p.avatarUrl);
        return {
          userId: p.userId,
          username: p.username,
          firstName: p.firstName,
          lastName: p.lastName,
          // Every row here is an accepted friend, but NO_ONE still applies.
          bio: canViewProfile(p, { isFriend: true }) ? p.bio : null,
          avatarUrl: url,
          avatarUrlExpiresIn: expiresIn,
          avatar,
          isOnline: visibleIsOnline(p, { isFriend: true }),
          relationshipStatus: "FRIEND" as RelationshipStatus,
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
    limit: number
  ): Promise<{ users: UserDiscoveryResult[]; total: number }> {
    const [allRelationships, allBlocks] = await Promise.all([
      friendshipRepository.findAllForUser(viewerId),
      friendshipRepository.findAllBlocks(viewerId),
    ]);

    const acceptedFriendIds = new Set<string>();
    const blockedUserIds = new Set<string>();
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

    for (const b of allBlocks) {
      const otherId = b.blockerId === viewerId ? b.blockedId : b.blockerId;
      blockedUserIds.add(otherId);
    }

    const viewerFriendIds = Array.from(acceptedFriendIds);
    const viewerGraph = await friendshipRepository.resolveViewerGraph(
      viewerId,
      viewerFriendIds
    );
    const fofIds = new Set(viewerGraph.friendOfFriendIds);
    const excludeIds = [
      viewerId,
      ...viewerFriendIds,
      ...Array.from(blockedUserIds),
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
        const { url, expiresIn } = await resolveAvatarUrl(p.avatarUrl);
        const avatar = await resolveAvatarMedia(p.avatarUrl);
        return {
          userId: p.userId,
          username: p.username,
          firstName: p.firstName,
          lastName: p.lastName,
          // Non-friends by construction (accepted friends are excluded above).
          bio: canViewProfile(p, {
            isFriend: false,
            isFriendOfFriend: fofIds.has(p.userId),
          })
            ? p.bio
            : null,
          avatarUrl: url,
          avatarUrlExpiresIn: expiresIn,
          avatar,
          isOnline: visibleIsOnline(p, { isFriend: false }),
          relationshipStatus,
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
    const blockedUserIds = new Set<string>();

    for (const b of allBlocks) {
      const otherId = b.blockerId === viewerId ? b.blockedId : b.blockerId;
      blockedUserIds.add(otherId);
    }

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
    const excludeIds = [viewerId, ...Array.from(blockedUserIds)];

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
        const { url, expiresIn } = await resolveAvatarUrl(p.avatarUrl);
        const avatar = await resolveAvatarMedia(p.avatarUrl);
        const isFriend = friendIdSet.has(p.userId);
        return {
          userId: p.userId,
          username: p.username,
          firstName: p.firstName,
          lastName: p.lastName,
          bio: canViewProfile(p, {
            isFriend,
            isFriendOfFriend: fofIds.has(p.userId),
          })
            ? p.bio
            : null,
          avatarUrl: url,
          avatarUrlExpiresIn: expiresIn,
          avatar,
          isOnline: visibleIsOnline(p, { isFriend }),
        };
      })
    );

    return { users, total };
  },
};
