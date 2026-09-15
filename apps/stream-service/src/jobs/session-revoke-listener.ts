import { logger } from "@aimess/logger";

import { isStreamCacheReady, redis } from "../config/redis.js";
import type { LivestreamService } from "../services/livestream.service.js";

/**
 * Ends the broadcast a session started when auth-service revokes that session.
 *
 * The publish credential (WHIP/RTMP secret) is tied to the stream, not to a
 * session, and a URL/YOUTUBE embed has no publisher at all — so a host whose
 * session was signed out kept broadcasting until someone stopped the stream by
 * hand. auth-service publishes `session-revoke:<userId>` `{sessionId, reason}`
 * on every single-session revoke (the gateway already listens for the socket
 * side); this is the media side.
 *
 * Returns a cleanup function that closes the subscriber.
 */
export async function startSessionRevokeListener(
  livestreamService: LivestreamService
): Promise<() => void> {
  if (!isStreamCacheReady()) {
    logger.warn(
      "Session revoke listener disabled — Redis unavailable; revoked hosts end via on_unpublish or stop only"
    );
    return () => {};
  }

  const sub = redis.duplicate();
  sub.on("error", (err: unknown) => {
    logger.warn(`Session revoke subscriber error: ${String(err)}`);
  });
  sub.on("pmessage", (_pattern: string, channel: string, message: string) => {
    const userId = channel.slice("session-revoke:".length);
    let sessionId: string | undefined;
    try {
      ({ sessionId } = JSON.parse(message) as { sessionId?: string });
    } catch {
      return;
    }
    if (!userId || !sessionId) return;
    void livestreamService
      .endStreamsOfRevokedSession(userId, sessionId)
      .catch((err: unknown) => {
        logger.warn(`Session revoke stream end failed: ${String(err)}`);
      });
  });

  await sub.connect();
  await sub.psubscribe("session-revoke:*");
  logger.info("Session revoke listener started");

  return () => {
    void sub.quit().catch(() => {});
  };
}
