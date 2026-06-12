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
    params: { limit: number; cursor?: string | null }
  ): Promise<Notification[]> {
    return this.prisma.notification.findMany({
      where: {
        userId,
        isDeleted: false,
        ...(params.cursor
          ? { createdAt: { lt: new Date(params.cursor) } }
          : {}),
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

  async deleteById(notificationId: string): Promise<void> {
    await this.prisma.notification.update({
      where: { id: notificationId },
      data: { isDeleted: true, deletedAt: new Date() },
    });
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
