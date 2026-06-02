import type { Redis, Cluster } from "ioredis";

/**
 * Redis-based cache repository for presence, user snapshots, and session management.
 * Mirrors the reference JS CacheRepository pattern.
 *
 * Accepts both a single Redis instance and a Cluster instance so the
 * repository works without changes in both local-dev (single node) and
 * production (Redis Cluster) environments.
 *
 * Key naming: device-session keys use a Redis hash tag `{userId}` so all
 * sessions for one user are guaranteed to land on the same cluster slot.
 * This makes the SCAN-then-pipeline pattern reliable in cluster mode.
 */
export class CacheRepository {
  constructor(private readonly redis: Redis | Cluster) {}

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
    const key = `presence:device:{${params.userId}}:${params.deviceId}`;
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
    const key = `presence:device:{${params.userId}}:${params.deviceId}`;
    await this.redis.hset(key, "lastActiveAt", String(params.now));
    await this.redis.expire(key, 600);
  }

  async setAppState(
    userId: string,
    deviceId: string,
    state: string,
    now: number
  ): Promise<void> {
    const key = `presence:device:{${userId}}:${deviceId}`;
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
    const key = `presence:device:{${params.userId}}:${params.deviceId}`;
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
    // All device-session keys for this user share the hash tag {userId} so they
    // all live on the same cluster slot. In cluster mode we still scan every
    // master to be safe; most will return empty immediately.
    const pattern = `presence:device:{${userId}}:*`;
    const keys: string[] = [];

    if ((this.redis as { isCluster?: boolean }).isCluster) {
      const cluster = this.redis as Cluster;
      for (const node of cluster.nodes("master")) {
        let cursor = "0";
        do {
          const [nextCursor, batch] = await node.scan(
            cursor,
            "MATCH",
            pattern,
            "COUNT",
            100
          );
          cursor = nextCursor;
          keys.push(...batch);
        } while (cursor !== "0");
      }
    } else {
      let cursor = "0";
      do {
        const [nextCursor, batch] = await (this.redis as Redis).scan(
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          100
        );
        cursor = nextCursor;
        keys.push(...batch);
      } while (cursor !== "0");
    }

    if (!keys.length) return [];

    const sessions: Array<Record<string, string>> = [];
    const pipeline = this.redis.pipeline();
    for (const key of keys) {
      pipeline.hgetall(key);
    }
    const results = await pipeline.exec();
    if (results) {
      for (const result of results) {
        const [err, data] = result as [
          Error | null,
          Record<string, string> | null,
        ];
        if (!err && data && Object.keys(data).length > 0) {
          sessions.push(data);
        }
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

  async setLastSeen(userId: string, ts: number): Promise<void> {
    // Retain ~30 days so the chat header can show "last seen" long after a user
    // goes offline.
    await this.redis.set(
      `presence:lastseen:${userId}`,
      String(ts),
      "EX",
      60 * 60 * 24 * 30
    );
  }

  async getLastSeen(userId: string): Promise<number | null> {
    const value = await this.redis.get(`presence:lastseen:${userId}`);
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
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

  async setMessageIdempotency(
    cacheKey: string,
    messageId: string
  ): Promise<void> {
    await this.redis.set(`chat:idem:${cacheKey}`, messageId, "EX", 300);
  }

  async getMessageIdempotency(cacheKey: string): Promise<string | null> {
    return this.redis.get(`chat:idem:${cacheKey}`);
  }
}
