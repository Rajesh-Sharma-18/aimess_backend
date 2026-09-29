import type { Cluster, Redis } from "ioredis";

/**
 * "Is the recipient already looking at this?" — the attention facts only the
 * gateway can see, for the two consumers that must not confuse them.
 *
 * A notification exists to tell someone about a message they would otherwise
 * miss. Sending one to a person whose eyes are on the conversation is pure
 * noise, and it was the single biggest complaint about burst sends: ten
 * messages typed at someone with the chat open produced ten tray entries.
 *
 * Two DIFFERENT questions, answered by two different keys:
 *
 *  - {@link chatOpenRoomKey} — "does this USER have the room open anywhere?"
 *    Read state is per account, so an unread counter must not tick for a message
 *    already on screen on any of their devices. App state is irrelevant to it.
 *  - {@link chatRoomViewersKey} — "which of their SESSIONS is looking at it right
 *    now?" A push is delivered to a DEVICE, so only the device actually showing
 *    the conversation may be skipped; every other session, another chat, another
 *    screen, a backgrounded tab, a second device, still needs the notification.
 *
 * Collapsing those two into one flag is what made a single tab anywhere in the
 * app silence a user's push everywhere.
 *
 * The gateway WRITES both (it alone knows which socket has which room open and
 * whether its app is foregrounded); notifications-service READS the viewers at
 * push time. All of it is short-TTL heartbeat state, never durable: a gateway
 * that dies without cleaning up costs the user at most
 * {@link ATTENTION_TTL_SECONDS} of missed pushes rather than silencing them
 * forever, which is the correct direction for the failure to lean.
 */

/** Comfortably longer than the gateway's presence refresh interval (45 s), so a
 *  healthy socket always re-stamps the key before it can lapse. */
export const ATTENTION_TTL_SECONDS = 120;

/**
 * This user currently has this conversation OPEN on at least one device, in any
 * app state. Drives unread suppression and read state — NOT push delivery.
 */
export const chatOpenRoomKey = (userId: string, roomId: string): string =>
  `chat:open:{${userId}}:${roomId}`;

/**
 * Who is ACTIVELY VIEWING `roomId` — the only signal push suppression may use.
 *
 * A hash per (user, room): one field per SOCKET, valued `<sessionId>|<expiry>`.
 * Both halves of that shape are load-bearing.
 *
 *  - **Per socket, not per session.** A browser login is ONE session shared by
 *    every tab, so a session-keyed flag written by the tab reading the chat and
 *    cleared by the tab sitting on Settings is whichever wrote last. Sockets are
 *    unique per tab (and per gateway node), so each one states only its own view
 *    and they cannot overwrite each other.
 *  - **Session in the value.** `sessionId` is the one identifier shared by a
 *    socket handshake and the `DeviceToken` row a push would be delivered to, so
 *    it is what the delivery side can actually exclude on. (`deviceId` is a
 *    client-generated opaque string on one side and a server-side fingerprint on
 *    the other, and can never be joined.)
 *  - **Expiry in the value, not just on the key.** A live socket re-stamps the
 *    key's TTL, which would otherwise keep a crashed gateway's orphaned field
 *    alive forever beside it. Readers drop fields whose own stamp has lapsed.
 */
export const chatRoomViewersKey = (userId: string, roomId: string): string =>
  `chat:viewing:{${userId}}:${roomId}`;

/** Stamp/refresh a key. Best-effort: presence hints must never break a send. */
export async function markChatAttention(
  redis: Redis | Cluster,
  key: string
): Promise<void> {
  try {
    await redis.set(key, "1", "EX", ATTENTION_TTL_SECONDS);
  } catch {
    /* a missing hint only means a push the recipient may not have needed */
  }
}

export async function clearChatAttention(
  redis: Redis | Cluster,
  key: string
): Promise<void> {
  try {
    await redis.del(key);
  } catch {
    /* see above — the key expires on its own */
  }
}

/**
 * Which of `userIds` have this room open right now. One pipeline, so a
 * community fan-out of 500 members costs a single round trip.
 *
 * Fails OPEN (empty set): if Redis is unreachable we would rather send a push
 * the recipient did not need than silently drop one they did.
 */
export async function usersWithRoomOpen(
  redis: Redis | Cluster,
  roomId: string,
  userIds: string[]
): Promise<Set<string>> {
  const open = new Set<string>();
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return open;
  try {
    const pipeline = redis.pipeline();
    for (const userId of unique)
      pipeline.exists(chatOpenRoomKey(userId, roomId));
    const replies = await pipeline.exec();
    if (!replies) return open;
    unique.forEach((userId, index) => {
      const reply = replies[index] as [Error | null, number] | undefined;
      if (reply && !reply[0] && reply[1] > 0) open.add(userId);
    });
  } catch {
    /* fail open */
  }
  return open;
}

/**
 * This socket has `roomId` open AND its app/tab is in the foreground — stamp it.
 * Re-stamping is how a long-running view keeps itself alive; see the TTL note on
 * {@link chatRoomViewersKey}.
 */
export async function markChatViewer(
  redis: Redis | Cluster,
  userId: string,
  roomId: string,
  sessionId: string,
  socketId: string
): Promise<void> {
  if (!userId || !roomId || !sessionId || !socketId) return;
  try {
    const key = chatRoomViewersKey(userId, roomId);
    const pipeline = redis.pipeline();
    pipeline.hset(
      key,
      socketId,
      `${sessionId}|${String(Date.now() + ATTENTION_TTL_SECONDS * 1000)}`
    );
    pipeline.expire(key, ATTENTION_TTL_SECONDS);
    await pipeline.exec();
  } catch {
    /* a missing hint only means a push the recipient may not have needed */
  }
}

/** This socket stopped viewing `roomId` — backgrounded, switched, left or gone. */
export async function clearChatViewer(
  redis: Redis | Cluster,
  userId: string,
  roomId: string,
  socketId: string
): Promise<void> {
  if (!userId || !roomId || !socketId) return;
  try {
    await redis.hdel(chatRoomViewersKey(userId, roomId), socketId);
  } catch {
    /* the field carries its own expiry — see chatRoomViewersKey */
  }
}

/**
 * Which of `userId`'s login SESSIONS are actively viewing `roomId` right now.
 *
 * Fails OPEN (empty set): a push the recipient did not need beats one they did
 * and never got. Fields whose own stamp has lapsed are ignored, so a gateway
 * that died mid-view stops suppressing on its own.
 */
export async function sessionsViewingRoom(
  redis: Redis | Cluster,
  userId: string,
  roomId: string
): Promise<Set<string>> {
  const viewing = new Set<string>();
  if (!userId || !roomId) return viewing;
  try {
    const fields = await redis.hgetall(chatRoomViewersKey(userId, roomId));
    const now = Date.now();
    for (const raw of Object.values(fields ?? {})) {
      const separator = raw.lastIndexOf("|");
      if (separator <= 0) continue;
      const expiresAt = Number(raw.slice(separator + 1));
      if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;
      viewing.add(raw.slice(0, separator));
    }
  } catch {
    /* fail open */
  }
  return viewing;
}
