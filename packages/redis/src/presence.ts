import type { Cluster, Redis } from "ioredis";

/**
 * Presence keyspace — the ONE definition shared by every service that reads or
 * writes online status.
 *
 * chat-service owns the WRITES (PresenceService/CacheRepository); the
 * api-gateway only READS, to hydrate a `presence:subscribe` ack and to
 * re-authorize watchers. Both used to guess at key names independently — the
 * gateway even kept its own `user:online:<id>` flag, which disagreed with the
 * canonical state whenever a user had more than one socket open.
 *
 * All three per-user keys carry the `{userId}` hash tag so they land on ONE
 * cluster slot and can be mutated together by the transition script.
 */
export const presenceStatusKey = (userId: string): string =>
  `presence:user:{${userId}}`;
export const presenceLastSeenKey = (userId: string): string =>
  `presence:lastseen:{${userId}}`;
export const presenceVersionKey = (userId: string): string =>
  `presence:ver:{${userId}}`;

/**
 * Pre-hash-tag key names. Read-only, and only for `lastSeen`: that value is
 * retained for 30 days, so dropping it at deploy time would blank "last seen"
 * for every user at once. Status and version are ephemeral and are simply
 * recomputed on the next connect, so they have no legacy read.
 *
 * Safe to delete 30 days after the release that introduced the tagged keys.
 */
export const legacyPresenceLastSeenKey = (userId: string): string =>
  `presence:lastseen:${userId}`;

/**
 * Sorted set of users currently believed ONLINE, scored by the epoch-ms
 * deadline after which that belief is stale. This is what makes an unclean
 * disappearance (killed browser, crashed gateway node, dead TCP) eventually
 * resolve to OFFLINE: the device-session hashes expire on their own TTL, but
 * nothing would ever notice — and therefore nothing would ever emit the offline
 * event — without a scheduled reader. chat-service's presence sweeper drains
 * `ZRANGEBYSCORE presence:online -inf <now>` and recomputes exactly those users.
 *
 * ponytail: one global ZSET, so in cluster mode it is a single hot slot. It is
 * touched once per presence transition (not per heartbeat) and read once per
 * sweep tick, so that is fine well past the current scale; shard by
 * `presence:online:{<bucket>}` if it ever isn't.
 */
export const PRESENCE_ONLINE_INDEX_KEY = "presence:online";

/** Device-session hash for one live socket. Already `{userId}`-tagged. */
export const presenceDeviceKey = (userId: string, deviceId: string): string =>
  `presence:device:{${userId}}:${deviceId}`;

/**
 * A user's presence as the backend knows it. `version` is a per-user counter
 * bumped ONLY on a real ONLINE↔OFFLINE transition, so a client can discard an
 * event that arrives after a newer one (see BACKEND_PRESENCE_MOBILE.md §stale
 * events). `lastSeen` is server-generated epoch ms and is null only when the
 * user has never been seen offline.
 */
export interface PresenceSnapshot {
  userId: string;
  isOnline: boolean;
  lastSeen: number | null;
  version: number;
}

const toNumberOrNull = (raw: string | null): number | null => {
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Batch read of the canonical presence state. One pipeline for every user, so
 * hydrating a 500-peer `presence:subscribe` costs a single round trip.
 *
 * Never throws: a Redis failure degrades to "offline, no last seen", which is
 * the same shape a denied viewer gets and therefore always safe to render.
 */
export async function readPresenceSnapshots(
  redis: Redis | Cluster,
  userIds: string[]
): Promise<Map<string, PresenceSnapshot>> {
  const result = new Map<string, PresenceSnapshot>();
  const unique = [...new Set(userIds.filter(Boolean))];
  for (const userId of unique) {
    result.set(userId, { userId, isOnline: false, lastSeen: null, version: 0 });
  }
  if (unique.length === 0) return result;

  try {
    const pipeline = redis.pipeline();
    for (const userId of unique) {
      pipeline.get(presenceStatusKey(userId));
      pipeline.get(presenceLastSeenKey(userId));
      pipeline.get(presenceVersionKey(userId));
      pipeline.get(legacyPresenceLastSeenKey(userId));
    }
    const replies = await pipeline.exec();
    if (!replies) return result;

    unique.forEach((userId, index) => {
      const at = (offset: number): string | null => {
        const reply = replies[index * 4 + offset] as
          | [Error | null, string | null]
          | undefined;
        return reply && !reply[0] ? reply[1] : null;
      };
      result.set(userId, {
        userId,
        isOnline: at(0) === "online",
        lastSeen: toNumberOrNull(at(1)) ?? toNumberOrNull(at(3)),
        version: toNumberOrNull(at(2)) ?? 0,
      });
    });
  } catch {
    // Fail closed — the pre-seeded offline defaults stand.
  }
  return result;
}
