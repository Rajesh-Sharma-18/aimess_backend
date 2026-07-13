import type { Server as SocketIOServer } from "socket.io";
import type { Redis } from "ioredis";
import { logger } from "@aimess/logger";

/** Every namespace a user's device might be connected to, all joined via `user:<userId>`. */
const LIVE_NAMESPACES = ["/chat", "/community", "/notify", "/stream"] as const;

/**
 * Force-disconnects an already-connected socket the instant its session is
 * revoked (e.g. "Logout Device" — DELETE /auth/sessions/{sessionId}), instead
 * of waiting for its access token to naturally expire. Auth-service publishes
 * to `session-revoke:<userId>` (see `publishSessionRevokedEvent` in
 * `@aimess/redis`) on every single-session revoke; this PSUBSCRIBEs once
 * (durable — unlike `/notify`'s per-user conditional subscribe) so it reaches
 * a live socket even if that user never opened a `/notify` connection.
 */
export function registerSessionRevokeListener(
  io: SocketIOServer,
  sessionRevokeSub: Redis
): void {
  sessionRevokeSub.on(
    "pmessage",
    (_pattern: string, channel: string, message: string) => {
      if (!channel.startsWith("session-revoke:")) return;
      const userId = channel.replace("session-revoke:", "");

      let sessionId: string | undefined;
      try {
        ({ sessionId } = JSON.parse(message) as { sessionId?: string });
      } catch (err) {
        logger.warn(`session-revoke message parse error: ${String(err)}`);
        return;
      }
      if (!sessionId) return;

      for (const nsName of LIVE_NAMESPACES) {
        void io
          .of(nsName)
          .in(`user:${userId}`)
          .fetchSockets()
          .then((sockets) => {
            for (const socket of sockets) {
              if (socket.data.sessionId === sessionId) {
                socket.disconnect(true);
              }
            }
          })
          .catch((err: unknown) =>
            logger.warn(
              `session-revoke disconnect lookup failed on ${nsName}: ${String(err)}`
            )
          );
      }
    }
  );

  void sessionRevokeSub.psubscribe("session-revoke:*");
}
