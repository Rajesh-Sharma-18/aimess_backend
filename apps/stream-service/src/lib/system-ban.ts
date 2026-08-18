import { ForbiddenError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import { isUserBanned } from "@aimess/redis";

import type { redis as RedisClient } from "../config/redis.js";

// Permanent Super Admin system ban. The flag is written by auth-service the
// moment AuthUser.status flips, and has no TTL — only an explicit unban clears
// it.
//
// `denyOnError` is the deliberate split from every other gate in this service:
// the community ban/mute/membership checks all fail OPEN because a
// community-service blip must not black out playback for everyone. A permanent
// ban is different on the write side — a banned host whose stream was just
// force-ended could mint a fresh streamKey and be back on air within seconds,
// so a Redis outage must never read as "not banned" on the paths that start or
// publish a broadcast. Watch/comment paths stay fail-open, where the worst case
// is one extra message from an account whose sessions are already revoked.
export async function isSystemBanned(
  redis: typeof RedisClient,
  userId: string,
  opts: { denyOnError: boolean }
): Promise<boolean> {
  try {
    return await isUserBanned(redis, userId);
  } catch (error) {
    logger.warn(
      `system-ban check unavailable for user=${userId} — treating as banned=${String(opts.denyOnError)}: ${String(error)}`
    );
    return opts.denyOnError;
  }
}

// Throwing, fail-closed variant for the go-live paths.
export async function assertNotSystemBanned(
  redis: typeof RedisClient,
  userId: string
): Promise<void> {
  if (await isSystemBanned(redis, userId, { denyOnError: true })) {
    throw new ForbiddenError("ACCOUNT_BANNED");
  }
}
