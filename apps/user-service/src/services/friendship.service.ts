import { BadRequestError, ConflictError, NotFoundError } from "@aimess/errors";
import { MEDIA_PREFIXES, toMediaObject } from "@aimess/storage";

import {
  publishFriendAcceptedSafe,
  publishFriendRequestedSafe,
  publishFriendUnfriendedSafe,
  publishFriendshipCreatedSafe,
  publishFriendshipDeletedSafe,
} from "../messaging/publish-friendship.js";
import { friendshipRepository } from "../repositories/friendship.repository.js";
import { userProfileRepository } from "../repositories/user-profile.repository.js";
import { userCache } from "../lib/user-cache.js";
import { env } from "../config/env.js";
import { mediaUrlStrategy } from "../config/storage.js";
import { avatarService } from "./avatar.service.js";
import type { ListFriendRequestsQuery } from "../api/validators/friendship.validator.js";
import type {
  FriendRequestItem,
  FriendRequestsListResult,
} from "../types/friends.types.js";

type FriendshipRow = {
  id: string;
  requesterId: string;
  addresseeId: string;
  status: string;
  acceptedAt: Date | null;
  rejectedAt: Date | null;
  cancelledAt: Date | null;
  unfriendedAt: Date | null;
  unfriendedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type AutoConnectResult = {
  totalUsersScanned: number;
  eligibleUsers: number;
  friendsCreated: number;
  alreadyFriends: number;
  blockedUsers: number;
  pendingRequests: number;
  skippedUsers: number;
};

const BATCH_CHUNK_SIZE = 500;

export const friendshipService = {
  async listRequests(
    me: string,
    params: ListFriendRequestsQuery
  ): Promise<FriendRequestsListResult> {
    const { direction, page, limit } = params;
    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      friendshipRepository.findPendingRequests({
        userId: me,
        direction,
        skip,
        take: limit,
      }),
      friendshipRepository.countPendingRequests(me, direction),
    ]);

    if (rows.length === 0) {
      return { requests: [], total };
    }

    const peerIds = rows.map((r) =>
      r.requesterId === me ? r.addresseeId : r.requesterId
    );
    const profiles = await userProfileRepository.findManyByUserIds(peerIds);
    const profileById = new Map(profiles.map((p) => [p.userId, p]));

    const items = await Promise.all(
      rows.map(async (r): Promise<FriendRequestItem | null> => {
        const peerId = r.requesterId === me ? r.addresseeId : r.requesterId;
        const profile = profileById.get(peerId);
        // Peer profile soft-deleted/missing — drop from the list (rare).
        if (!profile) return null;

        const avatarView = await avatarService.resolveViewUrlForClient(
          profile.avatarUrl
        );
        const avatar = await toMediaObject({
          bucket: env.MINIO_BUCKET_AVATARS,
          stored: profile.avatarUrl,
          prefixes: MEDIA_PREFIXES.userAvatars,
          strategy: mediaUrlStrategy,
        });

        return {
          friendshipId: r.id,
          direction: r.requesterId === me ? "OUTGOING" : "INCOMING",
          user: {
            userId: profile.userId,
            username: profile.username,
            firstName: profile.firstName,
            lastName: profile.lastName,
            avatarUrl: avatarView?.url ?? null,
            avatar,
          },
          createdAt: r.createdAt.toISOString(),
        };
      })
    );

    return {
      requests: items.filter(
        (item): item is FriendRequestItem => item !== null
      ),
      total,
    };
  },

  async sendRequest(
    requesterId: string,
    addresseeId: string
  ): Promise<FriendshipRow> {
    if (requesterId === addresseeId) {
      throw new BadRequestError("FRIEND_CANNOT_ADD_SELF");
    }

    const [requesterProfile, addresseeProfile] = await Promise.all([
      userProfileRepository.findByUserId(requesterId),
      userProfileRepository.findByUserId(addresseeId),
    ]);

    if (!requesterProfile || requesterProfile.deletedAt) {
      throw new NotFoundError("USER_PROFILE_NOT_FOUND");
    }

    if (!addresseeProfile || addresseeProfile.deletedAt) {
      throw new NotFoundError("USER_PROFILE_NOT_FOUND");
    }

    const blocks = await friendshipRepository.findAllBlocks(requesterId);
    const isBlocked = blocks.some(
      (b) =>
        (b.blockerId === requesterId && b.blockedId === addresseeId) ||
        (b.blockerId === addresseeId && b.blockedId === requesterId)
    );
    if (isBlocked) {
      throw new BadRequestError("FRIEND_BLOCKED");
    }

    const existing = await friendshipRepository.findByPair(
      requesterId,
      addresseeId
    );

    if (existing) {
      if (existing.status === "ACCEPTED") {
        throw new ConflictError("FRIEND_ALREADY_FRIENDS");
      }

      if (existing.status === "PENDING") {
        if (existing.requesterId === requesterId) {
          throw new ConflictError("FRIEND_REQUEST_ALREADY_SENT");
        }
        // They already sent us a request — auto-accept the mutual request
        const [friendship] = await friendshipRepository.acceptWithCounters(
          existing.id,
          existing.requesterId,
          existing.addresseeId
        );
        await Promise.all([
          userCache.invalidateProfile(existing.requesterId),
          userCache.invalidateProfile(existing.addresseeId),
        ]);
        publishFriendAcceptedSafe({
          friendshipId: friendship.id,
          requesterId: friendship.requesterId,
          addresseeId: friendship.addresseeId,
          acceptedAt: friendship.acceptedAt!.toISOString(),
        });
        publishFriendshipCreatedSafe(
          friendship.requesterId,
          friendship.addresseeId
        );
        return friendship;
      }

      // REJECTED / CANCELLED / UNFRIENDED — recycle the row with the new direction
      const updated = await friendshipRepository.resetToPending(
        existing.id,
        requesterId,
        addresseeId
      );
      publishFriendRequestedSafe({
        friendshipId: updated.id,
        requesterId,
        addresseeId,
        createdAt: updated.createdAt.toISOString(),
      });
      return updated;
    }

    const friendship = await friendshipRepository.create(
      requesterId,
      addresseeId
    );
    publishFriendRequestedSafe({
      friendshipId: friendship.id,
      requesterId,
      addresseeId,
      createdAt: friendship.createdAt.toISOString(),
    });
    return friendship;
  },

  async acceptRequest(
    friendshipId: string,
    userId: string
  ): Promise<FriendshipRow> {
    const friendship = await friendshipRepository.findById(friendshipId);
    if (
      !friendship ||
      friendship.addresseeId !== userId ||
      friendship.status !== "PENDING"
    ) {
      throw new NotFoundError("FRIEND_REQUEST_NOT_FOUND");
    }

    const [updated] = await friendshipRepository.acceptWithCounters(
      friendshipId,
      friendship.requesterId,
      friendship.addresseeId
    );

    await Promise.all([
      userCache.invalidateProfile(friendship.requesterId),
      userCache.invalidateProfile(friendship.addresseeId),
    ]);

    publishFriendAcceptedSafe({
      friendshipId: updated.id,
      requesterId: friendship.requesterId,
      addresseeId: friendship.addresseeId,
      acceptedAt: updated.acceptedAt!.toISOString(),
    });
    publishFriendshipCreatedSafe(
      friendship.requesterId,
      friendship.addresseeId
    );

    return updated;
  },

  async rejectRequest(
    friendshipId: string,
    userId: string
  ): Promise<FriendshipRow> {
    const friendship = await friendshipRepository.findById(friendshipId);
    if (
      !friendship ||
      friendship.addresseeId !== userId ||
      friendship.status !== "PENDING"
    ) {
      throw new NotFoundError("FRIEND_REQUEST_NOT_FOUND");
    }

    return friendshipRepository.reject(friendshipId);
  },

  async cancelRequest(
    friendshipId: string,
    userId: string
  ): Promise<FriendshipRow> {
    const friendship = await friendshipRepository.findById(friendshipId);
    if (
      !friendship ||
      friendship.requesterId !== userId ||
      friendship.status !== "PENDING"
    ) {
      throw new NotFoundError("FRIEND_REQUEST_NOT_FOUND");
    }

    return friendshipRepository.cancel(friendshipId);
  },

  async autoConnectAll(callerId: string): Promise<AutoConnectResult> {
    const [allUsers, existingRows, blocks] = await Promise.all([
      userProfileRepository.findAllActiveExcept(callerId),
      friendshipRepository.findAllForUser(callerId),
      friendshipRepository.findAllBlocks(callerId),
    ]);

    // Build classification sets from caller's perspective
    const blockedUserIds = new Set<string>(
      blocks.map((b) => (b.blockerId === callerId ? b.blockedId : b.blockerId))
    );
    const friendedUserIds = new Set<string>();
    const pendingUserIds = new Set<string>();
    const existingPeerIds = new Set<string>();

    for (const row of existingRows) {
      const peer =
        row.requesterId === callerId ? row.addresseeId : row.requesterId;
      existingPeerIds.add(peer);
      if (row.status === "ACCEPTED") {
        friendedUserIds.add(peer);
      } else if (row.status === "PENDING") {
        pendingUserIds.add(peer);
      }
    }

    let alreadyFriends = 0;
    let pendingRequests = 0;
    let blockedUsers = 0;
    let skippedUsers = 0;
    const eligiblePairs: { requesterId: string; addresseeId: string }[] = [];

    for (const { userId } of allUsers) {
      if (blockedUserIds.has(userId)) {
        blockedUsers++;
      } else if (friendedUserIds.has(userId)) {
        alreadyFriends++;
      } else if (pendingUserIds.has(userId)) {
        pendingRequests++;
      } else if (existingPeerIds.has(userId)) {
        skippedUsers++;
      } else {
        eligiblePairs.push({ requesterId: callerId, addresseeId: userId });
      }
    }

    const created: FriendshipRow[] = [];
    for (let i = 0; i < eligiblePairs.length; i += BATCH_CHUNK_SIZE) {
      const chunk = eligiblePairs.slice(i, i + BATCH_CHUNK_SIZE);
      const chunkCreated = await friendshipRepository.autoAcceptBatch(chunk);
      created.push(...(chunkCreated as FriendshipRow[]));
    }

    if (eligiblePairs.length > 0) {
      const uniqueIds = new Set(
        eligiblePairs.flatMap((p) => [p.requesterId, p.addresseeId])
      );
      await Promise.all(
        [...uniqueIds].map((id) => userCache.invalidateProfile(id))
      );
    }

    for (const f of created) {
      publishFriendAcceptedSafe({
        friendshipId: f.id,
        requesterId: f.requesterId,
        addresseeId: f.addresseeId,
        acceptedAt: (f.acceptedAt ?? new Date()).toISOString(),
      });
      publishFriendshipCreatedSafe(f.requesterId, f.addresseeId);
    }

    return {
      totalUsersScanned: allUsers.length,
      eligibleUsers: eligiblePairs.length,
      friendsCreated: created.length,
      alreadyFriends,
      blockedUsers,
      pendingRequests,
      skippedUsers,
    };
  },

  async unfriend(viewerId: string, targetUserId: string): Promise<void> {
    if (viewerId === targetUserId) {
      throw new BadRequestError("FRIEND_CANNOT_ADD_SELF");
    }

    const friendship = await friendshipRepository.findActivePair(
      viewerId,
      targetUserId
    );
    if (!friendship) {
      throw new NotFoundError("FRIEND_REQUEST_NOT_FOUND");
    }

    await friendshipRepository.unfriendWithCounters(
      friendship.id,
      viewerId,
      friendship.requesterId,
      friendship.addresseeId
    );

    await Promise.all([
      userCache.invalidateProfile(friendship.requesterId),
      userCache.invalidateProfile(friendship.addresseeId),
    ]);

    const otherUserId =
      friendship.requesterId === viewerId
        ? friendship.addresseeId
        : friendship.requesterId;

    publishFriendUnfriendedSafe({
      friendshipId: friendship.id,
      unfriendedById: viewerId,
      otherUserId,
      unfriendedAt: new Date().toISOString(),
    });
    publishFriendshipDeletedSafe(
      friendship.requesterId,
      friendship.addresseeId
    );
  },
};
