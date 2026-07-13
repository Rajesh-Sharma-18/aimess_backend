import type { Server as SocketIOServer, Namespace, Socket } from "socket.io";
import type { Redis } from "ioredis";
import { z } from "zod";
import { logger } from "@aimess/logger";

const QrSubscribeSchema = z.object({
  token: z.string().trim().min(1).max(200),
});

interface RedisSocketEvent {
  event: string;
  data: unknown;
}

/**
 * Public `/auth` namespace for the QR-login (linked devices) flow — no JWT,
 * since the browser scanning the QR isn't signed in yet. The only thing a
 * client can do here is join the room for a token it already displays as a
 * QR code; nothing enumerable, nothing privileged lives in the join itself.
 * auth-service publishes `devlink:<linkToken>` on Redis (see
 * `publishQrLinkEvent` in `@aimess/redis`) on every scan/approve/reject/expire
 * — this namespace relays that verbatim to room `qr:<linkToken>`.
 */
export function registerAuthNamespace(
  io: SocketIOServer,
  redisSub: Redis
): void {
  const auth: Namespace = io.of("/auth");

  redisSub.on("message", (channel: string, message: string) => {
    if (!channel.startsWith("devlink:")) return;
    try {
      const parsed = JSON.parse(message) as RedisSocketEvent;
      auth
        .to(channel.replace("devlink:", "qr:"))
        .emit(parsed.event, parsed.data);
    } catch (err) {
      logger.warn(
        `/auth Redis message parse error on ${channel}: ${String(err)}`
      );
    }
  });

  auth.on("connection", (socket: Socket) => {
    let joinedToken: string | null = null;

    socket.on("auth:qr:subscribe", (payload: unknown) => {
      const parsed = QrSubscribeSchema.safeParse(payload);
      if (!parsed.success) return;

      if (joinedToken) void socket.leave(`qr:${joinedToken}`);
      joinedToken = parsed.data.token;
      void socket.join(`qr:${joinedToken}`);
      // ponytail: no ref-counting (unlike /notify's per-user subscribe) — each
      // linkToken is single-use and only the one browser that generated the QR
      // knows it, so a plain subscribe/unsubscribe per socket is sufficient.
      void redisSub.subscribe(`devlink:${joinedToken}`);
      logger.debug(`/auth socket subscribed to qr:${joinedToken}`);
    });

    socket.on("disconnect", () => {
      if (joinedToken) void redisSub.unsubscribe(`devlink:${joinedToken}`);
    });
  });
}
