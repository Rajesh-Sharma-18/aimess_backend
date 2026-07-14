import { getActiveSessionFromCache } from "@aimess/redis";

import { redis } from "../config/redis.js";

/**
 * Same Redis keys as auth-service. Revoke writes `0`; active login writes `1`.
 * Missing key or Redis down: treat as active (legacy sessions / fail-open)
 * until the access token expires naturally.
 */
export async function isSessionActiveForRequest(
  sessionId: string
): Promise<boolean> {
  if (redis.status !== "ready") {
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
