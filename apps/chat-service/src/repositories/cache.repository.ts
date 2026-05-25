import type { Redis } from "ioredis";

/**
 * Redis-based cache repository for presence, user snapshots, and session management.
 * Mirrors the reference JS CacheRepository pattern.
 */
export class CacheRepository {
  constructor(private readonly redis: Redis) {}

  // === Presence ===

  async upsertDeviceSession(params: {
    userId: string;
    deviceId: string;
    socketId: string;
    platform: string;
    clientType: string;
    realtimeConnected: boolean;
    appState: string;
    now: number;
  }): Promise<void> {
    const key = `presence:device:${params.userId}:${params.deviceId}`;
    await this.redis.hmset(key, {
      socketId: params.socketId,
      platform: params.platform,
      clientType: params.clientType,
      realtimeConnected: params.realtimeConnected ? "1" : "0",
      appState: params.appState,
      lastActiveAt: String(params.now),
      connectedAt: String(params.now),
    });
    // Expire in 10 minutes — heartbeat renews it
    await this.redis.expire(key, 600);
  }

  async heartbeat(params: {
    userId: string;
    deviceId: string;
    now: number;
  }): Promise<void> {
    const key = `presence:device:${params.userId}:${params.deviceId}`;
    await this.redis.hset(key, "lastActiveAt", String(params.now));
    await this.redis.expire(key, 600);
  }

  async setAppState(
    userId: string,
    deviceId: string,
    state: string,
    now: number
  ): Promise<void> {
    const key = `presence:device:${userId}:${deviceId}`;
    await this.redis.hmset(key, {
      appState: state,
      lastActiveAt: String(now),
    });
    await this.redis.expire(key, 600);
  }

  async setDisconnected(params: {
    userId: string;
    deviceId: string;
    nowMs: number;
  }): Promise<void> {
    const key = `presence:device:${params.userId}:${params.deviceId}`;
    await this.redis.hmset(key, {
      realtimeConnected: "0",
      disconnectedAt: String(params.nowMs),
    });
    // Keep for 5 minutes after disconnect for quick reconnect
    await this.redis.expire(key, 300);
  }

  async getDeviceSessions(
    userId: string
  ): Promise<Array<Record<string, string>>> {
    const pattern = `presence:device:${userId}:*`;
    const keys = await this.redis.keys(pattern);
    if (!keys.length) return [];

    const sessions: Array<Record<string, string>> = [];
    for (const key of keys) {
      const data = await this.redis.hgetall(key);
      if (data && Object.keys(data).length > 0) {
        sessions.push(data);
      }
    }
    return sessions;
  }

  // === User aggregate presence ===

  async setUserPresence(userId: string, isOnline: boolean): Promise<void> {
    await this.redis.set(
      `presence:user:${userId}`,
      isOnline ? "online" : "offline",
      "EX",
      isOnline ? 660 : 300
    );
  }

  async getUserPresence(userId: string): Promise<string | null> {
    return this.redis.get(`presence:user:${userId}`);
  }

  // === User Snapshot Cache ===

  async setUserSnapshot(
    userId: string,
    snapshot: Record<string, unknown>
  ): Promise<void> {
    await this.redis.set(
      `user:snapshot:${userId}`,
      JSON.stringify(snapshot),
      "EX",
      3600 // 1 hour
    );
  }

  async getUserSnapshot(
    userId: string
  ): Promise<Record<string, unknown> | null> {
    const data = await this.redis.get(`user:snapshot:${userId}`);
    if (!data) return null;
    try {
      return JSON.parse(data) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async getUserSnapshots(
    userIds: string[]
  ): Promise<Map<string, Record<string, unknown>>> {
    const map = new Map<string, Record<string, unknown>>();
    if (!userIds.length) return map;

    const pipeline = this.redis.pipeline();
    for (const id of userIds) {
      pipeline.get(`user:snapshot:${id}`);
    }
    const results = await pipeline.exec();
    if (!results) return map;

    for (let i = 0; i < userIds.length; i++) {
      const [err, data] = results[i] as [Error | null, string | null];
      if (!err && data) {
        try {
          map.set(userIds[i], JSON.parse(data) as Record<string, unknown>);
        } catch {
          // skip invalid JSON
        }
      }
    }
    return map;
  }

  // === General Room Read Tracking ===

  async markGeneralRoomRead(
    userId: string,
    roomId: string,
    timestamp: number
  ): Promise<void> {
    const key = `general:read:${userId}`;
    await this.redis.hset(key, roomId, String(timestamp));
    await this.redis.expire(key, 86400 * 7); // 7 days
  }

  async getGeneralRoomReadTimestamps(
    userId: string
  ): Promise<Record<string, string>> {
    return this.redis.hgetall(`general:read:${userId}`);
  }
}
