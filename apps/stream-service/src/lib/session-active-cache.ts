import { getActiveSessionFromCache } from "@aimess/redis";

import { isStreamCacheReady, redis } from "../config/redis.js";

/**
 * Same Redis keys as auth-service. Revoke writes `0`; active login writes `1`.
 * Missing key: treat as active (legacy sessions) until access token expires.
 *
 * Without this check a JWT stays valid here for its full lifetime
 * (JWT_ACCESS_EXPIRES_IN, 1h) after the user logs out, remotely signs a device
 * out, revokes all sessions, or changes their password — none of which can
 * invalidate an already-signed token, they only write this marker. A stolen
 * token would keep starting and joining livestreams, commenting, and moderating
 * long after the victim believed they had killed the session.
 *
 * Fail-open on a Redis error, matching auth-service / user-service: a cache
 * blip must not sign the whole platform out.
 */
export async function isSessionActiveForRequest(
  sessionId: string
): Promise<boolean> {
  if (!isStreamCacheReady()) {
    return true;
  }

  try {
    const cached = await getActiveSessionFromCache(redis, sessionId);
    if (cached === true) return true;
    if (cached === false) return false;
  } catch {
    return true;
  }

  return true;
}
