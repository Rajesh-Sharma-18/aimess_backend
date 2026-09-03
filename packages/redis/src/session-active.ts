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

/**
 * Ready-made predicate for `createAuthenticateAccessToken`'s
 * `assertSessionActive` option, so a service wires revocation with one line
 * instead of hand-rolling the failure policy.
 *
 * This exists because three services — community, stream and media — never
 * consulted the revoked-session marker at all. `POST /auth/logout`, "sign this
 * device out", revoke-all and change-password all revoke the session row and
 * set this Redis key, but they cannot invalidate a JWT that has already been
 * issued. So after a user logged out or remotely killed a stolen device, that
 * exact access token kept working against every `/communities/*`, `/streams/*`
 * and `/media/*` endpoint until it expired on its own — reading and posting in
 * communities, starting livestreams, and minting presigned upload and download
 * URLs, for up to a full token lifetime.
 *
 * The truth table is deliberately identical to the per-service helpers that
 * were already in auth, user, chat and notifications, so wiring it changes no
 * behaviour beyond adding the check:
 *
 *   cache not ready → allow  (the service is running without a cache)
 *   `"1"`           → allow  (explicitly active)
 *   `"0"`           → DENY   (explicitly revoked)
 *   key missing     → allow  (legacy session, until its token expires)
 *   Redis throws    → allow  (a blip must not sign the platform out)
 *
 * `getRedis` is a thunk so a lazily-connected singleton is read at call time
 * rather than at module load, matching `createBannedUserGuard` next door.
 */
export function createSessionActiveGuard(
  getRedis: () => Redis,
  isReady: () => boolean = () => true
): (sessionId: string) => Promise<boolean> {
  return async (sessionId: string) => {
    if (!isReady()) return true;
    try {
      return (await getActiveSessionFromCache(getRedis(), sessionId)) !== false;
    } catch {
      return true;
    }
  };
}
