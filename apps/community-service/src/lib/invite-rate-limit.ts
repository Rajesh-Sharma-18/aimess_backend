import { TooManyRequestsError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import { env } from "../config/env.js";
import { redis, isCommunityCacheReady } from "../config/redis.js";

/**
 * Per-user abuse caps for invite-link CREATE and BULK-SEND.
 *
 * These two endpoints are now usable by ANY active community member (no longer
 * MODERATOR/ADMIN only), so a per-user rate limit bounds the new abuse surface
 * (link spamming, DM spamming). The limiter is a Redis fixed-window counter
 * keyed per user (NOT per community) so the quota can't be multiplied across
 * communities.
 *
 * Fail-open by design: the action reaching this point is ALREADY authorized
 * (membership + state verified). A Redis outage — or any environment where the
 * cache is disabled (dev/test) — must never block a legitimate member, so a
 * missing/unhealthy cache simply forfeits the cap for that call.
 */

const KEY_PREFIX = "community:invite-rl";

async function assertWithinWindow(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<void> {
  // No cache → fail open (dev/test, or Redis disabled/unreachable at boot).
  if (!isCommunityCacheReady()) return;

  try {
    const count = await redis.incr(key);
    if (count === 1) {
      // First hit in this window — arm the TTL so the counter self-expires.
      await redis.expire(key, windowSeconds);
    }
    if (count > limit) {
      throw new TooManyRequestsError("COMMUNITY_INVITE_LINK_RATE_LIMITED");
    }
  } catch (err) {
    // The cap itself is the only hard signal — re-throw it.
    if (err instanceof TooManyRequestsError) throw err;
    // Any Redis I/O failure → fail open (log + allow this one call).
    logger.error(
      `Invite-link rate-limit check failed (failing open) key=${key}: ${String(err)}`
    );
  }
}

/** Throttle invite-link CREATE per user. Throws 429 when the window is exceeded. */
export function assertInviteCreateRateLimit(userId: string): Promise<void> {
  return assertWithinWindow(
    `${KEY_PREFIX}:create:${userId}`,
    env.COMMUNITY_INVITE_CREATE_RATE_MAX,
    env.COMMUNITY_INVITE_CREATE_RATE_WINDOW_SEC
  );
}

/** Throttle invite-link BULK-SEND per user. Throws 429 when the window is exceeded. */
export function assertInviteBulkSendRateLimit(userId: string): Promise<void> {
  return assertWithinWindow(
    `${KEY_PREFIX}:bulk:${userId}`,
    env.COMMUNITY_INVITE_BULK_RATE_MAX,
    env.COMMUNITY_INVITE_BULK_RATE_WINDOW_SEC
  );
}
