import type { Server as SocketIOServer, Namespace, Socket } from "socket.io";
import type { Redis } from "ioredis";
import { z } from "zod";
import { logger } from "@aimess/logger";
import { gatewaySocketAuthMiddleware } from "../auth.middleware.js";
import type { MessagingClient } from "../../grpc/clients/messaging.client.js";

// ─── Inbound payload schemas ────────────────────────────────────────────────
const ConvJoinSchema = z.object({ conversationId: z.string().min(1) });
const ConvLeaveSchema = z.object({ conversationId: z.string().min(1) });
const TypingSchema = z.object({
  conversationId: z.string().min(1),
});
const MessageSendSchema = z.object({
  conversationId: z.string().min(1),
  clientMessageId: z.string().min(1),
  contentType: z.string().min(1),
  contentText: z.string().optional(),
  mediaKey: z.string().optional(),
  repliedToId: z.string().optional(),
  conversationType: z.preprocess(
    (value) =>
      typeof value === "string" ? value.toString().toLowerCase() : value,
    z.enum(["private", "group"]).default("private")
  ),
  receiverId: z.string().optional(),
  senderName: z.string().optional(),
  senderAvatar: z.string().optional(),
});
const MessageReadSchema = z.object({
  conversationId: z.string().min(1),
  upToMessageId: z.string().min(1),
});
const MessageReactSchema = z.object({
  messageId: z.string().min(1),
  conversationId: z.string().min(1),
  emoji: z.string(),
});
const MessagesFetchSchema = z.object({
  conversationId: z.string().min(1),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

// ─── Redis pub/sub message shape published by messaging-service ──────────────
interface RedisSocketEvent {
  event: string;
  data: unknown;
}

export function registerChatNamespace(
  io: SocketIOServer,
  messagingClient: MessagingClient,
  redisSub: Redis
): void {
  const chat: Namespace = io.of("/chat");
  chat.use(gatewaySocketAuthMiddleware);

  // Dedicated subscriber for conversation channels.
  // Backend services publish: { event: "message:new"|"message:edited"|"message:reaction"|"message:read", data: {...} }
  // to Redis channel conv:<conversationId>.
  void redisSub.psubscribe("conv:*");
  redisSub.on(
    "pmessage",
    (pattern: string, channel: string, message: string) => {
      if (pattern !== "conv:*") return;
      try {
        const parsed = JSON.parse(message) as RedisSocketEvent;
        chat.to(channel).emit(parsed.event, parsed.data);
      } catch (err) {
        logger.warn(
          `/chat Redis message parse error on ${channel}: ${String(err)}`
        );
      }
    }
  );

  chat.on("connection", (socket: Socket) => {
    const { userId } = socket.data;
    void socket.join(`user:${userId}`);
    logger.debug(`/chat connected userId=${userId}`);

    socket.on("conv:join", (payload: unknown) => {
      const r = ConvJoinSchema.safeParse(payload);
      if (!r.success) return;
      void socket.join(`conv:${r.data.conversationId}`);
    });

    socket.on("conv:leave", (payload: unknown) => {
      const r = ConvLeaveSchema.safeParse(payload);
      if (!r.success) return;
      void socket.leave(`conv:${r.data.conversationId}`);
    });

    socket.on(
      "message:send",
      (payload: unknown, callback: (res: unknown) => void) => {
        const r = MessageSendSchema.safeParse(payload);
        if (!r.success) {
          callback({ success: false, error: "INVALID_PAYLOAD" });
          return;
        }
        messagingClient
          .sendMessage({
            ...r.data,
            senderId: userId,
            conversationType: r.data.conversationType,
            receiverId: r.data.receiverId ?? "",
            senderName: r.data.senderName ?? "",
            senderAvatar: r.data.senderAvatar ?? "",
          })
          .then((result) => callback({ success: true, data: result }))
          .catch((err: unknown) => {
            logger.warn(`/chat message:send gRPC error: ${String(err)}`);
            callback({ success: false, error: "SERVICE_ERROR" });
          });
      }
    );

    socket.on(
      "message:read",
      (payload: unknown, callback: (res: unknown) => void) => {
        const r = MessageReadSchema.safeParse(payload);
        if (!r.success) {
          callback({ success: false, error: "INVALID_PAYLOAD" });
          return;
        }
        messagingClient
          .markMessagesRead({ ...r.data, readerId: userId })
          .then((result) => callback({ success: true, data: result }))
          .catch((err: unknown) => {
            logger.warn(`/chat message:read gRPC error: ${String(err)}`);
            callback({ success: false, error: "SERVICE_ERROR" });
          });
      }
    );

    socket.on(
      "message:react",
      (payload: unknown, callback: (res: unknown) => void) => {
        const r = MessageReactSchema.safeParse(payload);
        if (!r.success) {
          callback({ success: false, error: "INVALID_PAYLOAD" });
          return;
        }
        messagingClient
          .sendReaction({ ...r.data, userId })
          .then((result) => callback({ success: true, data: result }))
          .catch((err: unknown) => {
            logger.warn(`/chat message:react gRPC error: ${String(err)}`);
            callback({ success: false, error: "SERVICE_ERROR" });
          });
      }
    );

    socket.on(
      "messages:fetch",
      (payload: unknown, callback: (res: unknown) => void) => {
        const r = MessagesFetchSchema.safeParse(payload);
        if (!r.success) {
          callback({ success: false, error: "INVALID_PAYLOAD" });
          return;
        }
        messagingClient
          .getConversationMessages({ ...r.data, requesterId: userId })
          .then((result) => callback({ success: true, data: result }))
          .catch((err: unknown) => {
            logger.warn(`/chat messages:fetch gRPC error: ${String(err)}`);
            callback({ success: false, error: "SERVICE_ERROR" });
          });
      }
    );

    socket.on("typing:start", (payload: unknown) => {
      const r = TypingSchema.safeParse(payload);
      if (!r.success) return;
      chat.to(`conv:${r.data.conversationId}`).emit("typing:start", {
        userId,
        conversationId: r.data.conversationId,
      });
    });

    socket.on("typing:stop", (payload: unknown) => {
      const r = TypingSchema.safeParse(payload);
      if (!r.success) return;
      chat.to(`conv:${r.data.conversationId}`).emit("typing:stop", {
        userId,
        conversationId: r.data.conversationId,
      });
    });

    socket.on("disconnect", (reason: string) => {
      logger.debug(`/chat disconnected userId=${userId} reason=${reason}`);
    });
  });
}
