import { AppError } from "@aimess/errors";
import { consumeActionQuota } from "@aimess/utils";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";

/**
 * Client table: 5 wrong passwords within 10 minutes lock the account for 15.
 * Records one wrong password; returns the lock length (seconds) when this
 * failure trips the lock, else 0.
 */
export async function recordWrongPassword(userId: string): Promise<number> {
  const { allowed } = await consumeActionQuota(redis, {
    key: `login-fail:${userId}`,
    limit: env.AUTH_MAX_FAILED_LOGINS - 1,
    windowSec: env.AUTH_FAILED_LOGIN_WINDOW_MINUTES * 60,
  });
  return allowed ? 0 : env.AUTH_LOCKOUT_MINUTES * 60;
}

/** AUTH_ACCOUNT_LOCKED (401, unchanged) now carrying the seconds until the lock lifts. */
export function accountLockedError(lockedForSec: number): AppError {
  return new AppError(
    "AUTH_ACCOUNT_LOCKED",
    401,
    "AUTH_ACCOUNT_LOCKED",
    Math.max(1, Math.ceil(lockedForSec))
  );
}

export function lockedForSec(lockedUntil: Date | null): number {
  return lockedUntil ? (lockedUntil.getTime() - Date.now()) / 1000 : 0;
}
