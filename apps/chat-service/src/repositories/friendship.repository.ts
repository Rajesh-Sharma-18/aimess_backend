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
    await prisma.friendship.delete({
      where: {
        userId_friendId: { userId, friendId },
      },
    });
  }

  async updateFriendshipStatus(
    userId: string,
    friendId: string,
    status: string
  ): Promise<void> {
    await prisma.friendship.update({
      where: {
        userId_friendId: { userId, friendId },
      },
      data: { status },
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
