import type { Cluster, Redis } from "ioredis";

/**
 * "Is the recipient already looking at this?" — the two facts push delivery
 * needs and only the gateway can see.
 *
 * A notification exists to tell someone about a message they would otherwise
 * miss. Sending one to a person whose eyes are on the conversation is pure
 * noise, and it was the single biggest complaint about burst sends: ten
 * messages typed at someone with the chat open produced ten tray entries.
 *
 * The gateway WRITES these (it is the only process that knows which socket has
 * which room open, and whether the app is foregrounded); notifications-service
 * READS them at push time. Both are short-TTL heartbeat keys, never durable
 * state: a gateway that dies without cleaning up costs the user at most
 * {@link ATTENTION_TTL_SECONDS} of missed pushes rather than silencing them
 * forever, which is the correct direction for the failure to lean.
 */

/** Comfortably longer than the gateway's presence refresh interval (45 s), so a
 *  healthy socket always re-stamps the key before it can lapse. */
export const ATTENTION_TTL_SECONDS = 120;

/** This user currently has this conversation OPEN on at least one device. */
export const chatOpenRoomKey = (userId: string, roomId: string): string =>
  `chat:open:{${userId}}:${roomId}`;

/**
 * This login SESSION has a live, foregrounded socket. Keyed by `sessionId`
 * because that is the one identifier shared by a socket handshake and the
 * `DeviceToken` row a push would be delivered to — `deviceId` is a
 * client-generated opaque string on one side and a server-side fingerprint on
 * the other, so the two can never be joined.
 */
export const chatForegroundSessionKey = (
  userId: string,
  sessionId: string
): string => `chat:fg:{${userId}}:${sessionId}`;

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

/** Which of `sessionIds` belong to a foregrounded socket of `userId`. */
export async function foregroundSessions(
  redis: Redis | Cluster,
  userId: string,
  sessionIds: string[]
): Promise<Set<string>> {
  const live = new Set<string>();
  const unique = [...new Set(sessionIds.filter(Boolean))];
  if (unique.length === 0) return live;
  try {
    const pipeline = redis.pipeline();
    for (const sessionId of unique) {
      pipeline.exists(chatForegroundSessionKey(userId, sessionId));
    }
    const replies = await pipeline.exec();
    if (!replies) return live;
    unique.forEach((sessionId, index) => {
      const reply = replies[index] as [Error | null, number] | undefined;
      if (reply && !reply[0] && reply[1] > 0) live.add(sessionId);
    });
  } catch {
    /* fail open */
  }
  return live;
}
