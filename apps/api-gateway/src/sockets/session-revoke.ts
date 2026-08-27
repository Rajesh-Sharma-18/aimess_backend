import type { Server as SocketIOServer } from "socket.io";
import type { Redis } from "ioredis";
import { logger } from "@aimess/logger";
import { DEFAULT_LOCALE, t, type SupportedLocale } from "@aimess/constants";

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

        void ns
          .in(sessionRoom)
          .fetchSockets()
          .then((sockets) => {
            for (const socket of sockets) {
              // Emitted per socket rather than to the room, for the same reason
              // every other server-rendered sentence is: the sockets in here
              // may be a phone in Thai and a laptop in English, and one
              // pre-translated room broadcast would hand both the same
              // language. Same loop that was already fetching them to hang up,
              // so this costs no extra round trip.
              if (!selfInitiated) {
                const locale =
                  (socket.data.locale as SupportedLocale | undefined) ??
                  DEFAULT_LOCALE;
                socket.emit("auth:session_terminated", {
                  sessionId,
                  reason: "terminated",
                  message: t("SOCKET_SESSION_TERMINATED", locale),
                });
              }
              socket.disconnect(true);
            }
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

/**
 * Delivers a permanent Super Admin ban to every device of the banned user, and
 * then hangs them all up.
 *
 * Distinct from `registerSessionRevokeListener` above because a ban is
 * USER-scoped, not session-scoped: the revoke path can only address the one
 * `session:<sessionId>` room named in its payload, so telling every device
 * would mean publishing N messages and would still say nothing about WHY. Here
 * the target room is `user:<userId>`, which every namespace's socket joins at
 * connect, so one message reaches every device on every namespace.
 *
 * The two run in tandem on a ban: auth-service publishes here AND revokes each
 * session, so a client that misses one signal still gets the other. Emitting
 * `user:banned` before disconnecting is what lets the client tell a ban apart
 * from an ordinary session termination and stop trying to reconnect or refresh.
 *
 * `user:unbanned` is emit-only — there is nothing to disconnect, and the user
 * has no live socket anyway (their sessions were revoked when they were banned).
 * It exists so an admin panel or a second device can react without polling.
 */
export function registerUserBanListener(
  io: SocketIOServer,
  sessionRevokeSub: Redis
): void {
  sessionRevokeSub.on(
    "pmessage",
    (_pattern: string, channel: string, message: string) => {
      if (!channel.startsWith("user-ban:")) return;
      const userId = channel.replace("user-ban:", "");

      let event: string | undefined;
      let data: unknown;
      try {
        ({ event, data } = JSON.parse(message) as {
          event?: string;
          data?: unknown;
        });
      } catch (err) {
        logger.warn(`user-ban message parse error: ${String(err)}`);
        return;
      }
      if (event !== "user:banned" && event !== "user:unbanned") return;

      const userRoom = `user:${userId}`;

      for (const nsName of LIVE_NAMESPACES) {
        const ns = io.of(nsName);
        ns.to(userRoom).emit(event, data);

        if (event !== "user:banned") continue;

        // Disconnect AFTER the emit so the notice is on the wire first.
        // `fetchSockets()` is cross-node via the Redis adapter, so this reaches
        // the user's sockets on every gateway replica, not just this one.
        void ns
          .in(userRoom)
          .fetchSockets()
          .then((sockets) => {
            for (const socket of sockets) socket.disconnect(true);
          })
          .catch((err: unknown) =>
            logger.warn(
              `user-ban disconnect lookup failed on ${nsName}: ${String(err)}`
            )
          );
      }
    }
  );

  void sessionRevokeSub.psubscribe("user-ban:*");
}
