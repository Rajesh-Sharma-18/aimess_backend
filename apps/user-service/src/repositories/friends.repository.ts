import { FriendshipStatus, Prisma } from "../generated/prisma/client.js";
import { prisma } from "../config/prisma.js";

export type FriendProfileRow = {
  userId: string;
  username: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
};

export const friendsRepository = {
  /** userIds of accepted friends (the side that is NOT `me`). */
  async listAcceptedFriendIds(me: string): Promise<string[]> {
    const friendships = await prisma.friendship.findMany({
      where: {
        status: FriendshipStatus.ACCEPTED,
        OR: [{ requesterId: me }, { addresseeId: me }],
      },
      select: { requesterId: true, addresseeId: true },
    });

    return friendships.map((f) =>
      f.requesterId === me ? f.addresseeId : f.requesterId
    );
  },

  /**
   * Accepted-friend profiles, alphabetical, optionally filtered by `search`.
   * Cursor pagination on userId (stable tiebreaker after firstName/lastName).
   */
  async listFriendProfiles(params: {
    friendIds: string[];
    search?: string;
    limit: number;
    cursor?: string;
  }): Promise<FriendProfileRow[]> {
    if (params.friendIds.length === 0) {
      return [];
    }

    const where: Prisma.UserProfileWhereInput = {
      userId: { in: params.friendIds },
      deletedAt: null,
    };

    if (params.search && params.search.length > 0) {
      const contains = {
        contains: params.search,
        mode: "insensitive",
      } as const;
      where.OR = [
        { firstName: contains },
        { lastName: contains },
        { username: contains },
      ];
    }

    return prisma.userProfile.findMany({
      where,
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }, { userId: "asc" }],
      take: params.limit + 1,
      ...(params.cursor ? { skip: 1, cursor: { userId: params.cursor } } : {}),
      select: {
        userId: true,
        username: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
      },
    });
  },
};
