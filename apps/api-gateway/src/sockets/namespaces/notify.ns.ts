import type { Server as SocketIOServer, Namespace, Socket } from "socket.io";
import type { Redis } from "ioredis";
import { z } from "zod";
import { logger } from "@aimess/logger";
import { createGatewaySocketAuthMiddleware } from "../auth.middleware.js";
import { ackOk, ackError } from "../ack.js";
import { emitPersonalizedSender } from "../emit-personalized.js";
import type { NotificationClient } from "../../grpc/clients/notification.client.js";

const NotificationsFetchSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});
const MarkReadSchema = z.object({
  // Empty array = mark ALL unread as read. Bounded so a single call can't ship
  // an unbounded id list.
  notificationIds: z.array(z.string().min(1)).max(500),
});
const DeleteSchema = z.object({
  notificationId: z.string().min(1),
});

interface RedisSocketEvent {
  event: string;
  data: unknown;
}

export function registerNotifyNamespace(
  io: SocketIOServer,
  notificationClient: NotificationClient,
  redisSub: Redis,
  redisPub: Redis
): void {
  const notify: Namespace = io.of("/notify");
  notify.use(createGatewaySocketAuthMiddleware(redisPub));

  // Per-user channel subscription tracking
  const userSubCount = new Map<string, number>();

  redisSub.on("message", (channel: string, message: string) => {
    // channel = "notify:<userId>"
    if (!channel.startsWith("notify:")) return;
    try {
      const parsed = JSON.parse(message) as RedisSocketEvent;
      void emitPersonalizedSender(
        notify,
        channel.replace("notify:", "user:"),
        parsed.event,
        parsed.data
      );
    } catch (err) {
      logger.warn(
        `/notify Redis message parse error on ${channel}: ${String(err)}`
      );
    }
  });

  notify.on("connection", (socket: Socket) => {
    const { userId, sessionId, locale } = socket.data;
    void socket.join(`user:${userId}`);
    void socket.join(`session:${sessionId}`);
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
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        notificationClient
          .getNotifications({ userId, ...r.data })
          .then((result) =>
            ackOk(callback, "SOCKET_NOTIFICATIONS_FETCHED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(
              `/notify notifications:fetch gRPC error: ${String(err)}`
            );
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    socket.on(
      "notifications:mark_read",
      (payload: unknown, callback: (res: unknown) => void) => {
        const r = MarkReadSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        notificationClient
          .markNotificationsRead({
            userId,
            notificationIds: r.data.notificationIds,
          })
          .then((result) => {
            ackOk(callback, "SOCKET_NOTIFICATIONS_MARKED_READ", locale, result);
            // Gap #5: push the updated unread count to ALL devices for this user
            // immediately after a read action — notifications-service publishes
            // count_update for NEW notifications; read-side changes need this
            // gateway-side push so multi-device count stays in sync.
            notificationClient
              .getNotifications({ userId, limit: 1, cursor: "" })
              .then((res) =>
                notify
                  .to(`user:${userId}`)
                  .emit("notification:count_update", { count: res.unreadCount })
              )
              .catch((err: unknown) =>
                logger.warn(
                  `/notify count_update after mark_read failed: ${String(err)}`
                )
              );
          })
          .catch((err: unknown) => {
            logger.warn(
              `/notify notifications:mark_read gRPC error: ${String(err)}`
            );
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    socket.on(
      "notifications:delete",
      (payload: unknown, callback: (res: unknown) => void) => {
        const r = DeleteSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        notificationClient
          .deleteNotification({
            userId,
            notificationId: r.data.notificationId,
          })
          .then((result) => {
            ackOk(callback, "SOCKET_NOTIFICATIONS_DELETED", locale, result);
            // Push the recomputed unread count to ALL devices for this user so
            // multi-device badges stay in sync after a delete (mirrors the
            // mark_read fanout). The deleteNotification gRPC already recomputed
            // remainingUnread, so reuse it instead of a second round-trip.
            notify.to(`user:${userId}`).emit("notification:count_update", {
              count: result.remainingUnread,
            });
          })
          .catch((err: unknown) => {
            logger.warn(
              `/notify notifications:delete gRPC error: ${String(err)}`
            );
            ackError(callback, "SERVICE_ERROR", locale);
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
