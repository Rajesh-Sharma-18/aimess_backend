import type { Redis, Cluster } from "ioredis";
import { publishUserSocketEvent } from "@aimess/redis";

import type { NotificationRepository } from "../repositories/notification.repository.js";
import type { Notification } from "../generated/prisma/index.js";
import { resolveNotificationFriendship } from "../lib/notification-friendship.enricher.js";

export class NotificationService {
  constructor(
    private readonly notificationRepo: NotificationRepository,
    private readonly redis: Redis | Cluster
  ) {}

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

  // Marks one or more notifications read and relays the refreshed unread
  // count to every connected device (mirrors the socket-originated
  // notifications:mark_read path so REST and socket clients stay in sync).
  async markManyRead(
    notificationIds: string[],
    userId: string
  ): Promise<{ updatedCount: number; unreadCount: number }> {
    const results = await Promise.all(
      notificationIds.map((id) => this.notificationRepo.markRead(id, userId))
    );
    const updatedCount = results.filter((r) => r !== null).length;
    const unreadCount = await this.notificationRepo.getUnreadCount(userId);

    if (updatedCount > 0) {
      await this.publishCountEvent(userId, "notification:read", unreadCount);
    }
    return { updatedCount, unreadCount };
  }

  async markAllRead(userId: string): Promise<{ unreadCount: number }> {
    await this.notificationRepo.markAllRead(userId);
    const unreadCount = 0;
    await this.publishCountEvent(userId, "notification:all-read", unreadCount);
    return { unreadCount };
  }

  async countNotifications(userId: string): Promise<number> {
    return this.notificationRepo.countByUserId(userId);
  }

  async getUnreadCount(userId: string): Promise<number> {
    return this.notificationRepo.getUnreadCount(userId);
  }

  // Best-effort realtime relay: publishes the named event plus the legacy
  // "notification:count_update" alias, both carrying the same unreadCount.
  private async publishCountEvent(
    userId: string,
    event: string,
    unreadCount: number
  ): Promise<void> {
    try {
      await publishUserSocketEvent(this.redis, userId, event, { unreadCount });
      await publishUserSocketEvent(this.redis, userId, "notification:count_update", {
        count: unreadCount,
        unreadCount,
      });
    } catch {
      // never fail the mutation because the realtime relay failed
    }
  }
}
