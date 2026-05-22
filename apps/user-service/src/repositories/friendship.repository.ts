import { prisma } from "../config/prisma.js";

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
