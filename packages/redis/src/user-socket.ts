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
  data: unknown,
  /** When set, the /notify relay skips the socket whose session matches this id. */
  excludeSessionId?: string
): Promise<number> {
  return redis.publish(
    `notify:${userId}`,
    JSON.stringify({
      event,
      data,
      ...(excludeSessionId ? { excludeSessionId } : {}),
    })
  );
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
 * How long the one-shot success mailbox below survives. Must comfortably
 * outlive both the QR's own 60s TTL and a transient browser disconnect, since
 * the tokens it holds are the ONLY copy the browser will ever be offered.
 */
const QR_LINK_RESULT_TTL_SECONDS = 120;

export function qrLinkResultKey(linkToken: string): string {
  return `aimess:devlink:result:${linkToken}`;
}

/**
 * Publish `auth:qr:success` AND leave a one-shot copy in Redis.
 *
 * Redis pub/sub has no buffering: a message published while the browser's
 * socket is mid-handshake, mid-reconnect, or momentarily dropped is discarded
 * forever, and the browser never learns it was logged in. Because this one
 * event carries the only copy of the freshly-minted tokens, losing it strands
 * the login even though the phone reported success.
 *
 * So the envelope is also written to a short-lived mailbox key, which the
 * api-gateway `/auth` namespace read-and-deletes every time a socket subscribes
 * to `qr:<linkToken>` (including on reconnect). Live delivery stays the fast
 * path; the mailbox is the catch-up path. Single-use by construction — the
 * take is atomic, so the tokens can be collected exactly once.
 *
 * Exposure is unchanged from the pub/sub path: possession of the linkToken has
 * always been sufficient to join the room and receive these tokens.
 */
export async function publishQrLinkSuccess(
  redis: Redis | Cluster,
  linkToken: string,
  data: unknown
): Promise<void> {
  await redis.set(
    qrLinkResultKey(linkToken),
    JSON.stringify({ event: "auth:qr:success", data }),
    "EX",
    QR_LINK_RESULT_TTL_SECONDS
  );
  await publishQrLinkEvent(redis, linkToken, "auth:qr:success", data);
}

/** GET + DEL in one round trip so only one subscriber can ever collect it. */
const TAKE_QR_RESULT_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if raw then redis.call('DEL', KEYS[1]) end
return raw
`;

/**
 * Read-and-delete the pending `auth:qr:success` envelope for a linkToken, if
 * one is waiting. Returns null when nothing is pending (the overwhelmingly
 * common case — every subscribe that happens before a scan).
 */
export async function takeQrLinkResult(
  redis: Redis | Cluster,
  linkToken: string
): Promise<{ event: string; data: unknown } | null> {
  const raw = (await redis.eval(
    TAKE_QR_RESULT_SCRIPT,
    1,
    qrLinkResultKey(linkToken)
  )) as string | null;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { event: string; data: unknown };
  } catch {
    return null;
  }
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
 *
 * `reason` separates a user's OWN sign-out on this device (`"logout"`) and its
 * own account deletion (`"account_deleted"`) from a revoke it did not ask for
 * (`"terminated"` — another device, admin, expiry). All three force-disconnect;
 * only `"terminated"` warrants the client-facing `auth:session_terminated`
 * notice (see api-gateway `session-revoke.ts`). Account deletion is required to
 * be completely silent — the user asked to leave, so no device of theirs may be
 * told anything about it.
 */
export function publishSessionRevokedEvent(
  redis: Redis | Cluster,
  userId: string,
  sessionId: string,
  reason: "terminated" | "logout" | "account_deleted" = "terminated"
): Promise<number> {
  return redis.publish(
    `session-revoke:${userId}`,
    JSON.stringify({ sessionId, reason })
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
