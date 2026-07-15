import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../config/prisma.js";

/** WHERE clause for pending requests, filtered by direction relative to `userId`. */
function pendingRequestsWhere(
  userId: string,
  direction: "incoming" | "outgoing" | "all"
): Prisma.FriendshipWhereInput {
  if (direction === "incoming") {
    return { status: "PENDING", addresseeId: userId };
  }
  if (direction === "outgoing") {
    return { status: "PENDING", requesterId: userId };
  }
  return {
    status: "PENDING",
    OR: [{ requesterId: userId }, { addresseeId: userId }],
  };
}

const FRIENDSHIP_SELECT = {
  id: true,
  requesterId: true,
  addresseeId: true,
  status: true,
  acceptedAt: true,
  rejectedAt: true,
  cancelledAt: true,
  unfriendedAt: true,
  unfriendedBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

type FriendshipRow = Prisma.FriendshipGetPayload<{
  select: typeof FRIENDSHIP_SELECT;
}>;

export const friendshipRepository = {
  findById(id: string) {
    return prisma.friendship.findUnique({
      where: { id },
      select: FRIENDSHIP_SELECT,
    });
  },

  /** Find any friendship row for the pair, regardless of who sent it. */
  findByPair(userA: string, userB: string) {
    return prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId: userA, addresseeId: userB },
          { requesterId: userB, addresseeId: userA },
        ],
      },
      select: FRIENDSHIP_SELECT,
    });
  },

  /** Find an ACCEPTED friendship for a pair — used to validate unfriend. */
  findActivePair(userA: string, userB: string) {
    return prisma.friendship.findFirst({
      where: {
        status: "ACCEPTED",
        OR: [
          { requesterId: userA, addresseeId: userB },
          { requesterId: userB, addresseeId: userA },
        ],
      },
      select: FRIENDSHIP_SELECT,
    });
  },

  create(requesterId: string, addresseeId: string) {
    return prisma.friendship.create({
      data: { requesterId, addresseeId, status: "PENDING" },
      select: FRIENDSHIP_SELECT,
    });
  },

  /**
   * Reset an existing row to PENDING with a new requester/addressee.
   * Used when re-sending after REJECTED / CANCELLED / UNFRIENDED.
   */
  resetToPending(id: string, requesterId: string, addresseeId: string) {
    return prisma.friendship.update({
      where: { id },
      data: {
        requesterId,
        addresseeId,
        status: "PENDING",
        acceptedAt: null,
        rejectedAt: null,
        cancelledAt: null,
        unfriendedAt: null,
        unfriendedBy: null,
        createdAt: new Date(),
      },
      select: FRIENDSHIP_SELECT,
    });
  },

  /** Accept a pending request: PENDING → ACCEPTED + bump friendsCount on both sides. */
  acceptWithCounters(id: string, requesterId: string, addresseeId: string) {
    const now = new Date();
    return prisma.$transaction([
      prisma.friendship.update({
        where: { id },
        data: { status: "ACCEPTED", acceptedAt: now },
        select: FRIENDSHIP_SELECT,
      }),
      prisma.userProfile.update({
        where: { userId: requesterId },
        data: { friendsCount: { increment: 1 } },
        select: { userId: true, friendsCount: true },
      }),
      prisma.userProfile.update({
        where: { userId: addresseeId },
        data: { friendsCount: { increment: 1 } },
        select: { userId: true, friendsCount: true },
      }),
    ]);
  },

  reject(id: string) {
    return prisma.friendship.update({
      where: { id },
      data: { status: "REJECTED", rejectedAt: new Date() },
      select: FRIENDSHIP_SELECT,
    });
  },

  cancel(id: string) {
    return prisma.friendship.update({
      where: { id },
      data: { status: "CANCELLED", cancelledAt: new Date() },
      select: FRIENDSHIP_SELECT,
    });
  },

  /** Unfriend: ACCEPTED → UNFRIENDED + decrement friendsCount on both sides. */
  unfriendWithCounters(
    id: string,
    unfriendedById: string,
    requesterId: string,
    addresseeId: string
  ) {
    const now = new Date();
    return prisma.$transaction([
      prisma.friendship.update({
        where: { id },
        data: {
          status: "UNFRIENDED",
          unfriendedAt: now,
          unfriendedBy: unfriendedById,
        },
        select: FRIENDSHIP_SELECT,
      }),
      prisma.userProfile.update({
        where: { userId: requesterId },
        data: { friendsCount: { decrement: 1 } },
        select: { userId: true, friendsCount: true },
      }),
      prisma.userProfile.update({
        where: { userId: addresseeId },
        data: { friendsCount: { decrement: 1 } },
        select: { userId: true, friendsCount: true },
      }),
    ]);
  },

  /**
   * Creates N ACCEPTED friendship rows in a single atomic transaction. All pairs
   * must share the same requesterId (the calling user). Uses createMany + bulk
   * counter updates so the total DB round-trips are O(1) regardless of batch size.
   *
   * skipDuplicates: true makes the batch idempotent against concurrent inserts for
   * the same (requesterId, addresseeId) pair.
   */
  async autoAcceptBatch(
    pairs: { requesterId: string; addresseeId: string }[]
  ): Promise<FriendshipRow[]> {
    if (pairs.length === 0) return [];
    return prisma.$transaction(async (tx) => {
      const now = new Date();
      const requesterId = pairs[0].requesterId;
      const addresseeIds = pairs.map((p) => p.addresseeId);

      // 1. Batch-insert all friendship rows (skip any duplicate from a concurrent request).
      await tx.friendship.createMany({
        data: pairs.map(({ addresseeId }) => ({
          requesterId,
          addresseeId,
          status: "ACCEPTED",
          acceptedAt: now,
        })),
        skipDuplicates: true,
      });

      // 2. Increment counters in bulk: requester once by N, each addressee once by 1.
      await Promise.all([
        tx.userProfile.update({
          where: { userId: requesterId },
          data: { friendsCount: { increment: pairs.length } },
          select: { userId: true },
        }),
        tx.userProfile.updateMany({
          where: { userId: { in: addresseeIds } },
          data: { friendsCount: { increment: 1 } },
        }),
      ]);

      // 3. Return the inserted rows so callers can read IDs for event publishing.
      return tx.friendship.findMany({
        where: {
          requesterId,
          addresseeId: { in: addresseeIds },
          status: "ACCEPTED",
        },
        select: FRIENDSHIP_SELECT,
      });
    });
  },

  /**
   * Bulk-unfriends N ACCEPTED friendship rows belonging to `userId` in one
   * atomic transaction — the disconnect-side mirror of {@link autoAcceptBatch}
   * (updateMany + counter decrement instead of createMany + counter increment).
   * `peerIds` is the parallel other-side-userId array for `friendshipIds`
   * (index-for-index), used only for the bulk per-peer counter decrement.
   * Returns the number of rows actually flipped to UNFRIENDED (may be less
   * than `friendshipIds.length` if a row was concurrently unfriended first).
   */
  async autoDisconnectBatch(
    userId: string,
    friendshipIds: string[],
    peerIds: string[]
  ): Promise<number> {
    if (friendshipIds.length === 0) return 0;
    return prisma.$transaction(async (tx) => {
      const now = new Date();

      const { count } = await tx.friendship.updateMany({
        where: { id: { in: friendshipIds }, status: "ACCEPTED" },
        data: { status: "UNFRIENDED", unfriendedAt: now, unfriendedBy: userId },
      });

      await Promise.all([
        tx.userProfile.update({
          where: { userId },
          data: { friendsCount: { decrement: count } },
          select: { userId: true },
        }),
        tx.userProfile.updateMany({
          where: { userId: { in: peerIds } },
          data: { friendsCount: { decrement: 1 } },
        }),
      ]);

      return count;
    });
  },

  /** All ACCEPTED friendships for a user — returns peer userId + friendship id. */
  findAcceptedFriends(userId: string) {
    return prisma.friendship.findMany({
      where: {
        status: "ACCEPTED",
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
      select: {
        id: true,
        requesterId: true,
        addresseeId: true,
        acceptedAt: true,
      },
    });
  },

  /** All friendship rows for a user (any status) — used for relationship labelling in discovery. */
  findAllForUser(userId: string) {
    return prisma.friendship.findMany({
      where: {
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
      select: { id: true, requesterId: true, addresseeId: true, status: true },
    });
  },

  /**
   * Returns the subset of `candidateIds` that are ACCEPTED friends with `callerId`,
   * regardless of who sent the original request. Bounded by caller (≤500 ids).
   * Used by community-service for server-side friend validation on add-members.
   */
  async findAcceptedFriendIdsForUser(
    callerId: string,
    candidateIds: string[]
  ): Promise<string[]> {
    if (candidateIds.length === 0) return [];
    const rows = await prisma.friendship.findMany({
      where: {
        status: "ACCEPTED",
        OR: [
          { requesterId: callerId, addresseeId: { in: candidateIds } },
          { addresseeId: callerId, requesterId: { in: candidateIds } },
        ],
      },
      select: { requesterId: true, addresseeId: true },
    });
    const friends = new Set<string>();
    for (const r of rows) {
      friends.add(r.requesterId === callerId ? r.addresseeId : r.requesterId);
    }
    return [...friends];
  },

  /** Pending requests for a user, paginated, newest first. */
  findPendingRequests(params: {
    userId: string;
    direction: "incoming" | "outgoing" | "all";
    skip: number;
    take: number;
  }) {
    return prisma.friendship.findMany({
      where: pendingRequestsWhere(params.userId, params.direction),
      orderBy: { createdAt: "desc" },
      skip: params.skip,
      take: params.take,
      select: {
        id: true,
        requesterId: true,
        addresseeId: true,
        createdAt: true,
      },
    });
  },

  /** Count of pending requests for a user in the given direction. */
  countPendingRequests(
    userId: string,
    direction: "incoming" | "outgoing" | "all"
  ) {
    return prisma.friendship.count({
      where: pendingRequestsWhere(userId, direction),
    });
  },

  /** All block rows where the user is either blocker or blocked. */
  findAllBlocks(userId: string) {
    return prisma.block.findMany({
      where: {
        OR: [{ blockerId: userId }, { blockedId: userId }],
      },
      select: { blockerId: true, blockedId: true },
    });
  },
};
