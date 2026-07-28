import type { PrismaClient, Notification } from "../generated/prisma/index.js";
import { categoryWhere } from "../lib/notification-category.js";

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

  /** Owner-scoped bulk mark-read. One query regardless of id count. */
  async markManyRead(
    notificationIds: string[],
    userId: string
  ): Promise<number> {
    if (notificationIds.length === 0) return 0;
    const result = await this.prisma.notification.updateMany({
      where: { id: { in: notificationIds }, userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return result.count;
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

  /**
   * Bulk mark-read. `extraWhere` is an optional Prisma fragment (e.g. the
   * `categoryWhere("COMMUNITIES")` output from `lib/notification-category`) so
   * the Notification Center's per-tab "Read All" only flips rows belonging to
   * the currently-open tab. Omit or pass `undefined` for the historical
   * mark-everything behaviour.
   */
  async markAllRead(
    userId: string,
    extraWhere?: Record<string, unknown>
  ): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, isRead: false, ...(extraWhere ?? {}) },
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
   * Per-tab UNREAD counts for the Notification Center header badges. Five
   * parallel counts (one per tab) — cheaper than a groupBy round-trip on
   * Mongo, and each predicate hits the `(userId, type)` index. Unread-only
   * so the badge decrements live as the user reads rows; the list-page
   * invalidation on `markRead` / `markAllRead` triggers the refetch.
   */
  async countByCategories(userId: string): Promise<{
    all: number;
    friends: number;
    communities: number;
    mentions: number;
    system: number;
  }> {
    const base = { userId, isDeleted: false, isRead: false } as const;
    const [all, friends, communities, mentions, system] = await Promise.all([
      this.prisma.notification.count({ where: base }),
      this.prisma.notification.count({
        where: { ...base, ...categoryWhere("FRIENDS") },
      }),
      this.prisma.notification.count({
        where: { ...base, ...categoryWhere("COMMUNITIES") },
      }),
      this.prisma.notification.count({
        where: { ...base, ...categoryWhere("MENTIONS") },
      }),
      this.prisma.notification.count({
        where: { ...base, ...categoryWhere("SYSTEM") },
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

  async findByTypeAndActor(
    userId: string,
    type: string,
    actorId: string
  ): Promise<Notification | null> {
    return this.prisma.notification.findFirst({
      where: { userId, type, actorId, isDeleted: false },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Persists a user-initiated action on a notification (e.g. "TERMINATE" session,
   * "CONFIRM" login). Merges `actionTaken` into `payload.data`, updates `payload.body`,
   * and marks the row read in one write. Owner-scoped (IDOR-safe).
   */
  async recordAction(
    id: string,
    userId: string,
    body: string,
    action: string
  ): Promise<Notification | null> {
    const existing = await this.prisma.notification.findFirst({
      where: { id, userId, isDeleted: false },
    });
    if (!existing) return null;
    const existingPayload = (existing.payload ?? {}) as {
      title?: string;
      body?: string;
      data?: Record<string, string>;
    };
    const updatedPayload = {
      ...existingPayload,
      body,
      data: { ...(existingPayload.data ?? {}), actionTaken: action },
    };
    return this.prisma.notification.update({
      where: { id },
      data: { payload: updatedPayload, isRead: true, readAt: new Date() },
    });
  }

  async updatePayloadAndType(
    id: string,
    type: string,
    payload: Record<string, unknown>
  ): Promise<Notification | null> {
    return this.prisma.notification.update({
      where: { id },
      data: { type, payload },
    });
  }
}
