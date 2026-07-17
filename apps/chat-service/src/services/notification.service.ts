import type { NotificationRepository } from "../repositories/notification.repository.js";
import type { Notification } from "../generated/prisma/index.js";
import { resolveNotificationFriendship } from "../lib/notification-friendship.enricher.js";

export class NotificationService {
  constructor(private readonly notificationRepo: NotificationRepository) {}

  async getNotifications(
    userId: string,
    params: { limit: number; cursor?: string | null }
  ): Promise<Notification[]> {
    const rows = await this.notificationRepo.findByUserId(userId, params);
    return Promise.all(
      rows.map(async (n) => {
        const data = (n.payload as { data?: Record<string, string> })?.data;
        const friendship = await resolveNotificationFriendship(
          userId,
          n.type,
          data?.friendshipId
        );
        return friendship
          ? ({ ...n, friendship } as unknown as Notification)
          : n;
      })
    );
  }

  async markRead(
    notificationId: string,
    userId: string
  ): Promise<Notification | null> {
    return this.notificationRepo.markRead(notificationId, userId);
  }

  async markAllRead(userId: string): Promise<void> {
    await this.notificationRepo.markAllRead(userId);
  }

  async countNotifications(userId: string): Promise<number> {
    return this.notificationRepo.countByUserId(userId);
  }

  async getUnreadCount(userId: string): Promise<number> {
    return this.notificationRepo.getUnreadCount(userId);
  }
}
