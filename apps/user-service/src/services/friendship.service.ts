import { BadRequestError, ConflictError, NotFoundError } from "@aimess/errors";

import {
  publishFriendAcceptedSafe,
  publishFriendRequestedSafe,
  publishFriendUnfriendedSafe,
} from "../messaging/publish-friendship.js";
import { friendshipRepository } from "../repositories/friendship.repository.js";
import { userProfileRepository } from "../repositories/user-profile.repository.js";
import { userCache } from "../lib/user-cache.js";

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

export const friendshipService = {
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
  },
};
