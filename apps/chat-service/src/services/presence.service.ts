import type { Redis, Cluster } from "ioredis";

import { logger } from "@aimess/logger";

import type { CacheRepository } from "../repositories/cache.repository.js";

export class PresenceService {
  private readonly backgroundTimeoutMs: number;

  constructor(
    private readonly cacheRepo: CacheRepository,
    private readonly redis: Redis | Cluster | null,
    options?: { backgroundTimeoutMs?: number }
  ) {
    this.backgroundTimeoutMs = options?.backgroundTimeoutMs || 5 * 60 * 1000;
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
}
