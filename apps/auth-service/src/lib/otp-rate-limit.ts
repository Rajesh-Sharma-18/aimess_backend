import { TooManyRequestsError } from "@aimess/errors";
import { consumeActionQuota } from "@aimess/utils";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";

/**
 * Throttle on OTP *issuance* (not per-row attempt cap). Client table: 3 per
 * hour per email, then blocked for an hour. The per-IP counter is a separate,
 * wider ceiling against one address mailing many inboxes. Degrades to a
 * per-process counter when Redis is down (see `consumeActionQuota`).
 */
export async function assertOtpRequestAllowed(
  identifier: string,
  ipAddress?: string | null
): Promise<void> {
  const windowSec = env.OTP_REQUEST_WINDOW_SEC;
  const checks = [
    consumeActionQuota(redis, {
      key: `otp:email:${identifier.toLowerCase()}`,
      limit: env.OTP_REQUEST_MAX,
      windowSec,
      blockSec: windowSec,
    }),
  ];
  if (ipAddress) {
    checks.push(
      consumeActionQuota(redis, {
        key: `otp:ip:${ipAddress}`,
        limit: env.OTP_REQUEST_IP_MAX,
        windowSec,
      })
    );
  }

  const blocked = (await Promise.all(checks)).find((r) => !r.allowed);
  if (blocked) {
    throw new TooManyRequestsError(
      "AUTH_OTP_REQUEST_THROTTLED",
      blocked.retryAfterSec
    );
  }
}
