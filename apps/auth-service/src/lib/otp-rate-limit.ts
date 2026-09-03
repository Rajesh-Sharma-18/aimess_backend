import { TooManyRequestsError } from "@aimess/errors";
import { consumeFallbackWindow } from "@aimess/utils";

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
    // Degrade to a per-process counter with the same ceiling rather than
    // allowing issuance outright. OTP issuance mails a live account-recovery
    // code, so an unbounded path here is a mail-flood and a code-guessing
    // surface — and a Redis outage used to remove the cap silently.
    const fallback = keys.map((key) =>
      consumeFallbackWindow({
        key,
        windowMs: env.OTP_REQUEST_WINDOW_SEC * 1000,
        limit: env.OTP_REQUEST_MAX,
      })
    );
    const blocked = fallback.find((result) => !result.allowed);
    if (blocked) {
      throw new TooManyRequestsError(
        "AUTH_OTP_REQUEST_THROTTLED",
        blocked.retryAfterSec
      );
    }
    return;
  }

  if (counts.some((count) => count > env.OTP_REQUEST_MAX)) {
    throw new TooManyRequestsError("AUTH_OTP_REQUEST_THROTTLED");
  }
}
