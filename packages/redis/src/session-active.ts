import type Redis from "ioredis";

const SESSION_ACTIVE_PREFIX = "aimess:session:active:";

export function sessionActiveRedisKey(sessionId: string): string {
  return `${SESSION_ACTIVE_PREFIX}${sessionId}`;
}

/** Mark session as active (call after login / token issue). */
export async function registerActiveSession(
  redis: Redis,
  sessionId: string,
  ttlSeconds: number
): Promise<void> {
  await redis.set(sessionActiveRedisKey(sessionId), "1", "EX", ttlSeconds);
}

/**
 * Force logout on next API call.
 * Writes `0` (not DELETE) so revoke works even if login never registered the key.
 */
export async function revokeActiveSession(
  redis: Redis,
  sessionId: string,
  ttlSeconds: number
): Promise<void> {
  await redis.set(sessionActiveRedisKey(sessionId), "0", "EX", ttlSeconds);
}

export async function revokeActiveSessions(
  redis: Redis,
  sessionIds: string[],
  ttlSeconds: number
): Promise<void> {
  if (sessionIds.length === 0) return;

  const pipeline = redis.pipeline();
  for (const sessionId of sessionIds) {
    pipeline.set(sessionActiveRedisKey(sessionId), "0", "EX", ttlSeconds);
  }
  await pipeline.exec();
}

/**
 * `true` / `false` if known in cache; `null` if key missing (caller may check DB).
 */
export async function getActiveSessionFromCache(
  redis: Redis,
  sessionId: string
): Promise<boolean | null> {
  const value = await redis.get(sessionActiveRedisKey(sessionId));
  if (value === "1") return true;
  if (value === "0") return false;
  return null;
}
