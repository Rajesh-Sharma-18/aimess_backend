import { TooManyRequestsError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import { consumeFallbackWindow } from "./fallback-counter";

/** The three commands this needs — structural, so no ioredis dependency here. */
export type QuotaRedis = {
  incr(key: string): Promise<number>;
  ttl(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
};

export type ActionQuota = {
  /** Scoped id, e.g. `report:<userId>`. Keys are shared across services on one Redis. */
  key: string;
  limit: number;
  windowSec: number;
  /** Once exceeded, refuse for this long from the first refusal. Omitted = until the window ends. */
  blockSec?: number;
};

/**
 * Fixed-window per-action quota (window opens on the first hit). Degrades to
 * the per-process counter when Redis cannot answer, like every write limiter.
 */
export async function consumeActionQuota(
  redis: QuotaRedis,
  quota: ActionQuota
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const key = `aimess:quota:${quota.key}`;
  try {
    const count = await redis.incr(key);
    let ttl = await redis.ttl(key);
    // TTL check rather than `count === 1`: a lost EXPIRE must not leave a permanent block.
    if (ttl < 0) {
      await redis.expire(key, quota.windowSec);
      ttl = quota.windowSec;
    }
    if (count <= quota.limit) return { allowed: true, retryAfterSec: 0 };
    if (count === quota.limit + 1 && quota.blockSec) {
      await redis.expire(key, quota.blockSec);
      ttl = quota.blockSec;
    }
    return { allowed: false, retryAfterSec: Math.max(1, ttl) };
  } catch (err) {
    logger.warn("action_quota_fallback", {
      quota: quota.key,
      detail: String(err),
    });
    return consumeFallbackWindow({
      key,
      windowMs: quota.windowSec * 1000,
      limit: quota.limit,
    });
  }
}

/** {@link consumeActionQuota}, throwing a 429 carrying `messageKey` + retry-after. */
export async function assertActionQuota(
  redis: QuotaRedis,
  quota: ActionQuota,
  messageKey: string
): Promise<void> {
  const { allowed, retryAfterSec } = await consumeActionQuota(redis, quota);
  if (!allowed) throw new TooManyRequestsError(messageKey, retryAfterSec);
}

/** One daily report budget per user, shared by every service that files reports. */
export function assertReportQuota(
  redis: QuotaRedis,
  userId: string
): Promise<void> {
  return assertActionQuota(
    redis,
    { key: `report:${userId}`, limit: 20, windowSec: 86_400 },
    "REPORT_LIMIT_REACHED"
  );
}
