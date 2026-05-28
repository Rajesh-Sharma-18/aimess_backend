import { getActiveSessionFromCache } from "@aimess/redis";

import { isUserCacheReady, redis } from "../config/redis.js";

/**
 * Same Redis keys as auth-service. Revoke writes `0`; active login writes `1`.
 * Missing key: treat as active (legacy sessions) until access token expires.
 */
export async function isSessionActiveForRequest(
  sessionId: string
): Promise<boolean> {
  if (!isUserCacheReady()) {
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
