import type { Redis, Cluster } from "ioredis";

import { logger } from "@aimess/logger";

import type { CacheRepository } from "../repositories/cache.repository.js";
import type { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import { normalizeMessageType } from "../lib/chat-message.serializer.js";
import { convertMessageToPreview } from "./message-preview.service.js";

/**
 * Hook contract the presence service uses to trigger delivered-tick backfill
 * for offline messages when a user comes back online. Injected AFTER the
 * message services are constructed (mutual dependency), via `wireBackfill`.
 */
export interface PresenceBackfillHooks {
  backfillDeliveredOnPresenceConnect(userId: string): Promise<void>;
}

export class PresenceService {
  private readonly backgroundTimeoutMs: number;
  /** Cap on how many private rooms get a presence-driven conv:updated bump per status flip. */
  private static readonly PRESENCE_BUMP_ROOM_LIMIT = 500;
  private privateBackfill?: PresenceBackfillHooks;
  private groupBackfill?: PresenceBackfillHooks;

  constructor(
    private readonly cacheRepo: CacheRepository,
    private readonly redis: Redis | Cluster | null,
    // ponytail: optional so existing callers/tests that construct PresenceService
    // without a PrivateRoomRepository keep working — presence-driven conv:updated
    // fan-out is simply skipped when omitted.
    private readonly privateRoomRepo?: PrivateRoomRepository,
    options?: { backgroundTimeoutMs?: number }
  ) {
    this.backgroundTimeoutMs = options?.backgroundTimeoutMs || 5 * 60 * 1000;
  }

  /**
   * Late-bound wiring for the presence-connect delivered-tick backfill hooks,
   * called AFTER construction because Presence and Private/Group message
   * services depend on each other. Absent injection is a valid state — the
   * backfill simply doesn't run (test/legacy compatible).
   */
  wireBackfill(hooks: {
    privateMessages?: PresenceBackfillHooks;
    groupMessages?: PresenceBackfillHooks;
  }): void {
    this.privateBackfill = hooks.privateMessages;
    this.groupBackfill = hooks.groupMessages;
  }

  /** Single canonical online-status read — reused by REST responses and conv:updated. */
  async getIsOnline(userId: string): Promise<boolean> {
    return this.getPresence(userId);
  }

  /** Batch canonical online-status read — one Redis round trip for many peers. */
  async getPresenceMany(userIds: string[]): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    if (userIds.length === 0) return result;
    try {
      const statuses = await this.cacheRepo.getUserPresences(userIds);
      if (statuses instanceof Map) {
        for (const [id, status] of statuses)
          result.set(id, status === "online");
      }
    } catch (error) {
      logger.warn(`PresenceService|getPresenceMany|error=${error}`);
    }
    return result;
  }

  /**
   * Recompute aggregate online status for a user based on all their device sessions.
   * If any device is FOREGROUND and connected, user is online.
   * Emits presence change to all watchers via `watch:{userId}` room.
   */
  async recompute(userId: string): Promise<void> {
    try {
      const sessions = await this.cacheRepo.getDeviceSessions(userId);
      const now = Date.now();

      const isOnline = sessions.some((session) => {
        if (session.realtimeConnected !== "1") return false;
        if (session.appState === "FOREGROUND") return true;
        if (session.appState === "BACKGROUND") {
          const lastActive = Number(session.lastActiveAt || 0);
          return now - lastActive < this.backgroundTimeoutMs;
        }
        return false;
      });

      const previousStatus = await this.cacheRepo.getUserPresence(userId);
      await this.cacheRepo.setUserPresence(userId, isOnline);

      // When the user is no longer online, persist a "last seen" timestamp.
      let lastSeen: number | null = null;
      if (!isOnline) {
        lastSeen = now;
        await this.cacheRepo.setLastSeen(userId, lastSeen);
      }

      // Emit presence change if status changed
      const prevOnline = previousStatus === "online";
      // Offline→online transition: sweep any messages that landed while the
      // user was offline and mark them delivered — fires one `message:delivered`
      // per affected room so senders' ticks catch up without waiting for the
      // client to individually ack each incoming message on catchup.
      if (!prevOnline && isOnline) {
        if (this.privateBackfill) {
          void this.privateBackfill
            .backfillDeliveredOnPresenceConnect(userId)
            .catch((err) =>
              logger.warn(
                `PresenceService|privateBackfill|userId=${userId}|error=${String(err)}`
              )
            );
        }
        if (this.groupBackfill) {
          void this.groupBackfill
            .backfillDeliveredOnPresenceConnect(userId)
            .catch((err) =>
              logger.warn(
                `PresenceService|groupBackfill|userId=${userId}|error=${String(err)}`
              )
            );
        }
      }
      if (prevOnline !== isOnline && this.redis) {
        await this.redis.publish(
          `user:${userId}`,
          JSON.stringify({
            event: "presence:status",
            data: {
              userId,
              isOnline,
              lastActiveAt: isOnline
                ? now
                : Number(sessions[0]?.lastActiveAt ?? now),
              lastSeen,
            },
          })
        );
        // Bump `conv:updated` for every peer this user shares a private room
        // with, so their conversation-list row picks up the new `isOffline`
        // without a refetch — only rooms this user actually participates in,
        // never a broadcast.
        void this.publishPresenceBumpToPeers(userId, !isOnline).catch((err) =>
          logger.warn(
            `PresenceService|presenceBump|userId=${userId}|error=${String(err)}`
          )
        );
      }
    } catch (error) {
      logger.error(`PresenceService|recompute|userId=${userId}|error=${error}`);
    }
  }

  async connect(
    userId: string,
    deviceId: string,
    meta: { platform: string; clientType: string; appState: string }
  ): Promise<void> {
    await this.cacheRepo.upsertDeviceSession({
      userId,
      deviceId,
      socketId: "",
      platform: meta.platform,
      clientType: meta.clientType,
      realtimeConnected: true,
      appState: meta.appState,
      now: Date.now(),
    });
    await this.recompute(userId);
  }

  async disconnect(userId: string, deviceId: string): Promise<void> {
    await this.cacheRepo.setDisconnected({
      userId,
      deviceId,
      nowMs: Date.now(),
    });
    await this.cacheRepo.setLastSeen(userId, Date.now());
    await this.recompute(userId);
  }

  async heartbeat(
    userId: string,
    deviceId: string,
    appState?: string
  ): Promise<void> {
    if (appState) {
      await this.cacheRepo.setAppState(userId, deviceId, appState, Date.now());
    } else {
      await this.cacheRepo.heartbeat({ userId, deviceId, now: Date.now() });
    }
    await this.recompute(userId);
  }

  async getPresence(userId: string): Promise<boolean> {
    const status = await this.cacheRepo.getUserPresence(userId);
    return status === "online";
  }

  async getLastSeen(userId: string): Promise<number | null> {
    return this.cacheRepo.getLastSeen(userId);
  }

  /**
   * Re-publish `conv:updated` (existing shape + `isOffline`) to every peer this
   * user shares a private room with, using the room's own last-known message —
   * no content changed, only the peer's live presence. Skipped when no
   * PrivateRoomRepository was injected (tests) or the user has no rooms.
   * ponytail: shared-preview only (no per-recipient delete-for-me override) —
   * matches the fallback shape other bump call sites already use when overrides
   * aren't in hand; upgrade if a peer reports a stale preview on presence bumps.
   */
  private async publishPresenceBumpToPeers(
    userId: string,
    isOffline: boolean
  ): Promise<void> {
    if (!this.privateRoomRepo || !this.redis) return;
    const rooms = await this.privateRoomRepo.findRoomsForPresenceBump(
      userId,
      PresenceService.PRESENCE_BUMP_ROOM_LIMIT
    );
    if (!Array.isArray(rooms) || rooms.length === 0) return;

    const pipeline = this.redis.pipeline();
    for (const room of rooms) {
      const lm = room.lastMessage as Record<string, unknown> | null;
      const messageType = normalizeMessageType(
        (lm?.messageType as string) ?? "TEXT"
      );
      pipeline.publish(
        `user:${room.peerId}`,
        JSON.stringify({
          event: "conv:updated",
          data: {
            type: "PRIVATE",
            roomId: room.roomId,
            lastMessageId: room.lastMessageId ?? "",
            lastMessage: {
              contentType: messageType,
              text: lm ? convertMessageToPreview(messageType, lm.content) : "",
            },
            lastMessageAt: room.lastMessageAt?.getTime() ?? 0,
            senderId: (lm?.senderId as string) ?? "",
            senderName: "",
            unread: false,
            isOffline,
          },
        })
      );
    }
    await pipeline.exec();
  }
}
