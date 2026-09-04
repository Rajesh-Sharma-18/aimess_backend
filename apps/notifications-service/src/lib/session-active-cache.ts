import { logger } from "@aimess/logger";
import { getActiveSessionFromCache } from "@aimess/redis";

import { redis } from "../config/redis.js";
import { createAuthSessionClient } from "../grpc/auth-session.client.js";

const authSessionClient = createAuthSessionClient();

/**
 * Same Redis keys as auth-service. Revoke writes `0`; active login writes `1`.
 *
 * A MISS is not "active". The marker is written at login and re-armed on every
 * refresh with the refresh-token TTL (7 days), so a session that stopped
 * refreshing — the app was signed out locally, its keychain was wiped, the
 * refresh token simply expired — loses its key while its device-token row lives
 * on for up to the 60-day sweeper TTL. Treating that miss as "active" is what
 * let a signed-out phone keep ringing: `pushToUser` prunes on `false` only.
 *
 * So on a miss we ask auth-service, which owns the Session row. Only when the
 * oracle itself is unreachable (Redis down, gRPC error/breaker open) do we fail
 * open — a push that should not have been sent is noise, a ring that never
 * arrives is a missed call.
 */
export async function isSessionActiveForRequest(
  sessionId: string
): Promise<boolean> {
  if (redis.status === "ready") {
    try {
      const cached = await getActiveSessionFromCache(redis, sessionId);
      if (cached === true) return true;
      if (cached === false) return false;
    } catch {
      // Fall through to the authoritative check.
    }
  }

  try {
    return await authSessionClient.isSessionActive(sessionId);
  } catch (error) {
    logger.warn(
      `[push:deliver] session liveness unknown for ${sessionId}, allowing: ${String(error)}`
    );
    return true;
  }
}
