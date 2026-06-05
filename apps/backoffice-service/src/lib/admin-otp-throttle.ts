import { TooManyRequestsError } from "@aimess/errors";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";

/**
 * Redis-backed throttle on admin OTP *issuance* (not per-row attempt cap).
 *
 * Counts requests per identifier (and per IP when available) within a sliding
 * window using INCR + EXPIRE. Once `ADMIN_OTP_REQUEST_MAX` is exceeded for
 * either counter, throws a 429. Fails open if Redis is unavailable so OTP
 * delivery is not blocked by a cache outage.
 */
async function hitCounter(key: string): Promise<number> {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, env.ADMIN_OTP_REQUEST_WINDOW_SEC);
  }
  return count;
}

export async function assertOtpRequestAllowed(
  identifier: string,
  ipAddress?: string | null
): Promise<void> {
  const keys = [`admin:otp:req:${identifier}`];
  if (ipAddress) {
    keys.push(`admin:otp:req:ip:${ipAddress}`);
  }

  let counts: number[];
  try {
    counts = await Promise.all(keys.map((key) => hitCounter(key)));
  } catch {
    // Redis optional: do not block OTP issuance on a cache outage.
    return;
  }

  if (counts.some((count) => count > env.ADMIN_OTP_REQUEST_MAX)) {
    throw new TooManyRequestsError("RATE_LIMITED");
  }
}

/**
 * Minimum cooldown between resend-otp requests for the same email. Uses
 * SET key 1 EX cooldown NX — if the key already exists (NX returns null) the
 * caller is within the cooldown. Fails open on Redis error.
 */
export async function assertResendCooldown(email: string): Promise<void> {
  const key = `admin:otp:resend:${email}`;
  let result: "OK" | null;
  try {
    result = await redis.set(
      key,
      "1",
      "EX",
      env.ADMIN_OTP_RESEND_COOLDOWN_SEC,
      "NX"
    );
  } catch {
    // Redis optional: do not block resend on a cache outage.
    return;
  }

  if (result === null) {
    throw new TooManyRequestsError("RATE_LIMITED");
  }
}
