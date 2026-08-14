import { prisma } from "../config/prisma.js";

export class FriendshipRepository {
  async areFriends(userA: string, userB: string): Promise<boolean> {
    const friendship = await prisma.friendship.findUnique({
      where: {
        userId_friendId: { userId: userA, friendId: userB },
      },
    });
    return friendship?.status === "ACTIVE";
  }

  async isFriendshipBlocked(userA: string, userB: string): Promise<boolean> {
    const friendship = await prisma.friendship.findUnique({
      where: {
        userId_friendId: { userId: userA, friendId: userB },
      },
    });
    return friendship?.status === "BLOCKED";
  }

  /**
   * Is EITHER party blocking the other? A block is stored one-way
   * (blocker -> blocked), but its effect is mutual: neither side may call the
   * other afterwards. Read here rather than from `PrivateRoom.blockedBy` so the
   * answer also holds for a pair with no DM room yet.
   */
  async isBlockedEitherWay(userA: string, userB: string): Promise<boolean> {
    const blocked = await prisma.friendship.findFirst({
      where: {
        status: "BLOCKED",
        OR: [
          { userId: userA, friendId: userB },
          { userId: userB, friendId: userA },
        ],
      },
      select: { id: true },
    });
    return blocked !== null;
  }

  async getFriendshipStatus(
    userA: string,
    userB: string
  ): Promise<string | null> {
    const friendship = await prisma.friendship.findUnique({
      where: {
        userId_friendId: { userId: userA, friendId: userB },
      },
    });
    return friendship?.status ?? null;
  }

  async createFriendship(
    userId: string,
    friendId: string,
    status: string = "ACTIVE"
  ): Promise<void> {
    await prisma.friendship.upsert({
      where: {
        userId_friendId: { userId, friendId },
      },
      update: { status },
      create: { userId, friendId, status },
    });
  }

  async deleteFriendship(userId: string, friendId: string): Promise<void> {
    // deleteMany, not delete: the pair's row may already be gone (e.g. a
    // block's "friendship.deleted" publish firing after an unfriend already
    // removed it) — a bare delete() throws P2025 on a missing unique key,
    // which the queue consumer then nacks-without-requeue and drops.
    await prisma.friendship.deleteMany({
      where: { userId, friendId },
    });
  }

  async updateFriendshipStatus(
    userId: string,
    friendId: string,
    status: string
  ): Promise<void> {
    // upsert, not update: "friendship.blocked" always fires right after
    // "friendship.deleted" has removed the row (blockUser unfriends first),
    // so an update() would throw P2025 and this local read-model would never
    // record BLOCKED at all — see deleteFriendship's comment above.
    await prisma.friendship.upsert({
      where: {
        userId_friendId: { userId, friendId },
      },
      update: { status },
      create: { userId, friendId, status },
    });
  }

  async getUserFriends(userId: string): Promise<string[]> {
    const friendships = await prisma.friendship.findMany({
      where: {
        userId,
        status: "ACTIVE",
      },
      select: { friendId: true },
    });
    return friendships.map((f) => f.friendId);
  }

  async getFriendshipsByStatus(
    userId: string,
    status: string
  ): Promise<string[]> {
    const friendships = await prisma.friendship.findMany({
      where: {
        userId,
        status,
      },
      select: { friendId: true },
    });
    return friendships.map((f) => f.friendId);
  }
}
