import type { Cluster, Redis } from "ioredis";

/**
 * Publish a server→client realtime event to a single user's notify channel.
 *
 * The api-gateway `/notify` namespace subscribes to `notify:<userId>` and relays
 * the `{ event, data }` envelope verbatim to that user's connected sockets. This
 * is the ONE place the channel name + envelope shape are defined — every service
 * that pushes a realtime notification to a user MUST go through here.
 *
 * Accepts either a standalone `Redis` or a `Cluster` client (both expose the same
 * `publish`), so cluster-mode services (e.g. chat-service) can use it unchanged.
 * Returns ioredis' publish result (subscriber count); callers may `await` it or
 * fire-and-forget with `.catch()`. Never mutates `data`.
 */
export function publishUserSocketEvent(
  redis: Redis | Cluster,
  userId: string,
  event: string,
  data: unknown
): Promise<number> {
  return redis.publish(`notify:${userId}`, JSON.stringify({ event, data }));
}
