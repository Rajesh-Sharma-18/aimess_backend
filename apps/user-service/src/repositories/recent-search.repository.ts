import { prisma } from "../config/prisma.js";

const MAX_RECENT_SEARCHES = 10;

export const recentSearchRepository = {
  /** Return the latest recent searches for a user, newest first. */
  findByUserId(userId: string) {
    return prisma.recentSearch.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: MAX_RECENT_SEARCHES,
    });
  },

  findById(id: string) {
    return prisma.recentSearch.findUnique({ where: { id } });
  },

  /**
   * Upsert by content: if the same searchedUserId or query already exists for
   * this user, delete the stale row then insert fresh (bumps to top of list).
   * Enforces the MAX_RECENT_SEARCHES cap by pruning oldest rows after insert.
   */
  async upsert(params: {
    userId: string;
    searchedUserId?: string;
    query?: string;
  }): Promise<void> {
    const { userId, searchedUserId, query } = params;

    await prisma.$transaction(async (tx) => {
      // Remove duplicate if it exists
      if (searchedUserId) {
        await tx.recentSearch.deleteMany({
          where: { userId, searchedUserId },
        });
      } else if (query) {
        await tx.recentSearch.deleteMany({
          where: { userId, query },
        });
      }

      // Insert fresh row
      await tx.recentSearch.create({
        data: { userId, searchedUserId, query },
      });

      // Prune oldest beyond cap
      const oldest = await tx.recentSearch.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        skip: MAX_RECENT_SEARCHES,
        select: { id: true },
      });
      if (oldest.length > 0) {
        await tx.recentSearch.deleteMany({
          where: { id: { in: oldest.map((r) => r.id) } },
        });
      }
    });
  },

  deleteById(id: string, userId: string) {
    return prisma.recentSearch.deleteMany({
      where: { id, userId },
    });
  },

  clearAll(userId: string) {
    return prisma.recentSearch.deleteMany({ where: { userId } });
  },
};
