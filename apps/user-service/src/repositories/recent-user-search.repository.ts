import { RecentSearchTargetType } from "../generated/prisma/client.js";
import { prisma } from "../config/prisma.js";

const MAX_RECENT_USER_SEARCHES = 20;

export const recentUserSearchRepository = {
  /** Latest recently-viewed targets for a user, newest-viewed first. */
  findByUserId(userId: string) {
    return prisma.recentUserSearch.findMany({
      where: { userId },
      orderBy: { lastViewedAt: "desc" },
      take: MAX_RECENT_USER_SEARCHES,
    });
  },

  /**
   * Upsert by (userId, targetType, targetId): bumps `lastViewedAt` if the
   * target was already recorded, otherwise inserts a fresh row. Prunes rows
   * beyond MAX_RECENT_USER_SEARCHES per user after every write.
   */
  async upsert(params: {
    userId: string;
    targetType: RecentSearchTargetType;
    targetId: string;
  }): Promise<void> {
    const { userId, targetType, targetId } = params;

    await prisma.$transaction(async (tx) => {
      await tx.recentUserSearch.upsert({
        where: {
          userId_targetType_targetId: { userId, targetType, targetId },
        },
        create: { userId, targetType, targetId },
        update: { lastViewedAt: new Date() },
      });

      const oldest = await tx.recentUserSearch.findMany({
        where: { userId },
        orderBy: { lastViewedAt: "desc" },
        skip: MAX_RECENT_USER_SEARCHES,
        select: { id: true },
      });
      if (oldest.length > 0) {
        await tx.recentUserSearch.deleteMany({
          where: { id: { in: oldest.map((r) => r.id) } },
        });
      }
    });
  },

  deleteOne(params: {
    userId: string;
    targetType: RecentSearchTargetType;
    targetId: string;
  }) {
    return prisma.recentUserSearch.deleteMany({ where: params });
  },

  clearAll(userId: string) {
    return prisma.recentUserSearch.deleteMany({ where: { userId } });
  },
};
