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
const FileAttachmentSchema = z.object({
  objectKey: z.string().min(1).max(500).optional(),
  url: z.string().min(1).max(3000).optional(),
  name: z.string().max(255).default(""),
  size: z.number().nonnegative().default(0),
  mime: z.string().max(150).default(""),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  durationMs: z.number().nonnegative().optional(),
});
const LocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  placeName: z.string().max(200).optional(),
  placeAddress: z.string().max(500).optional(),
});
const ContactSchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().min(1).max(50),
  avatar: z.string().max(3000).optional(),
  userId: z.string().max(100).optional(),
});
const MessageSendSchema = z.object({
  conversationId: z.string().min(1),
  clientMessageId: z.string().min(1),
  contentType: z.string().min(1),
  contentText: z.string().optional(),
  mediaKey: z.string().optional(),
  files: z.array(FileAttachmentSchema).optional(),
  urls: z.array(z.string().url()).optional(),
  location: LocationSchema.optional(),
  contact: ContactSchema.optional(),
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
  conversationType: z.preprocess(
    (value) =>
      typeof value === "string" ? value.toString().toLowerCase() : value,
    z.enum(["private", "group"]).default("private")
  ),
});

// ─── Redis pub/sub message shape published by messaging-service ──────────────
interface RedisSocketEvent {
  event: string;
  data: unknown;
}

type SocketAck = ((res: unknown) => void) | undefined;

function ack(callback: SocketAck, response: unknown): void {
  if (typeof callback === "function") {
    callback(response);
  }
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
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessageSendSchema.safeParse(payload);
        if (!r.success) {
          ack(callback, { success: false, error: "INVALID_PAYLOAD" });
          return;
        }
        const files = [...(r.data.files ?? [])];
        if (r.data.mediaKey && !files.some((f) => f.objectKey)) {
          files.push({
            objectKey: r.data.mediaKey,
            name: "",
            size: 0,
            mime: "",
          });
        }
        const content = {
          text: r.data.contentText ?? "",
          urls: r.data.urls ?? [],
          files,
          ...(r.data.location ? { location: r.data.location } : {}),
          ...(r.data.contact ? { contact: r.data.contact } : {}),
        };
        messagingClient
          .sendMessage({
            ...r.data,
            senderId: userId,
            contentJson: JSON.stringify(content),
            conversationType: r.data.conversationType,
            receiverId: r.data.receiverId ?? "",
            senderName: r.data.senderName ?? "",
            senderAvatar: r.data.senderAvatar ?? "",
          })
          .then((result) => ack(callback, { success: true, data: result }))
          .catch((err: unknown) => {
            logger.warn(`/chat message:send gRPC error: ${String(err)}`);
            ack(callback, { success: false, error: "SERVICE_ERROR" });
          });
      }
    );

    socket.on(
      "message:read",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessageReadSchema.safeParse(payload);
        if (!r.success) {
          ack(callback, { success: false, error: "INVALID_PAYLOAD" });
          return;
        }
        messagingClient
          .markMessagesRead({ ...r.data, readerId: userId })
          .then((result) => ack(callback, { success: true, data: result }))
          .catch((err: unknown) => {
            logger.warn(`/chat message:read gRPC error: ${String(err)}`);
            ack(callback, { success: false, error: "SERVICE_ERROR" });
          });
      }
    );

    socket.on(
      "message:react",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessageReactSchema.safeParse(payload);
        if (!r.success) {
          ack(callback, { success: false, error: "INVALID_PAYLOAD" });
          return;
        }
        messagingClient
          .sendReaction({ ...r.data, userId })
          .then((result) => ack(callback, { success: true, data: result }))
          .catch((err: unknown) => {
            logger.warn(`/chat message:react gRPC error: ${String(err)}`);
            ack(callback, { success: false, error: "SERVICE_ERROR" });
          });
      }
    );

    socket.on(
      "messages:fetch",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessagesFetchSchema.safeParse(payload);
        if (!r.success) {
          ack(callback, { success: false, error: "INVALID_PAYLOAD" });
          return;
        }
        messagingClient
          .getConversationMessages({ ...r.data, requesterId: userId })
          .then((result) => ack(callback, { success: true, data: result }))
          .catch((err: unknown) => {
            logger.warn(`/chat messages:fetch gRPC error: ${String(err)}`);
            ack(callback, { success: false, error: "SERVICE_ERROR" });
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
