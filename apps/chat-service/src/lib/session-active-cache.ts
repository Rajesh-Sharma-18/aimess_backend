import type { Redis } from "ioredis";
import { getActiveSessionFromCache } from "@aimess/redis";

import { isChatCacheReady, redis } from "../config/redis.js";

/**
 * Same Redis keys as auth-service. Revoke writes `0`; active login writes `1`.
 * Missing key: treat as active (legacy sessions) until access token expires.
 */
export async function isSessionActiveForRequest(
  sessionId: string
): Promise<boolean> {
  if (!isChatCacheReady()) {
    return true;
  }

  try {
    const cached = await getActiveSessionFromCache(redis as Redis, sessionId);
    if (cached === true) return true;
    if (cached === false) return false;
  } catch {
    return true;
  }

  return true;
}
