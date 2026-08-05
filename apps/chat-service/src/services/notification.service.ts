import type { Redis, Cluster } from "ioredis";
import { publishUserSocketEvent } from "@aimess/redis";

import type { NotificationRepository } from "../repositories/notification.repository.js";
import type { Notification } from "../generated/prisma/index.js";
import {
  categoryWhere,
  categorize,
  type NotificationCategory,
} from "../lib/notification-category.js";
import {
  serializeNotification,
  type NotificationDTO,
  type AvatarRefreshMaps,
} from "../lib/notification-serializer.js";
import { userGrpcClient } from "../grpc/user-snapshot.client.js";
import { getCommunityReconcileClient } from "../grpc/community.client.js";

/**
 * Batch-resolves fresh actor/community avatar URLs for a page of notification
 * rows. Notifications persist `actorSnapshot`/`communityAvatarUrl` inside
 * `payload.data` at publish time — those are presigned MinIO URLs that expire
 * (see MINIO_*_EXPIRES_IN), so trusting the stored value shows a broken image
 * once a row is old enough. Resolving here, at read time, via the same
 * services that own the media (user-service, community-service) is the
 * resolve-on-read pattern the rest of the app already follows.
 */
async function resolveAvatarRefresh(
  rows: Notification[]
): Promise<AvatarRefreshMaps> {
  const actorIds = new Set<string>();
  const communityIds = new Set<string>();

  for (const n of rows) {
    if (n.actorId) actorIds.add(n.actorId);
    if (categorize(n.type) === "COMMUNITIES") {
      const data = (n.payload as { data?: Record<string, string> })?.data;
      if (data?.communityId) communityIds.add(data.communityId);
    }
  }

  // Both calls are best-effort — a transport failure must degrade to the
  // (possibly stale) stored snapshot, never fail the notification list.
  const [actors, communities] = await Promise.all([
    actorIds.size
      ? userGrpcClient.bulkGetUserSnapshots([...actorIds]).catch(() => [])
      : Promise.resolve([]),
    communityIds.size
      ? getCommunityReconcileClient().getCommunitiesByIds([...communityIds])
      : Promise.resolve([]),
  ]);

  return {
    actorById: new Map(
      actors
        .filter((a) => a.avatarUrl)
        .map((a) => [
          a.userId,
          { displayName: a.displayName, avatarUrl: a.avatarUrl },
        ])
    ),
    communityById: new Map(
      communities
        .filter((c) => c.avatarUrl)
        .map((c) => [c.communityId, { name: c.name, avatarUrl: c.avatarUrl }])
    ),
  };
}

export class NotificationService {
  constructor(
    private readonly notificationRepo: NotificationRepository,
    private readonly redis: Redis | Cluster
  ) {}

  /**
   * List notifications for the Notification Center. `category` restricts the
   * page to one tab (FRIENDS / COMMUNITIES / MENTIONS / SYSTEM); omit or
   * pass "ALL" for the mixed feed. Returns serialized DTOs with resolved
   * `actor` / `community` avatar blocks — clients no longer need to reach
   * into `payload.data`.
   */
  async getNotifications(
    userId: string,
    params: {
      limit: number;
      cursor?: string | null;
      category?: NotificationCategory;
      /** The requesting device's own session id — never show a device its own login alert. */
      viewerSessionId?: string | null;
    }
  ): Promise<NotificationDTO[]> {
    const rows = await this.notificationRepo.findByUserId(userId, {
      limit: params.limit,
      cursor: params.cursor,
      where: categoryWhere(params.category ?? "ALL"),
      viewerSessionId: params.viewerSessionId,
    });
    const refresh = await resolveAvatarRefresh(rows);
    return Promise.all(
      rows.map((n) => serializeNotification(n, userId, refresh))
    );
  }

  /**
   * Delta sync: every row whose `updatedAt` moved after `since`, oldest-first,
   * INCLUDING soft-deleted tombstones. This is what a client drains after a
   * reconnect / cold start instead of refetching the whole feed — it converges
   * creates, updates, reads and deletes made on any other device in one call.
   */
  async syncSince(
    userId: string,
    params: {
      since: Date;
      limit: number;
      viewerSessionId?: string | null;
    }
  ): Promise<{
    notifications: NotificationDTO[];
    nextSince: number;
    hasMore: boolean;
  }> {
    const rows = await this.notificationRepo.findUpdatedSince(
      userId,
      params.since,
      { limit: params.limit, viewerSessionId: params.viewerSessionId }
    );
    const refresh = await resolveAvatarRefresh(rows);
    const notifications = await Promise.all(
      rows.map((n) => serializeNotification(n, userId, refresh))
    );
    const hasMore = rows.length === params.limit;
    const nextSince = rows.length
      ? rows[rows.length - 1].updatedAt.getTime()
      : params.since.getTime();
    return { notifications, nextSince, hasMore };
  }

  /** Per-tab totals shown in the Notification Center header. */
  async getCounts(
    userId: string,
    viewerSessionId?: string | null
  ): Promise<{
    all: number;
    friends: number;
    communities: number;
    mentions: number;
    system: number;
  }> {
    return this.notificationRepo.countByCategories(userId, viewerSessionId);
  }

  // Marks one or more notifications read and relays the refreshed unread
  // count to every connected device (mirrors the socket-originated
  // notifications:mark_read path so REST and socket clients stay in sync).
  async markManyRead(
    notificationIds: string[],
    userId: string
  ): Promise<{ updatedCount: number; unreadCount: number }> {
    // One updateMany, not a read+write per id — the 500-id cap made this up to
    // 1000 Mongo ops for a single request.
    const updatedCount = await this.notificationRepo.markManyRead(
      notificationIds,
      userId
    );
    const unreadCount = await this.notificationRepo.getUnreadCount(userId);

    if (updatedCount > 0) {
      await this.publishCountEvent(userId, "notification:read", unreadCount, {
        notificationIds,
      });
    }
    return { updatedCount, unreadCount };
  }

  /**
   * Bulk mark-read for the Notification Center. When `category` is ALL/omitted
   * it flips every unread row; otherwise only rows in that tab. The returned
   * `unreadCount` is the ACROSS-ALL-CATEGORIES total (drives the top-bar
   * badge) — so a per-tab "Read All" correctly leaves other tabs' unreads
   * counted. The realtime `notification:all-read` publish carries the same
   * authoritative post-op total.
   */
  async markAllRead(
    userId: string,
    category: NotificationCategory = "ALL",
    before?: Date | null
  ): Promise<{ unreadCount: number }> {
    const extraWhere = category === "ALL" ? undefined : categoryWhere(category);
    await this.notificationRepo.markAllRead(userId, extraWhere, before ?? null);
    const unreadCount = await this.notificationRepo.getUnreadCount(userId);
    await this.publishCountEvent(userId, "notification:all-read", unreadCount);
    return { unreadCount };
  }

  async getUnreadCount(
    userId: string,
    viewerSessionId?: string | null
  ): Promise<number> {
    return this.notificationRepo.getUnreadCount(userId, viewerSessionId);
  }

  /**
   * Persists a user-initiated action (e.g. "TERMINATE" session, "CONFIRM" login)
   * on a notification: updates the stored body text + marks `actionTaken` in
   * `payload.data` so the UI renders the resolved state on every reload.
   * Emits `notification:updated` so open clients refresh without polling.
   */
  async recordAction(
    id: string,
    userId: string,
    body: string,
    action: string
  ): Promise<void> {
    const updated = await this.notificationRepo.recordAction(
      id,
      userId,
      body,
      action
    );
    if (!updated) return;
    try {
      await publishUserSocketEvent(this.redis, userId, "notification:updated", {
        notificationId: updated.id,
        userId,
        type: updated.type,
        body,
        isRead: true,
      });
    } catch {
      // best-effort — the DB write already succeeded
    }
  }

  // Best-effort realtime relay: publishes the named event plus the legacy
  // "notification:count_update" alias, both carrying the same unreadCount.
  private async publishCountEvent(
    userId: string,
    event: string,
    unreadCount: number,
    extra: Record<string, unknown> = {}
  ): Promise<void> {
    try {
      await publishUserSocketEvent(this.redis, userId, event, {
        unreadCount,
        ...extra,
      });
      await publishUserSocketEvent(
        this.redis,
        userId,
        "notification:count_update",
        {
          count: unreadCount,
          unreadCount,
        }
      );
    } catch {
      // never fail the mutation because the realtime relay failed
    }
  }
}
