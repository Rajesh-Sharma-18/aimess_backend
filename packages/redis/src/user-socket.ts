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

/**
 * Publish a server→client realtime event to a user's /chat namespace room.
 *
 * The api-gateway `/chat` namespace psubscribes `user:*` and relays the
 * `{ event, data }` envelope to room `user:<userId>`. Use this for
 * conversation and community list updates (e.g. community:updated,
 * community:created) — NOT for push/bell notifications (use publishUserSocketEvent).
 *
 * Returns ioredis' publish result; callers may fire-and-forget with `.catch()`.
 */
export function publishChatUserEvent(
  redis: Redis | Cluster,
  userId: string,
  event: string,
  data: unknown
): Promise<number> {
  return redis.publish(`user:${userId}`, JSON.stringify({ event, data }));
}

/**
 * Publish a server→client realtime event to a user's OWN devices only.
 *
 * `user:<id>` is not private — `presence:subscribe` lets any peer join that
 * Socket.IO room to watch someone's online state, so anything published there
 * is also delivered to those watchers. The api-gateway `/chat` namespace also
 * psubscribes `self:*` and relays to room `self:<userId>`, which only that
 * user's own sockets ever join. Use this for anything a peer must not see.
 */
export function publishChatSelfEvent(
  redis: Redis | Cluster,
  userId: string,
  event: string,
  data: unknown
): Promise<number> {
  return redis.publish(`self:${userId}`, JSON.stringify({ event, data }));
}

/**
 * Publish a server→client realtime event for a QR device-link (login) session.
 *
 * The api-gateway `/auth` namespace subscribes to `devlink:<linkToken>` and
 * relays the `{ event, data }` envelope to room `qr:<linkToken>` — the ONLY
 * room the unauthenticated scanning-browser socket joins. Never put a JWT,
 * refresh token, or userId in `data` for the browser-facing "scanned"/"rejected"/
 * "expired" events; only "approved" carries tokens, straight to the one browser
 * waiting in that room.
 */
export function publishQrLinkEvent(
  redis: Redis | Cluster,
  linkToken: string,
  event: string,
  data: unknown
): Promise<number> {
  return redis.publish(`devlink:${linkToken}`, JSON.stringify({ event, data }));
}

/**
 * Publish a "this device/session was just revoked" signal for an ALREADY-LIVE
 * socket connection to act on immediately (force-disconnect), independent of
 * whether that user happens to be connected to `/notify` right now.
 *
 * The api-gateway subscribes with a durable PSUBSCRIBE `session-revoke:*` (not
 * a per-user conditional subscribe like `/notify`'s `notify:<userId>`) so this
 * reaches a live `/chat`, `/community`, or `/stream` socket even if that user
 * never opened a `/notify` connection. Every namespace's socket carries
 * `socket.data.sessionId` (set by the shared auth middleware) — the gateway
 * disconnects only the socket(s) matching `sessionId`.
 */
export function publishSessionRevokedEvent(
  redis: Redis | Cluster,
  userId: string,
  sessionId: string
): Promise<number> {
  return redis.publish(
    `session-revoke:${userId}`,
    JSON.stringify({ sessionId })
  );
}

/**
 * Publish a "a new session/linked device was just created" signal so a user's
 * OTHER live devices refresh their linked-device / sessions list without polling.
 *
 * Mirror of `publishSessionRevokedEvent`: the api-gateway PSUBSCRIBEs
 * `session-created:*` (durable, like session-revoke) and relays the persisted
 * session DTO as the SAME client-facing `session:list_updated` event the revoke
 * path already emits — just with `action: "created"`. Fire-and-forget from the
 * caller; a Redis hiccup must never fail login/device-linking. `session` is the
 * already-serialized session-list row.
 */
export function publishSessionCreatedEvent(
  redis: Redis | Cluster,
  userId: string,
  session: unknown
): Promise<number> {
  return redis.publish(
    `session-created:${userId}`,
    JSON.stringify({ session })
  );
}
