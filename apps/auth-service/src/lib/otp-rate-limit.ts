import { TooManyRequestsError } from "@aimess/errors";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";

/**
 * Redis-backed throttle on OTP *issuance* (not per-row attempt cap).
 *
 * Counts requests per identifier (and per IP when available) within a sliding
 * window using INCR + EXPIRE. Once `OTP_REQUEST_MAX` is exceeded for either
 * counter, throws a 429. Fails open if Redis is unavailable so OTP delivery is
 * not blocked by a cache outage.
 */
async function hitCounter(key: string): Promise<number> {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, env.OTP_REQUEST_WINDOW_SEC);
  }
  return count;
}

export async function assertOtpRequestAllowed(
  identifier: string,
  ipAddress?: string | null
): Promise<void> {
  const keys = [`otp:req:${identifier}`];
  if (ipAddress) {
    keys.push(`otp:req:ip:${ipAddress}`);
  }

  let counts: number[];
  try {
    counts = await Promise.all(keys.map((key) => hitCounter(key)));
  } catch {
    // Redis optional: do not block OTP issuance on a cache outage.
    return;
  }

  if (counts.some((count) => count > env.OTP_REQUEST_MAX)) {
    throw new TooManyRequestsError("AUTH_OTP_REQUEST_THROTTLED");
  }
}
