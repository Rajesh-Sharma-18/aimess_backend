import type { PrismaClient, Notification } from "../generated/prisma/index.js";

export class NotificationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    userId: string;
    actorId: string;
    type: string;
    [key: string]: unknown;
  }): Promise<Notification> {
    return this.prisma.notification.create({
      data: {
        userId: data.userId,
        actorId: data.actorId,
        type: data.type,
        entity: (data.entity as object) ?? {},
        actorSnapshot: (data.actorSnapshot as object) ?? {},
        payload: (data.payload as object) ?? {},
        isRead: (data.isRead as boolean) ?? false,
        readAt: (data.readAt as Date) ?? null,
        isDeleted: (data.isDeleted as boolean) ?? false,
        deletedAt: (data.deletedAt as Date) ?? null,
      },
    });
  }

  async findByUserId(
    userId: string,
    params: {
      limit: number;
      cursor?: string | null;
      /**
       * Extra Prisma `where` fragment (e.g. category filter). Merged into
       * the base userId/isDeleted/cursor predicate — kept optional so
       * existing callers (gRPC list, tests) are unaffected.
       */
      where?: Record<string, unknown>;
    }
  ): Promise<Notification[]> {
    return this.prisma.notification.findMany({
      where: {
        userId,
        isDeleted: false,
        ...(params.cursor
          ? { createdAt: { lt: new Date(params.cursor) } }
          : {}),
        ...(params.where ?? {}),
      },
      orderBy: { createdAt: "desc" },
      take: params.limit,
    });
  }

  async markRead(
    notificationId: string,
    userId: string
  ): Promise<Notification | null> {
    // Scope the update to the owner so one user can't flip another user's
    // notification (IDOR). updateMany lets us filter by both id AND userId;
    // a non-owning id matches 0 rows and returns null without mutating.
    const result = await this.prisma.notification.updateMany({
      where: { id: notificationId, userId },
      data: { isRead: true, readAt: new Date() },
    });
    if (result.count === 0) return null;
    return this.prisma.notification.findFirst({
      where: { id: notificationId, userId },
    });
  }

  async markAllRead(userId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
  }

  async getUnreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { userId, isRead: false, isDeleted: false },
    });
  }

  async countByUserId(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { userId, isDeleted: false },
    });
  }

  /**
   * Per-tab totals for the Notification Center header. Five parallel counts
   * (one per tab) — cheaper than a groupBy round-trip on Mongo, and each
   * predicate hits the `(userId, type)` index. Returned map is keyed by the
   * lowercase tab id the frontend expects.
   */
  async countByCategories(userId: string): Promise<{
    all: number;
    friends: number;
    communities: number;
    mentions: number;
    system: number;
  }> {
    const base = { userId, isDeleted: false } as const;
    const [all, friends, communities, mentions, system] = await Promise.all([
      this.prisma.notification.count({ where: base }),
      this.prisma.notification.count({
        where: { ...base, type: { startsWith: "friend." } },
      }),
      this.prisma.notification.count({
        where: {
          ...base,
          AND: [
            { type: { startsWith: "community." } },
            { type: { notIn: ["chat.mention", "community.mention"] } },
          ],
        },
      }),
      this.prisma.notification.count({
        where: { ...base, type: { in: ["chat.mention", "community.mention"] } },
      }),
      this.prisma.notification.count({
        where: {
          ...base,
          NOT: [
            { type: { startsWith: "friend." } },
            { type: { startsWith: "community." } },
            { type: { in: ["chat.mention", "community.mention"] } },
          ],
        },
      }),
    ]);
    return { all, friends, communities, mentions, system };
  }

  async deleteById(
    notificationId: string,
    userId: string
  ): Promise<{ count: number }> {
    // Owner-scoped soft-delete (IDOR-safe, mirrors markRead): updateMany filters
    // by id AND userId, so a non-owning id matches 0 rows and mutates nothing.
    // isDeleted:false keeps re-deletes idempotent (a second call matches 0 rows).
    const result = await this.prisma.notification.updateMany({
      where: { id: notificationId, userId, isDeleted: false },
      data: { isDeleted: true, deletedAt: new Date() },
    });
    return { count: result.count };
  }

  async findByEntityId(
    userId: string,
    type: string,
    entityId: string
  ): Promise<Notification | null> {
    // Prisma MongoDB supports filtering on JSON path
    return this.prisma.notification.findFirst({
      where: {
        userId,
        type,
        entity: { path: ["id"], equals: entityId },
      },
    });
  }
}
