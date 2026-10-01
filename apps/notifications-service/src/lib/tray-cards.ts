import { logger } from "@aimess/logger";

import { redis } from "../config/redis.js";

/**
 * "This user may still have a card with this tag in a tray."
 *
 * Set when a visible push with a collapse key goes out, taken (deleted) when a
 * dismissal for that tag is sent. It decides whether a dismissal needs a silent
 * push at all: most reads happen on conversations nobody was pushed for, and a
 * silent push per read would drain Chrome's silent-push budget (it starts
 * showing "This site has been updated in the background") and wake phones for
 * nothing. The socket half of a dismissal is always sent; it is free.
 *
 * Per USER, not per device: one push fans out to every device, so if one got the
 * card they all may have. 24h = the FCM TTL of the card itself.
 */
const TRAY_TTL_SEC = 86_400;

/** `{userId}` hash tag keeps one user's markers on one cluster slot. */
const trayKey = (userId: string, tag: string): string =>
  `push:tray:{${userId}}:${tag}`;

export async function markTrayCard(userId: string, tag: string): Promise<void> {
  try {
    await redis.set(trayKey(userId, tag), "1", "EX", TRAY_TTL_SEC);
  } catch (error) {
    logger.warn(`[push:tray] failed to mark ${tag} for ${userId}`);
    logger.warn(error);
  }
}

/**
 * Which of `tags` may still be on a device, clearing them as it goes. Fails
 * OPEN: when Redis is unreachable every tag is reported, so a dismissal is sent
 * rather than a card left behind.
 */
export async function takeTrayCards(
  userId: string,
  tags: readonly string[]
): Promise<string[]> {
  if (tags.length === 0) return [];
  try {
    const pipeline = redis.pipeline();
    for (const tag of tags) pipeline.del(trayKey(userId, tag));
    const results = (await pipeline.exec()) ?? [];
    return tags.filter((_, i) => Number(results[i]?.[1] ?? 0) > 0);
  } catch (error) {
    logger.warn(`[push:tray] lookup failed for ${userId}; dismissing anyway`);
    logger.warn(error);
    return [...tags];
  }
}
