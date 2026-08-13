import type { Server as SocketIOServer, Namespace, Socket } from "socket.io";
import type { Redis } from "ioredis";
import { logger } from "@aimess/logger";
import { createGatewayAdminSocketAuthMiddleware } from "../auth.middleware.js";

interface RedisSocketEvent {
  event: string;
  data: unknown;
}

/** Published by backoffice-service when an admin account is deactivated. */
const ADMIN_SESSION_REVOKED = "admin:session:revoked";

/**
 * Backoffice admin-panel namespace. Carries account-level pushes for the signed-in
 * admin — `admin:permissions:updated` (a grant/revoke by a Platform Admin lands on
 * the target's open panel instead of waiting for a re-login) and
 * `admin:session:revoked` (account deactivated).
 *
 * One durable PSUBSCRIBE on `admin:*` (a permission edit is rare — per-admin
 * ref-counted subscribes like /notify's would be bookkeeping for nothing), and
 * every socket joins the room named after its own channel, so a message only
 * reaches the admin it is about.
 */
export function registerAdminNamespace(
  io: SocketIOServer,
  redisSub: Redis,
  redisPub: Redis
): void {
  const admin: Namespace = io.of("/admin");
  admin.use(createGatewayAdminSocketAuthMiddleware(redisPub));

  redisSub.on(
    "pmessage",
    (_pattern: string, channel: string, message: string) => {
      // channel = "admin:<adminId>" = the room name
      if (!channel.startsWith("admin:")) return;
      try {
        const parsed = JSON.parse(message) as RedisSocketEvent;
        admin.to(channel).emit(parsed.event, parsed.data);

        // The account is gone — the client logs itself out on this event, but the
        // handshake that authorized this socket is now stale, so drop it here too.
        if (parsed.event === ADMIN_SESSION_REVOKED) {
          void admin
            .in(channel)
            .fetchSockets()
            .then((sockets) => {
              for (const socket of sockets) socket.disconnect(true);
            })
            .catch((err: unknown) =>
              logger.warn(`/admin revoke disconnect failed: ${String(err)}`)
            );
        }
      } catch (err) {
        logger.warn(
          `/admin Redis message parse error on ${channel}: ${String(err)}`
        );
      }
    }
  );

  void redisSub.psubscribe("admin:*");

  admin.on("connection", (socket: Socket) => {
    const { adminId } = socket.data;
    void socket.join(`admin:${adminId}`);
    logger.debug(`/admin connected adminId=${String(adminId)}`);

    socket.on("disconnect", (reason: string) => {
      logger.debug(
        `/admin disconnected adminId=${String(adminId)} reason=${reason}`
      );
    });
  });
}
