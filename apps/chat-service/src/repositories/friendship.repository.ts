import type { PrismaClient, Friendship } from "../generated/prisma/index.js";

export class FriendshipRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    requesterId: string;
    users: string[];
    pairKey: string;
    [key: string]: unknown;
  }): Promise<Friendship> {
    return this.prisma.friendship.create({
      data: {
        requesterId: data.requesterId,
        users: data.users,
        pairKey: data.pairKey,
        status: (data.status as string) ?? "PENDING",
        lastInteractionAt: (data.lastInteractionAt as Date) ?? new Date(),
      },
    });
  }

  async findByPairKey(pairKey: string): Promise<Friendship | null> {
    return this.prisma.friendship.findUnique({ where: { pairKey } });
  }

  async findById(id: string): Promise<Friendship | null> {
    return this.prisma.friendship.findUnique({ where: { id } });
  }

  async updateStatus(
    id: string,
    status: string,
    extra?: Record<string, unknown>
  ): Promise<Friendship | null> {
    return this.prisma.friendship.update({
      where: { id },
      data: {
        status,
        lastInteractionAt: new Date(),
        ...extra,
      } as Parameters<typeof this.prisma.friendship.update>[0]["data"],
    });
  }

  async findFriends(
    userId: string,
    params: { status?: string; limit: number; cursor?: string | null }
  ): Promise<Friendship[]> {
    return this.prisma.friendship.findMany({
      where: {
        users: { has: userId },
        ...(params.status ? { status: params.status } : {}),
        ...(params.cursor
          ? { lastInteractionAt: { lt: new Date(params.cursor) } }
          : {}),
      },
      orderBy: { lastInteractionAt: "desc" },
      take: params.limit,
    });
  }

  async findPendingReceived(
    userId: string,
    params: { limit: number; cursor?: string | null }
  ): Promise<Friendship[]> {
    return this.prisma.friendship.findMany({
      where: {
        users: { has: userId },
        status: "PENDING",
        requesterId: { not: userId },
        ...(params.cursor
          ? { createdAt: { lt: new Date(params.cursor) } }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: params.limit,
    });
  }

  async findPendingSent(
    userId: string,
    params: { limit: number; cursor?: string | null }
  ): Promise<Friendship[]> {
    return this.prisma.friendship.findMany({
      where: {
        requesterId: userId,
        status: "PENDING",
        ...(params.cursor
          ? { createdAt: { lt: new Date(params.cursor) } }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: params.limit,
    });
  }

  async deleteById(id: string): Promise<void> {
    await this.prisma.friendship.delete({ where: { id } });
  }

  async areFriends(userId1: string, userId2: string): Promise<boolean> {
    const pairKey = [userId1, userId2].sort().join(":");
    const friendship = await this.prisma.friendship.findFirst({
      where: { pairKey, status: "ACCEPTED" },
    });
    return friendship !== null;
  }

  async countFriends(userId: string): Promise<number> {
    return this.prisma.friendship.count({
      where: { users: { has: userId }, status: "ACCEPTED" },
    });
  }
}
