import type { Server as SocketIOServer } from "socket.io";
import type { Redis } from "ioredis";
import { logger } from "@aimess/logger";

/** Every namespace a user's device might be connected to, all joined via `user:<userId>` + `session:<sessionId>`. */
export const LIVE_NAMESPACES = [
  "/chat",
  "/community",
  "/notify",
  "/stream",
] as const;

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
 * it. `session:list_updated` (every OTHER device, `user:<userId>` room) is
 * emitted only on `/notify` — that's the only namespace the client listens on
 * for session/device-list sync.
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
      let reason: string | undefined;
      try {
        ({ sessionId, reason } = JSON.parse(message) as {
          sessionId?: string;
          reason?: string;
        });
      } catch (err) {
        logger.warn(`session-revoke message parse error: ${String(err)}`);
        return;
      }
      if (!sessionId) return;

      // A user signing out on this very device already knows — telling it its
      // session was "terminated" is the remote-revoke notice and must not fire
      // here. Account deletion is the same, but stronger: the flow is specified
      // to be completely silent, so NONE of that user's devices may be told
      // anything (no notice, and no linked-device list churn for an account
      // that no longer exists). Both still get force-disconnected below.
      const selfInitiated = reason === "logout" || reason === "account_deleted";
      const silent = reason === "account_deleted";

      for (const nsName of LIVE_NAMESPACES) {
        const ns = io.of(nsName);
        const sessionRoom = `session:${sessionId}`;

        if (!selfInitiated) {
          ns.to(sessionRoom).emit("auth:session_terminated", {
            sessionId,
            reason: "terminated",
            message: "Your session has been terminated.",
          });
        }

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
      }

      if (!silent) {
        io.of("/notify").to(`user:${userId}`).emit("session:list_updated", {
          action: "terminated",
          sessionId,
        });
      }
    }
  );

  void sessionRevokeSub.psubscribe("session-revoke:*");
}
