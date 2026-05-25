import type { Namespace } from "socket.io";

import { logger } from "@aimess/logger";

import type { CacheRepository } from "../repositories/cache.repository.js";

export class PresenceService {
  private readonly backgroundTimeoutMs: number;

  constructor(
    private readonly cacheRepo: CacheRepository,
    private readonly namespace: Namespace | null,
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

      // Emit presence change if status changed
      const prevOnline = previousStatus === "online";
      if (prevOnline !== isOnline && this.namespace) {
        const watchRoom = `watch:${userId}`;
        this.namespace.to(watchRoom).emit("presence:status", {
          userId,
          isOnline,
          lastActiveAt: isOnline
            ? now
            : Number(sessions[0]?.lastActiveAt || now),
        });
      }
    } catch (error) {
      logger.error(`PresenceService|recompute|userId=${userId}|error=${error}`);
    }
  }

  async heartbeat(userId: string, deviceId: string): Promise<void> {
    await this.cacheRepo.heartbeat({ userId, deviceId, now: Date.now() });
    await this.recompute(userId);
  }

  async getPresence(userId: string): Promise<boolean> {
    const status = await this.cacheRepo.getUserPresence(userId);
    return status === "online";
  }
}
