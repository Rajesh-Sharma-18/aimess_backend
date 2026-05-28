import type { NotificationRepository } from "../repositories/notification.repository.js";
import type { Notification } from "../generated/prisma/index.js";

export class NotificationService {
  constructor(private readonly notificationRepo: NotificationRepository) {}

  async getNotifications(
    userId: string,
    params: { limit: number; cursor?: string | null }
  ): Promise<Notification[]> {
    return this.notificationRepo.findByUserId(userId, params);
  }

  async markRead(notificationId: string): Promise<Notification | null> {
    return this.notificationRepo.markRead(notificationId);
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
