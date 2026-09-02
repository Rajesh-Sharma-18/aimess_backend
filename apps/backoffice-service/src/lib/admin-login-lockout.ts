import { TooManyRequestsError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";

/**
 * Per-ACCOUNT lockout on repeated failed admin logins.
 *
 * User login has had this for a long time (`AUTH_MAX_FAILED_LOGINS` /
 * `AUTH_LOCKOUT_MINUTES`, recorded on the account row). The admin path had no
 * equivalent at all: a wrong password wrote an audit row and returned 401, and
 * nothing counted. The only brake was the gateway's IP-keyed limiter, which a
 * botnet or a rotating proxy pool sidesteps by construction — so a distributed
 * guessing run against a known admin address was unthrottled per account, and
 * success grants the whole backoffice RBAC surface plus an 8-hour token.
 *
 * Keyed by EMAIL rather than by admin id so an attempt against an address that
 * does not resolve to an admin is counted too. Keying on the resolved account
 * would leave a free oracle: unknown addresses would never lock, so "did not
 * lock out" would answer "is this an admin?".
 *
 * State lives in Redis rather than on `AdminUser`. That avoids a schema
 * migration on the highest-privilege table, and matches the OTP throttle next
 * door. The trade-off is recorded in SECURITY_FIXES.md: a Redis flush clears
 * lockouts, and the counter is not durable across a full cache loss.
 */

const FAILURE_KEY_PREFIX = "admin:login:fail:";

function failureKey(email: string): string {
  return `${FAILURE_KEY_PREFIX}${email.trim().toLowerCase()}`;
}

/**
 * Refuse the attempt when this address is locked out.
 *
 * Fails OPEN on a Redis error: a cache outage must not lock every admin out of
 * the platform. The gateway's IP limiter and the per-attempt audit row remain.
 */
export async function assertLoginNotLocked(email: string): Promise<void> {
  let failures: number;
  try {
    const raw = await redis.get(failureKey(email));
    failures = raw === null ? 0 : Number(raw);
  } catch (err) {
    logger.warn("admin login lockout check failed (fail-open)", {
      service: "backoffice-service",
      detail: String(err),
    });
    return;
  }

  if (Number.isFinite(failures) && failures >= env.ADMIN_MAX_FAILED_LOGINS) {
    // 429 rather than 401: the credential may well be right by now, and the
    // client should be told to wait rather than to keep trying. Deliberately
    // the same shape an IP throttle produces, so a locked account is not
    // distinguishable from a throttled address.
    throw new TooManyRequestsError(
      "RATE_LIMITED",
      env.ADMIN_LOCKOUT_MINUTES * 60
    );
  }
}

/** Count a failed attempt, arming the lockout window on the first one. */
export async function recordLoginFailure(email: string): Promise<void> {
  try {
    const key = failureKey(email);
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, env.ADMIN_LOCKOUT_MINUTES * 60);
    }
    if (count >= env.ADMIN_MAX_FAILED_LOGINS) {
      logger.warn("admin login locked out", {
        service: "backoffice-service",
        failures: count,
        lockoutMinutes: env.ADMIN_LOCKOUT_MINUTES,
      });
    }
  } catch (err) {
    logger.warn("admin login failure not recorded (fail-open)", {
      service: "backoffice-service",
      detail: String(err),
    });
  }
}

/** Clear the counter after a successful login. */
export async function clearLoginFailures(email: string): Promise<void> {
  try {
    await redis.del(failureKey(email));
  } catch {
    // The key expires on its own; a failure here is not worth surfacing.
  }
}
