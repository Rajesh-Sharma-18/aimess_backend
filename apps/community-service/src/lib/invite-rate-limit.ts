import { TooManyRequestsError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import { consumeFallbackWindow } from "@aimess/utils";

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
 * Degrades rather than disappearing. The action reaching this point is ALREADY
 * authorized (membership + state verified), so a cache problem must not block a
 * legitimate member — but invite creation is a WRITE path, and simply forfeiting
 * the cap meant a Redis blip silently removed it at exactly the moment a flood
 * is least absorbable. A Redis failure now falls back to a per-process counter
 * with the same ceiling; only a deployment with no cache at all (dev/test)
 * forfeits it outright, which is a deliberate configuration rather than a
 * failure.
 */

const KEY_PREFIX = "community:invite-rl";

async function assertWithinWindow(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<void> {
  // No cache configured at all (dev/test, or Redis disabled at boot): allow.
  // This is a deployment choice, not a failure, and the in-process fallback
  // would only ever bind on a single node.
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
    // Any Redis I/O failure → degrade to a per-process counter with the SAME
    // ceiling, rather than allowing the call outright. Invite creation is a
    // write path: a Redis blip used to remove its cap entirely, silently, at
    // exactly the moment a flood is least absorbable.
    const fallback = consumeFallbackWindow({
      key,
      windowMs: windowSeconds * 1000,
      limit,
    });
    if (!fallback.allowed) {
      throw new TooManyRequestsError(
        "COMMUNITY_INVITE_LINK_RATE_LIMITED",
        fallback.retryAfterSec
      );
    }
    logger.error(
      `Invite-link rate-limit check failed (degraded to per-process counter) key=${key}: ${String(err)}`
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
