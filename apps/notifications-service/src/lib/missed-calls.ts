import { logger } from "@aimess/logger";

import { redis } from "../config/redis.js";

// ponytail: a week bounds a never-read chat; the tray card itself lives 24h.
const TTL_SEC = 7 * 86_400;

const key = (calleeId: string, roomId: string): string =>
  `push:missedcalls:{${calleeId}}:${roomId}`;

/** Counts one more unread missed call in this chat; returns the running totals. */
export async function countMissedCall(
  calleeId: string,
  roomId: string,
  callerId: string,
  video: boolean
): Promise<{ voice: number; video: number }> {
  const single = { voice: video ? 0 : 1, video: video ? 1 : 0 };
  try {
    const k = key(calleeId, roomId);
    const res = await redis
      .multi()
      .hincrby(k, video ? "video" : "voice", 1)
      .hset(k, "callerId", callerId)
      .expire(k, TTL_SEC)
      .hgetall(k)
      .exec();
    const all = (res?.[3]?.[1] ?? {}) as Record<string, string>;
    return { voice: Number(all.voice ?? 0), video: Number(all.video ?? 0) };
  } catch (error) {
    logger.warn(`[push:missed] count failed for ${calleeId}`);
    logger.warn(error);
    return single;
  }
}

/** Resets the chat's missed-call count; returns the caller whose card to close. */
export async function clearMissedCalls(
  calleeId: string,
  roomId: string
): Promise<string | null> {
  try {
    const k = key(calleeId, roomId);
    const res = await redis.multi().hget(k, "callerId").del(k).exec();
    return (res?.[0]?.[1] as string | null) ?? null;
  } catch (error) {
    logger.warn(`[push:missed] clear failed for ${calleeId}`);
    logger.warn(error);
    return null;
  }
}
