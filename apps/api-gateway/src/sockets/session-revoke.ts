import type { Server as SocketIOServer } from "socket.io";
import type { Redis } from "ioredis";
import { logger } from "@aimess/logger";

/** Every namespace a user's device might be connected to, all joined via `user:<userId>` + `session:<sessionId>`. */
const LIVE_NAMESPACES = ["/chat", "/community", "/notify", "/stream"] as const;

/**
 * Force-disconnects an already-connected socket the instant its session is
 * revoked (e.g. "Logout Device" — DELETE /auth/sessions/{sessionId}), instead
 * of waiting for its access token to naturally expire. Auth-service publishes
 * to `session-revoke:<userId>` (see `publishSessionRevokedEvent` in
 * `@aimess/redis`) on every single-session revoke; this PSUBSCRIBEs once
 * (durable — unlike `/notify`'s per-user conditional subscribe) so it reaches
 * a live socket even if that user never opened a `/notify` connection.
 *
 * Every namespace's socket also joins `session:<sessionId>` on connect (see
 * each namespace's `connection` handler) — that room is what lets us emit
 * `auth:session_terminated` to ONLY the terminated device before disconnecting
 * it, and `session:list_updated` to every OTHER device (`user:<userId>` room)
 * so linked-device lists refresh without polling.
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
        const ns = io.of(nsName);
        const sessionRoom = `session:${sessionId}`;

        ns.to(sessionRoom).emit("auth:session_terminated", {
          sessionId,
          reason: "terminated",
          message: "Your session has been terminated.",
        });

        void ns
          .in(sessionRoom)
          .fetchSockets()
          .then((sockets) => {
            for (const socket of sockets) socket.disconnect(true);
          })
          .catch((err: unknown) =>
            logger.warn(
              `session-revoke disconnect lookup failed on ${nsName}: ${String(err)}`
            )
          );

        ns.to(`user:${userId}`).emit("session:list_updated", {
          action: "terminated",
          sessionId,
        });
      }
    }
  );

  void sessionRevokeSub.psubscribe("session-revoke:*");
}
