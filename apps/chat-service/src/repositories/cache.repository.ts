import type { Redis, Cluster } from "ioredis";

import {
  PRESENCE_ONLINE_INDEX_KEY,
  legacyPresenceLastSeenKey,
  presenceDeviceKey,
  presenceLastSeenKey,
  presenceStatusKey,
  presenceVersionKey,
  readPresenceSnapshots,
  type PresenceSnapshot,
} from "@aimess/redis";

/**
 * Set status + version + last-seen in ONE atomic step and report whether this
 * was a real transition.
 *
 * Doing it in three round trips let two chat-service replicas interleave —
 * replica A writing "online" while replica B wrote "offline", then bumping the
 * versions in the other order, so the highest version could describe the state
 * that did NOT win and every client would settle on a stale dot. Redis executes
 * a script atomically, so the stored status and the version that labels it can
 * no longer disagree.
 *
 * A missing status key reads as "offline", NOT as "unknown". That is what makes
 * the first connect a transition, and it is also why the status key is given a
 * long TTL: if it could expire out from under a still-online user, their
 * eventual disconnect would compute offline→offline, emit nothing, and leave
 * every watcher with a permanently green dot.
 *
 * KEYS 1-3 all carry the same `{userId}` hash tag, so this is a single-slot
 * script in cluster mode.
 */
const PRESENCE_TRANSITION_SCRIPT = `
local nextState = ARGV[1]
local statusTtl = tonumber(ARGV[2])
local nowMs = ARGV[3]
local longTtl = tonumber(ARGV[4])

local prevState = redis.call('GET', KEYS[1]) or 'offline'
redis.call('SET', KEYS[1], nextState, 'EX', statusTtl)

local changed = 0
local version = redis.call('GET', KEYS[2])
if prevState ~= nextState then
  changed = 1
  version = redis.call('INCR', KEYS[2])
end
if not version then version = 0 end
redis.call('EXPIRE', KEYS[2], longTtl)

local lastSeen
if nextState == 'offline' then
  lastSeen = nowMs
  redis.call('SET', KEYS[3], lastSeen, 'EX', longTtl)
else
  lastSeen = redis.call('GET', KEYS[3])
end

return { changed, tostring(version), lastSeen or '' }
`;

/** Version + last-seen retention. Must outlive the status key so a version can never rewind. */
const PRESENCE_LONG_TTL_SECONDS = 60 * 60 * 24 * 30;

/** Outcome of {@link CacheRepository.applyPresenceTransition}. */
export interface PresenceTransition {
  /** True only when the stored status actually flipped — the gate for broadcasting. */
  changed: boolean;
  /** Monotonic per-user counter; only advances on `changed`. */
  version: number;
  /** Server-generated epoch ms; null while online and never previously seen. */
  lastSeen: number | null;
}

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
  /**
   * How long a device-session hash survives without a refresh. This is the
   * liveness backstop for the case no `disconnect` event ever fires — a killed
   * process, a dead TCP path, or a gateway node that went down with its sockets
   * still open. Refreshed by the gateway on every live socket (see the
   * packet-driven keepalive in chat.ns.ts), so it only has to outlast a couple
   * of missed refreshes, not a whole idle session.
   */
  private readonly deviceTtlSeconds: number;

  /** See {@link PRESENCE_TRANSITION_SCRIPT} — must outlive any live session. */
  private readonly statusTtlSeconds: number;

  constructor(
    private readonly redis: Redis | Cluster,
    options?: { deviceTtlSeconds?: number; statusTtlSeconds?: number }
  ) {
    this.deviceTtlSeconds = options?.deviceTtlSeconds ?? 150;
    this.statusTtlSeconds = options?.statusTtlSeconds ?? 60 * 60 * 24;
  }

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
    const key = presenceDeviceKey(params.userId, params.deviceId);
    await this.redis.hmset(key, {
      socketId: params.socketId,
      platform: params.platform,
      clientType: params.clientType,
      realtimeConnected: params.realtimeConnected ? "1" : "0",
      appState: params.appState,
      lastActiveAt: String(params.now),
      connectedAt: String(params.now),
    });
    await this.redis.expire(key, this.deviceTtlSeconds);
  }

  async heartbeat(params: {
    userId: string;
    deviceId: string;
    now: number;
  }): Promise<void> {
    const key = presenceDeviceKey(params.userId, params.deviceId);
    await this.redis.hset(key, "lastActiveAt", String(params.now));
    await this.redis.expire(key, this.deviceTtlSeconds);
  }

  async setAppState(
    userId: string,
    deviceId: string,
    state: string,
    now: number
  ): Promise<void> {
    const key = presenceDeviceKey(userId, deviceId);
    await this.redis.hmset(key, {
      appState: state,
      lastActiveAt: String(now),
    });
    await this.redis.expire(key, this.deviceTtlSeconds);
  }

  async setDisconnected(params: {
    userId: string;
    deviceId: string;
    nowMs: number;
  }): Promise<void> {
    const key = presenceDeviceKey(params.userId, params.deviceId);
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
    const pattern = `${presenceDeviceKey(userId, "")}*`;
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

  /**
   * Write the new aggregate status, bump the version if (and only if) it
   * actually changed, and stamp `lastSeen` on the way offline — atomically.
   * The caller broadcasts iff `changed`.
   */
  async applyPresenceTransition(
    userId: string,
    isOnline: boolean,
    nowMs: number
  ): Promise<PresenceTransition> {
    const raw = (await this.redis.eval(
      PRESENCE_TRANSITION_SCRIPT,
      3,
      presenceStatusKey(userId),
      presenceVersionKey(userId),
      presenceLastSeenKey(userId),
      isOnline ? "online" : "offline",
      String(this.statusTtlSeconds),
      String(nowMs),
      String(PRESENCE_LONG_TTL_SECONDS)
    )) as [number, string, string];

    const lastSeen = Number(raw?.[2]);
    return {
      changed: Number(raw?.[0]) === 1,
      version: Number(raw?.[1]) || 0,
      lastSeen: Number.isFinite(lastSeen) && raw?.[2] !== "" ? lastSeen : null,
    };
  }

  /**
   * Add/remove this user in the stale-session sweeper index.
   * `staleAtMs` is when an unrefreshed ONLINE belief stops being credible.
   */
  async setOnlineIndex(
    userId: string,
    isOnline: boolean,
    staleAtMs: number
  ): Promise<void> {
    if (isOnline) {
      await this.redis.zadd(PRESENCE_ONLINE_INDEX_KEY, staleAtMs, userId);
    } else {
      await this.redis.zrem(PRESENCE_ONLINE_INDEX_KEY, userId);
    }
  }

  /** Users whose ONLINE belief is past its deadline and must be re-derived. */
  async getStaleOnlineUserIds(nowMs: number, limit: number): Promise<string[]> {
    return this.redis.zrangebyscore(
      PRESENCE_ONLINE_INDEX_KEY,
      "-inf",
      nowMs,
      "LIMIT",
      0,
      limit
    );
  }

  async setUserPresence(userId: string, isOnline: boolean): Promise<void> {
    await this.redis.set(
      presenceStatusKey(userId),
      isOnline ? "online" : "offline",
      "EX",
      this.statusTtlSeconds
    );
  }

  async getUserPresence(userId: string): Promise<string | null> {
    return this.redis.get(presenceStatusKey(userId));
  }

  /** Batch presence lookup — same keys as {@link getUserPresence}, one round trip. */
  async getUserPresences(
    userIds: string[]
  ): Promise<Map<string, string | null>> {
    const map = new Map<string, string | null>();
    if (!userIds.length) return map;
    const values = await this.redis.mget(...userIds.map(presenceStatusKey));
    userIds.forEach((id, i) => map.set(id, values[i] ?? null));
    return map;
  }

  async setLastSeen(userId: string, ts: number): Promise<void> {
    // Retain ~30 days so the chat header can show "last seen" long after a user
    // goes offline.
    await this.redis.set(
      presenceLastSeenKey(userId),
      String(ts),
      "EX",
      PRESENCE_LONG_TTL_SECONDS
    );
  }

  async getLastSeen(userId: string): Promise<number | null> {
    const value =
      (await this.redis.get(presenceLastSeenKey(userId))) ??
      // Pre-hash-tag key; drop once the 30-day retention window has rolled over.
      (await this.redis.get(legacyPresenceLastSeenKey(userId)));
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * Batch `{isOnline, lastSeen, version}` — one pipeline for a whole
   * conversation list or `presence:subscribe` batch. Carries the version so a
   * hydrated snapshot can be compared against live events instead of being
   * blindly overwritten by a late one.
   */
  async getPresenceSnapshots(
    userIds: string[]
  ): Promise<Map<string, PresenceSnapshot>> {
    return readPresenceSnapshots(this.redis, userIds);
  }

  // === User Snapshot Cache ===

  async setUserSnapshot(
    userId: string,
    snapshot: Record<string, unknown>,
    ttlSeconds = 3600
  ): Promise<void> {
    await this.redis.set(
      `user:snapshot:${userId}`,
      JSON.stringify(snapshot),
      "EX",
      ttlSeconds
    );
  }

  /**
   * Invalidate a cached user snapshot so the next read refetches the live
   * profile from user-service. Called on `user.profile_updated`: snapshots have
   * a 1h TTL and are otherwise never refreshed, so without this a rename leaves
   * a stale `displayName` denormalized into every message/preview sent in that
   * window (the "<old name>: 📷 Photo" community-list bug).
   */
  async deleteUserSnapshot(userId: string): Promise<void> {
    await this.redis.del(`user:snapshot:${userId}`);
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
