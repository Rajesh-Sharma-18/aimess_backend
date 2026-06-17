import type { Cluster, Redis } from "ioredis";

/**
 * Publish a server→client realtime event to a community room's channel.
 *
 * The api-gateway `/community` namespace psubscribes to `community:*` and relays
 * the `{ event, data }` envelope verbatim to room `community:<communityId>`. This
 * is the ONE place the channel name + envelope shape are defined — every service
 * that broadcasts a realtime event into a community room MUST go through here.
 *
 * Accepts either a standalone `Redis` or a `Cluster` client (both expose the same
 * `publish`), so cluster-mode services can use it unchanged. Returns ioredis'
 * publish result (subscriber count); callers may `await` it or fire-and-forget
 * with `.catch()`. Never mutates `data`.
 */
export function publishCommunityRoomEvent(
  redis: Redis | Cluster,
  communityId: string,
  event: string,
  data: unknown
): Promise<number> {
  return redis.publish(
    `community:${communityId}`,
    JSON.stringify({ event, data })
  );
}
