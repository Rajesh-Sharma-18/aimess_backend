import type { Server as SocketIOServer, Namespace, Socket } from "socket.io";
import type { Redis } from "ioredis";
import { z } from "zod";
import { logger } from "@aimess/logger";
import { gatewaySocketAuthMiddleware } from "../auth.middleware.js";
import type { NotificationClient } from "../../grpc/clients/notification.client.js";

const NotificationsFetchSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});
const MarkReadSchema = z.object({
  notificationIds: z.array(z.string()).min(0),
});

interface RedisSocketEvent {
  event: string;
  data: unknown;
}

export function registerNotifyNamespace(
  io: SocketIOServer,
  notificationClient: NotificationClient,
  redisSub: Redis
): void {
  const notify: Namespace = io.of("/notify");
  notify.use(gatewaySocketAuthMiddleware);

  // Per-user channel subscription tracking
  const userSubCount = new Map<string, number>();

  redisSub.on("message", (channel: string, message: string) => {
    // channel = "notify:<userId>"
    if (!channel.startsWith("notify:")) return;
    try {
      const parsed = JSON.parse(message) as RedisSocketEvent;
      notify
        .to(channel.replace("notify:", "user:"))
        .emit(parsed.event, parsed.data);
    } catch (err) {
      logger.warn(
        `/notify Redis message parse error on ${channel}: ${String(err)}`
      );
    }
  });

  notify.on("connection", (socket: Socket) => {
    const { userId } = socket.data;
    void socket.join(`user:${userId}`);
    logger.debug(`/notify connected userId=${userId}`);

    // Subscribe this user's notification channel (ref-counted for multi-socket)
    const count = (userSubCount.get(userId) ?? 0) + 1;
    userSubCount.set(userId, count);
    if (count === 1) {
      void redisSub.subscribe(`notify:${userId}`);
    }

    // Emit unread count immediately on connect
    notificationClient
      .getNotifications({ userId, limit: 1, cursor: "" })
      .then((res) =>
        socket.emit("notification:count", { count: res.unreadCount })
      )
      .catch((err: unknown) =>
        logger.warn(
          `/notify connect fetch failed userId=${userId}: ${String(err)}`
        )
      );

    socket.on(
      "notifications:fetch",
      (payload: unknown, callback: (res: unknown) => void) => {
        const r = NotificationsFetchSchema.safeParse(payload ?? {});
        if (!r.success) {
          callback({ success: false, error: "INVALID_PAYLOAD" });
          return;
        }
        notificationClient
          .getNotifications({ userId, ...r.data })
          .then((result) => callback({ success: true, data: result }))
          .catch((err: unknown) => {
            logger.warn(
              `/notify notifications:fetch gRPC error: ${String(err)}`
            );
            callback({ success: false, error: "SERVICE_ERROR" });
          });
      }
    );

    socket.on(
      "notifications:mark_read",
      (payload: unknown, callback: (res: unknown) => void) => {
        const r = MarkReadSchema.safeParse(payload);
        if (!r.success) {
          callback({ success: false, error: "INVALID_PAYLOAD" });
          return;
        }
        notificationClient
          .markNotificationsRead({
            userId,
            notificationIds: r.data.notificationIds,
          })
          .then((result) => callback({ success: true, data: result }))
          .catch((err: unknown) => {
            logger.warn(
              `/notify notifications:mark_read gRPC error: ${String(err)}`
            );
            callback({ success: false, error: "SERVICE_ERROR" });
          });
      }
    );

    socket.on("disconnect", (reason: string) => {
      logger.debug(`/notify disconnected userId=${userId} reason=${reason}`);
      const remaining = (userSubCount.get(userId) ?? 1) - 1;
      if (remaining <= 0) {
        userSubCount.delete(userId);
        void redisSub.unsubscribe(`notify:${userId}`);
      } else {
        userSubCount.set(userId, remaining);
      }
    });
  });
}
