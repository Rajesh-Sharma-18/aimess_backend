import { TooManyRequestsError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";

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
 * State is DURABLE, in Postgres. It lived in Redis, which meant a cache flush
 * cleared every lockout on the highest-privilege login on the platform —
 * a routine operational act, and one an attacker who can trigger it would
 * choose deliberately. Admin logins are rare enough that the extra query per
 * attempt does not matter, and the request already reads Postgres to resolve
 * the admin.
 */

/** Normalized key: the same address must not get a fresh budget by casing. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Window length, mirroring the TTL the Redis key used to carry. */
function windowMs(): number {
  return env.ADMIN_LOCKOUT_MINUTES * 60 * 1000;
}

/**
 * Refuse the attempt when this address is locked out.
 *
 * Fails OPEN on a database error, as the Redis version did: an infrastructure
 * fault must not lock every admin out of the platform. The gateway's IP limiter
 * and the per-attempt audit row remain. In practice a failure here means login
 * is about to fail anyway, since resolving the admin needs the same database.
 */
export async function assertLoginNotLocked(email: string): Promise<void> {
  let row: { failures: number; windowStartedAt: Date } | null;
  try {
    row = await prisma.adminLoginFailure.findUnique({
      where: { email: normalizeEmail(email) },
      select: { failures: true, windowStartedAt: true },
    });
  } catch (err) {
    logger.warn("admin login lockout check failed (fail-open)", {
      service: "backoffice-service",
      detail: String(err),
    });
    return;
  }

  if (!row) return;

  // An expired window is not a lockout. The row is left for `recordLoginFailure`
  // to reset rather than deleted here, so a read never writes.
  if (Date.now() - row.windowStartedAt.getTime() >= windowMs()) return;

  if (row.failures >= env.ADMIN_MAX_FAILED_LOGINS) {
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

/** Count a failed attempt, opening the lockout window on the first one. */
export async function recordLoginFailure(email: string): Promise<void> {
  const key = normalizeEmail(email);
  const now = new Date();

  try {
    // One statement so two concurrent failures cannot both read 0 and both
    // write 1. `ON CONFLICT` also restarts the window when the previous one has
    // closed, which is what the Redis key's expiry used to do.
    const rows = await prisma.$queryRaw<{ failures: number }[]>`
      INSERT INTO "AdminLoginFailure" ("email", "failures", "windowStartedAt", "updatedAt")
      VALUES (${key}, 1, ${now}, ${now})
      ON CONFLICT ("email") DO UPDATE SET
        "failures" = CASE
          WHEN "AdminLoginFailure"."windowStartedAt" < ${new Date(now.getTime() - windowMs())}
          THEN 1
          ELSE "AdminLoginFailure"."failures" + 1
        END,
        "windowStartedAt" = CASE
          WHEN "AdminLoginFailure"."windowStartedAt" < ${new Date(now.getTime() - windowMs())}
          THEN ${now}
          ELSE "AdminLoginFailure"."windowStartedAt"
        END,
        "updatedAt" = ${now}
      RETURNING "failures"
    `;

    const count = rows[0]?.failures ?? 0;
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
    await prisma.adminLoginFailure.deleteMany({
      where: { email: normalizeEmail(email) },
    });
  } catch {
    // A stale row stops counting once its window closes; not worth surfacing.
  }
}

/**
 * Drop rows whose window closed long ago.
 *
 * Redis expired keys for us. A durable table does not, and every attempted
 * address — including the addresses a spray tries once — leaves a row. Called
 * from the scheduled cleanup that already prunes expired OTPs and sessions.
 */
export async function purgeStaleLoginFailures(): Promise<number> {
  const cutoff = new Date(Date.now() - windowMs());
  const { count } = await prisma.adminLoginFailure.deleteMany({
    where: { windowStartedAt: { lt: cutoff } },
  });
  return count;
}
