import { BadRequestError, ConflictError, NotFoundError } from "@aimess/errors";
import { MEDIA_PREFIXES, toMediaObject } from "@aimess/storage";
import {
  FriendSocketEvents,
  ConversationSocketEvents,
  type PendingFriendRequestConversation,
} from "@aimess/shared-types";

import {
  publishFriendAcceptedSafe,
  publishFriendCancelledSafe,
  publishFriendRejectedSafe,
  publishFriendRequestedSafe,
  publishFriendUnfriendedSafe,
  publishFriendshipBlockedSafe,
  publishFriendshipCreatedSafe,
  publishFriendshipDeletedSafe,
} from "../messaging/publish-friendship.js";
import {
  emitFriendEventSafe,
  emitFriendSelfEventSafe,
  emitFriendEventToPairSafe,
} from "../lib/friend-socket.js";
import {
  buildFriendshipView,
  toSearchRelationship,
} from "../lib/friendship-view.js";
import { friendshipRepository } from "../repositories/friendship.repository.js";
import { userProfileRepository } from "../repositories/user-profile.repository.js";
import { userCache } from "../lib/user-cache.js";
import { messagingGrpcClient } from "../grpc/messaging.client.js";
import { env } from "../config/env.js";
import { mediaUrlStrategy } from "../config/storage.js";
import { avatarService } from "./avatar.service.js";
import type { ListFriendRequestsQuery } from "../api/validators/friendship.validator.js";
import type {
  FriendRequestDirection,
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

type FriendWithRoom = {
  userId: string;
  roomId: string;
};

type AutoConnectResult = {
  totalUsersScanned: number;
  eligibleUsers: number;
  friendsCreated: number;
  alreadyFriends: number;
  blockedUsers: number;
  pendingRequests: number;
  skippedUsers: number;
  /** Friends (created + already existing) with their private room IDs. */
  friends: FriendWithRoom[];
};

type AutoDisconnectResult = {
  totalFriends: number;
  friendsDisconnected: number;
  /** userIds of every friend removed by this call. */
  friends: string[];
};

/** Result of a platform-wide {@link friendshipService.disconnectAllPlatform} sweep. */
export type PlatformDisconnectResult = {
  friendshipsDisconnected: number;
  usersAffected: number;
};

const BATCH_CHUNK_SIZE = 500;

type PeerBrief = {
  userId: string;
  username: string;
  firstName: string;
  lastName: string;
};

function toPeerBrief(p: PeerBrief): PeerBrief {
  return {
    userId: p.userId,
    username: p.username,
    firstName: p.firstName,
    lastName: p.lastName,
  };
}

/** "First Last" (trimmed), falling back to username — used in push/notification copy. */
function displayName(p: PeerBrief): string {
  return `${p.firstName} ${p.lastName}`.trim() || p.username;
}

/**
 * Loads both parties' display names for a friendship notification payload.
 * `acceptRequest`/`rejectRequest`/`cancelRequest` don't otherwise touch
 * profiles, so this is the one extra query those paths pay — `sendRequest`
 * already has both profiles loaded and computes names inline instead.
 */
async function loadFriendshipNames(
  requesterId: string,
  addresseeId: string
): Promise<{ requesterName: string; addresseeName: string }> {
  const profiles = await userProfileRepository.findManyByUserIds([
    requesterId,
    addresseeId,
  ]);
  const byId = new Map(profiles.map((p) => [p.userId, p]));
  const nameFor = (userId: string): string => {
    const p = byId.get(userId);
    return p ? displayName(toPeerBrief(p)) : "Someone";
  };
  return {
    requesterName: nameFor(requesterId),
    addresseeName: nameFor(addresseeId),
  };
}

/**
 * Shared realtime payload shape for every `friend:*` socket event: the
 * friendship id, the *viewer's* derived {@link buildFriendshipView} (status/
 * direction/canAccept/canReject/canCancel — never re-derived ad hoc per
 * event), and the other party's id. `peer` (full brief) is only attached
 * where the caller already has the profile loaded (new-request events) —
 * elsewhere just `peerId`, since the FE already holds that peer's profile
 * from the list the event is updating.
 */
function friendshipEventData(
  row: FriendshipRow,
  viewerId: string,
  peerId: string,
  peer?: PeerBrief
) {
  const view = buildFriendshipView(viewerId, row);
  return {
    friendshipId: row.id,
    peerId,
    // Alias for the User Search screen's merge-by-id contract (same value
    // as `peerId` — the affected user id from this recipient's viewpoint).
    targetUserId: peerId,
    ...(peer ? { peer: toPeerBrief(peer) } : {}),
    ...view,
    // Normalized FRIEND/PENDING/NONE shape the search screen merges by
    // `targetUserId` — see `toSearchRelationship` for why this differs from
    // the ACCEPTED/BLOCKED vocabulary above (kept for the request screens).
    relationship: toSearchRelationship(view),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Emit the new-request pair: distinct event name per side, same friendship row. */
function emitRequestCreated(
  row: FriendshipRow,
  requesterProfile: PeerBrief,
  addresseeProfile: PeerBrief
): void {
  emitFriendEventSafe(
    row.requesterId,
    FriendSocketEvents.REQUEST_SENT,
    friendshipEventData(row, row.requesterId, row.addresseeId, addresseeProfile)
  );
  emitFriendEventSafe(
    row.addresseeId,
    FriendSocketEvents.REQUEST_RECEIVED,
    friendshipEventData(row, row.addresseeId, row.requesterId, requesterProfile)
  );
}

/**
 * Emit `conversation:pending-friend-request` to the addressee ONLY — powers
 * the Telegram-style pending row in their private-chat conversation list,
 * live, before any room/message exists. Additive alongside the existing
 * `friend:request:received` event above (same trigger point, same transport);
 * this one carries the FULL synthetic conversation-list-row shape the
 * frontend can render without a follow-up fetch.
 */
async function emitConversationPendingFriendRequest(
  row: FriendshipRow,
  requesterProfile: PeerBrief & { avatarUrl?: string | null }
): Promise<void> {
  const avatarView = await avatarService
    .resolveViewUrlForClient(requesterProfile.avatarUrl ?? null)
    .catch(() => null);

  const conversation: PendingFriendRequestConversation = {
    id: `pending:${row.id}`,
    type: "PRIVATE_PENDING",
    pendingRequest: true,
    friendRequestId: row.id,
    requester: {
      id: requesterProfile.userId,
      displayName: displayName(toPeerBrief(requesterProfile)),
      username: requesterProfile.username,
      avatarUrl: avatarView?.url ?? null,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastActivity: { type: "FRIEND_REQUEST", text: "Friend Request" },
  };

  emitFriendEventSafe(
    row.addresseeId,
    ConversationSocketEvents.PENDING_FRIEND_REQUEST,
    {
      conversation,
      friendRequest: {
        id: row.id,
        requesterId: row.requesterId,
        addresseeId: row.addresseeId,
        status: "PENDING" as const,
        createdAt: row.createdAt.toISOString(),
      },
    }
  );
}

/**
 * Eagerly create the pair's private room (reusing the same `getOrCreatePrivateRooms`
 * gRPC path `autoConnectAll` already uses) and emit `conversation:friend-request-accepted`
 * to both parties, so the pending row on every device swaps for a real, composable
 * conversation the instant Accept succeeds — no waiting on the lazy first-open room
 * creation. Best-effort: a room-creation failure still lets the friendship accept
 * succeed (the room falls back to lazy creation on first open, same as today).
 */
async function emitConversationFriendRequestAccepted(
  row: FriendshipRow
): Promise<void> {
  const roomMatches = await messagingGrpcClient.getOrCreatePrivateRooms(
    row.requesterId,
    [row.addresseeId]
  );
  const roomId = roomMatches[0]?.roomId ?? null;

  const friendRequest = {
    id: row.id,
    requesterId: row.requesterId,
    addresseeId: row.addresseeId,
    status: "ACCEPTED" as const,
    acceptedAt: (row.acceptedAt ?? new Date()).toISOString(),
  };

  emitFriendEventSafe(
    row.requesterId,
    ConversationSocketEvents.FRIEND_REQUEST_ACCEPTED,
    { friendRequest, roomId, peerId: row.addresseeId }
  );
  emitFriendEventSafe(
    row.addresseeId,
    ConversationSocketEvents.FRIEND_REQUEST_ACCEPTED,
    { friendRequest, roomId, peerId: row.requesterId }
  );
}

/**
 * Emit `conversation:friend-request-rejected` to both parties so every open
 * device drops the pending row — used for both an explicit reject (by the
 * addressee) and a cancel (by the requester, before the addressee responds);
 * either way the pending row must disappear on both sides.
 */
function emitConversationFriendRequestRejected(
  row: FriendshipRow,
  status: "REJECTED" | "CANCELLED" = "REJECTED"
): void {
  const friendRequest = {
    id: row.id,
    requesterId: row.requesterId,
    addresseeId: row.addresseeId,
    status,
    rejectedAt: (row.rejectedAt ?? row.cancelledAt ?? new Date()).toISOString(),
  };

  emitFriendEventSafe(
    row.requesterId,
    ConversationSocketEvents.FRIEND_REQUEST_REJECTED,
    { friendRequest, peerId: row.addresseeId }
  );
  emitFriendEventSafe(
    row.addresseeId,
    ConversationSocketEvents.FRIEND_REQUEST_REJECTED,
    { friendRequest, peerId: row.requesterId }
  );
}

/** Emit the same event name to both sides of a friendship row. */
function emitToPair(
  row: FriendshipRow,
  event: (typeof FriendSocketEvents)[keyof typeof FriendSocketEvents]
): void {
  emitFriendEventToPairSafe(
    row.requesterId,
    row.addresseeId,
    event,
    (targetUserId) =>
      friendshipEventData(
        row,
        targetUserId,
        targetUserId === row.requesterId ? row.addresseeId : row.requesterId
      )
  );
}

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

        // findPendingRequests only ever returns PENDING rows — safe to
        // hardcode the status when deriving the view.
        const view = buildFriendshipView(me, { ...r, status: "PENDING" });

        return {
          friendshipId: r.id,
          direction: view.direction as FriendRequestDirection,
          canAccept: view.canAccept,
          canReject: view.canReject,
          canCancel: view.canCancel,
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
          requesterName: displayName(toPeerBrief(requesterProfile)),
          addresseeName: displayName(toPeerBrief(addresseeProfile)),
          acceptedAt: friendship.acceptedAt!.toISOString(),
        });
        publishFriendshipCreatedSafe(
          friendship.requesterId,
          friendship.addresseeId
        );
        emitToPair(friendship, FriendSocketEvents.ACCEPTED);
        void emitConversationFriendRequestAccepted(friendship);
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
        requesterName: displayName(toPeerBrief(requesterProfile)),
        createdAt: updated.createdAt.toISOString(),
      });
      emitRequestCreated(updated, requesterProfile, addresseeProfile);
      void emitConversationPendingFriendRequest(updated, requesterProfile);
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
      requesterName: displayName(toPeerBrief(requesterProfile)),
      createdAt: friendship.createdAt.toISOString(),
    });
    emitRequestCreated(friendship, requesterProfile, addresseeProfile);
    void emitConversationPendingFriendRequest(friendship, requesterProfile);
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

    const { requesterName, addresseeName } = await loadFriendshipNames(
      friendship.requesterId,
      friendship.addresseeId
    );
    publishFriendAcceptedSafe({
      friendshipId: updated.id,
      requesterId: friendship.requesterId,
      addresseeId: friendship.addresseeId,
      requesterName,
      addresseeName,
      acceptedAt: updated.acceptedAt!.toISOString(),
    });
    publishFriendshipCreatedSafe(
      friendship.requesterId,
      friendship.addresseeId
    );
    emitToPair(updated, FriendSocketEvents.ACCEPTED);
    void emitConversationFriendRequestAccepted(updated);

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

    const updated = await friendshipRepository.reject(friendshipId);
    const { addresseeName } = await loadFriendshipNames(
      friendship.requesterId,
      friendship.addresseeId
    );
    publishFriendRejectedSafe({
      friendshipId: updated.id,
      requesterId: friendship.requesterId,
      addresseeId: friendship.addresseeId,
      addresseeName,
      rejectedAt: updated.rejectedAt!.toISOString(),
    });
    emitToPair(updated, FriendSocketEvents.REJECTED);
    emitConversationFriendRequestRejected(updated);
    return updated;
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

    const updated = await friendshipRepository.cancel(friendshipId);
    const { requesterName } = await loadFriendshipNames(
      friendship.requesterId,
      friendship.addresseeId
    );
    publishFriendCancelledSafe({
      friendshipId: updated.id,
      requesterId: friendship.requesterId,
      addresseeId: friendship.addresseeId,
      requesterName,
      cancelledAt: updated.cancelledAt!.toISOString(),
    });
    emitToPair(updated, FriendSocketEvents.REQUEST_CANCELLED);
    emitConversationFriendRequestRejected(updated, "CANCELLED");
    return updated;
  },

  async autoConnectAll(callerId: string): Promise<AutoConnectResult> {
    const [callerProfile, allUsers, existingRows, blocks] = await Promise.all([
      userProfileRepository.findByUserId(callerId),
      userProfileRepository.findAllActiveExcept(callerId),
      friendshipRepository.findAllForUser(callerId),
      friendshipRepository.findAllBlocks(callerId),
    ]);

    // The caller's UserProfile is provisioned ASYNCHRONOUSLY by the user-created
    // consumer (off the auth `user.created` event). During onboarding the client
    // can POST /auto-connect from the "Complete profile" step before that row has
    // committed — and since every pair below uses `requesterId: callerId`, the
    // batch insert would die on the `friendships_requesterId_fkey` foreign key and
    // surface as an opaque 500. Fail fast with a clear, retryable domain error so
    // the precondition violation never reaches the DB layer.
    if (!callerProfile) {
      throw new NotFoundError("USER_PROFILE_NOT_FOUND");
    }

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
      emitToPair(f, FriendSocketEvents.ACCEPTED);
    }

    // Collect all friend peer IDs (created + already existing ACCEPTED friends)
    const allFriendIds = new Set<string>();
    for (const peer of friendedUserIds) {
      allFriendIds.add(peer);
    }
    for (const f of created) {
      allFriendIds.add(f.addresseeId);
    }

    // Ensure all friends have private rooms (get-or-create batch).
    const roomMatches =
      allFriendIds.size > 0
        ? await messagingGrpcClient.getOrCreatePrivateRooms(callerId, [
            ...allFriendIds,
          ])
        : [];

    const roomByPeer = new Map(
      roomMatches.map((m) => [m.peerUserId, m.roomId])
    );

    const friends: FriendWithRoom[] = [];
    for (const peerId of allFriendIds) {
      const roomId = roomByPeer.get(peerId);
      if (roomId) {
        friends.push({ userId: peerId, roomId });
      }
    }

    return {
      totalUsersScanned: allUsers.length,
      eligibleUsers: eligiblePairs.length,
      friendsCreated: created.length,
      alreadyFriends,
      blockedUsers,
      pendingRequests,
      skippedUsers,
      friends,
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

    const [updated] = await friendshipRepository.unfriendWithCounters(
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
    emitToPair(updated as FriendshipRow, FriendSocketEvents.REMOVED);
  },

  /**
   * Bulk-unfriends every ACCEPTED friend of `callerId` — the disconnect-side
   * mirror of {@link autoConnectAll}. Reuses the same precondition guard
   * (unprovisioned caller → 404 before touching the DB), the same
   * `findAcceptedFriends` read used by discovery, the same
   * `BATCH_CHUNK_SIZE` chunking, and publishes the identical event pair
   * (`publishFriendUnfriendedSafe` + `publishFriendshipDeletedSafe`) that a
   * manual {@link unfriend} call fires — one per removed friendship, so every
   * downstream consumer (notifications no-op, chat-service read-model) sees
   * auto-disconnect exactly like N manual unfriends.
   *
   * Does NOT touch private rooms/messages/community membership/blocks —
   * those are untouched by manual unfriend too, so this stays consistent.
   */
  async autoDisconnectAll(callerId: string): Promise<AutoDisconnectResult> {
    const callerProfile = await userProfileRepository.findByUserId(callerId);
    // Same onboarding-race guard as autoConnectAll: fail fast with a clear,
    // retryable 404 instead of letting a missing profile surface as a
    // confusing downstream error.
    if (!callerProfile) {
      throw new NotFoundError("USER_PROFILE_NOT_FOUND");
    }

    const friendships =
      await friendshipRepository.findAcceptedFriends(callerId);

    if (friendships.length === 0) {
      return { totalFriends: 0, friendsDisconnected: 0, friends: [] };
    }

    const pairs = friendships.map((f) => ({
      friendshipId: f.id,
      peerId: f.requesterId === callerId ? f.addresseeId : f.requesterId,
    }));

    let friendsDisconnected = 0;
    for (let i = 0; i < pairs.length; i += BATCH_CHUNK_SIZE) {
      const chunk = pairs.slice(i, i + BATCH_CHUNK_SIZE);
      friendsDisconnected += await friendshipRepository.autoDisconnectBatch(
        callerId,
        chunk.map((p) => p.friendshipId),
        chunk.map((p) => p.peerId)
      );
    }

    const uniqueIds = new Set<string>([
      callerId,
      ...pairs.map((p) => p.peerId),
    ]);
    await Promise.all(
      [...uniqueIds].map((id) => userCache.invalidateProfile(id))
    );

    const unfriendedAt = new Date().toISOString();
    const unfriendedAtDate = new Date(unfriendedAt);
    for (const { friendshipId, peerId } of pairs) {
      publishFriendUnfriendedSafe({
        friendshipId,
        unfriendedById: callerId,
        otherUserId: peerId,
        unfriendedAt,
      });
      publishFriendshipDeletedSafe(callerId, peerId);
      emitToPair(
        {
          id: friendshipId,
          requesterId: callerId,
          addresseeId: peerId,
          status: "UNFRIENDED",
          acceptedAt: null,
          rejectedAt: null,
          cancelledAt: null,
          unfriendedAt: unfriendedAtDate,
          unfriendedBy: callerId,
          createdAt: unfriendedAtDate,
          updatedAt: unfriendedAtDate,
        },
        FriendSocketEvents.REMOVED
      );
    }

    return {
      totalFriends: friendships.length,
      friendsDisconnected,
      friends: pairs.map((p) => p.peerId),
    };
  },

  /**
   * PLATFORM-WIDE maintenance sweep: force-unfriends EVERY ACCEPTED
   * friendship on the platform, not just one caller's. Gated on `confirm:
   * true` so it can never fire by accident — this is only ever reached via
   * `UserService.AdminDisconnectAllFriendships` gRPC, itself only callable
   * from backoffice-service's SUPER_ADMIN-only `settings.manage` admin
   * action, which is what supplies real accountability (actor + audit log),
   * not this flag — the flag is just a blast-radius trip-wire.
   *
   * Drains {@link friendshipRepository.disconnectAllAcceptedBatch} in
   * `BATCH_CHUNK_SIZE` batches until none remain, publishing the identical
   * per-friendship event pair as {@link autoDisconnectAll} (so every
   * downstream consumer sees this exactly like N manual unfriends) and
   * invalidating the profile cache for every affected user exactly once.
   */
  async disconnectAllPlatform(params: {
    confirm: boolean;
  }): Promise<PlatformDisconnectResult> {
    if (!params.confirm) {
      throw new BadRequestError("FRIEND_DISCONNECT_ALL_CONFIRMATION_REQUIRED");
    }

    let friendshipsDisconnected = 0;
    const affectedUserIds = new Set<string>();

    for (;;) {
      const batch =
        await friendshipRepository.disconnectAllAcceptedBatch(BATCH_CHUNK_SIZE);
      if (batch.length === 0) break;

      friendshipsDisconnected += batch.length;
      const unfriendedAt = new Date().toISOString();
      const unfriendedAtDate = new Date(unfriendedAt);
      for (const { id, requesterId, addresseeId } of batch) {
        affectedUserIds.add(requesterId);
        affectedUserIds.add(addresseeId);
        // No single initiating user for a system sweep — requesterId is a
        // defensible placeholder for the event payload's required actor id;
        // no consumer branches on it (notifications is a silent no-op on
        // unfriend per product policy, chat-service reads the symmetric
        // publishFriendshipDeletedSafe pair below instead).
        publishFriendUnfriendedSafe({
          friendshipId: id,
          unfriendedById: requesterId,
          otherUserId: addresseeId,
          unfriendedAt,
        });
        publishFriendshipDeletedSafe(requesterId, addresseeId);
        emitToPair(
          {
            id,
            requesterId,
            addresseeId,
            status: "UNFRIENDED",
            acceptedAt: null,
            rejectedAt: null,
            cancelledAt: null,
            unfriendedAt: unfriendedAtDate,
            unfriendedBy: null,
            createdAt: unfriendedAtDate,
            updatedAt: unfriendedAtDate,
          },
          FriendSocketEvents.REMOVED
        );
      }
    }

    await Promise.all(
      [...affectedUserIds].map((id) => userCache.invalidateProfile(id))
    );

    return {
      friendshipsDisconnected,
      usersAffected: affectedUserIds.size,
    };
  },

  /**
   * Blocking always wins over any existing relationship: an ACCEPTED
   * friendship is unfriended and a PENDING request is terminated (reused via
   * the exact same repo calls + publishers as {@link unfriend}/
   * {@link rejectRequest}/{@link cancelRequest} — no duplicated transition
   * logic), before the `Block` row is created.
   */
  async blockUser(blockerId: string, blockedId: string): Promise<void> {
    if (blockerId === blockedId) {
      throw new BadRequestError("FRIEND_CANNOT_ADD_SELF");
    }

    const blockedProfile = await userProfileRepository.findByUserId(blockedId);
    if (!blockedProfile || blockedProfile.deletedAt) {
      throw new NotFoundError("USER_PROFILE_NOT_FOUND");
    }

    const existingBlock = await friendshipRepository.findBlock(
      blockerId,
      blockedId
    );
    if (existingBlock) {
      throw new ConflictError("FRIEND_ALREADY_BLOCKED");
    }

    const friendship = await friendshipRepository.findByPair(
      blockerId,
      blockedId
    );

    if (friendship?.status === "ACCEPTED") {
      const [updated] = await friendshipRepository.unfriendWithCounters(
        friendship.id,
        blockerId,
        friendship.requesterId,
        friendship.addresseeId
      );
      publishFriendUnfriendedSafe({
        friendshipId: friendship.id,
        unfriendedById: blockerId,
        otherUserId: blockedId,
        unfriendedAt: new Date().toISOString(),
      });
      publishFriendshipDeletedSafe(
        friendship.requesterId,
        friendship.addresseeId
      );
      emitToPair(updated as FriendshipRow, FriendSocketEvents.REMOVED);
      await Promise.all([
        userCache.invalidateProfile(blockerId),
        userCache.invalidateProfile(blockedId),
      ]);
    } else if (friendship?.status === "PENDING") {
      const isRequester = friendship.requesterId === blockerId;
      const updated = isRequester
        ? await friendshipRepository.cancel(friendship.id)
        : await friendshipRepository.reject(friendship.id);
      emitToPair(
        updated,
        isRequester
          ? FriendSocketEvents.REQUEST_CANCELLED
          : FriendSocketEvents.REJECTED
      );
    }

    await friendshipRepository.createBlock(blockerId, blockedId);

    // Symmetric — activates chat-service's `friendship.blocked` consumer
    // branch for both directions so neither side can message the other.
    publishFriendshipBlockedSafe(blockerId, blockedId);
    publishFriendshipBlockedSafe(blockedId, blockerId);

    // Blocking is silent to the blocked party — same product policy this
    // codebase already applies to FRIEND_UNFRIENDED (notifications-service
    // no-ops it). Only the blocker's own other devices need to sync.
    const blockedView = buildFriendshipView(blockerId, null, true);
    emitFriendEventSafe(blockerId, FriendSocketEvents.BLOCKED, {
      peerId: blockedId,
      targetUserId: blockedId,
      ...blockedView,
      relationship: toSearchRelationship(blockedView),
    });

    // …but the blocked party's screens still have to stop offering "Send Friend
    // Request" to someone who blocked them. This says only "re-read your
    // relationship with this peer" — no verb, no status — so they refetch and
    // discover exactly what the REST layer already lets them discover (a 404 on
    // the profile), and nothing more. Self-room only: `user:<id>` is joinable by
    // presence watchers.
    emitFriendSelfEventSafe(blockedId, FriendSocketEvents.RELATIONSHIP_SYNC, {
      peerId: blockerId,
    });
  },

  async unblockUser(blockerId: string, blockedId: string): Promise<void> {
    const existingBlock = await friendshipRepository.findBlock(
      blockerId,
      blockedId
    );
    if (!existingBlock) {
      throw new NotFoundError("FRIEND_NOT_BLOCKED");
    }

    await friendshipRepository.deleteBlock(blockerId, blockedId);

    // Restore chat-service's read-model to match the real relationship —
    // usually cleared (block already unfriended on the way in); ACTIVE only
    // covers the rare case where they re-friended while still blocked.
    const friendship = await friendshipRepository.findByPair(
      blockerId,
      blockedId
    );
    if (friendship?.status === "ACCEPTED") {
      publishFriendshipCreatedSafe(
        friendship.requesterId,
        friendship.addresseeId
      );
    } else {
      publishFriendshipDeletedSafe(blockerId, blockedId);
    }

    const unblockedView = buildFriendshipView(blockerId, friendship ?? null);
    emitFriendEventSafe(blockerId, FriendSocketEvents.UNBLOCKED, {
      peerId: blockedId,
      targetUserId: blockedId,
      ...unblockedView,
      relationship: toSearchRelationship(unblockedView),
    });

    // Same neutral signal as the block path — without it the other side stays
    // stuck on "profile unavailable" until they restart the app.
    emitFriendSelfEventSafe(blockedId, FriendSocketEvents.RELATIONSHIP_SYNC, {
      peerId: blockerId,
    });
  },
};
