import type { Server as SocketIOServer, Namespace, Socket } from "socket.io";
import type { Redis } from "ioredis";
import { z } from "zod";
import { logger } from "@aimess/logger";
import { gatewaySocketAuthMiddleware } from "../auth.middleware.js";
import { ackOk, ackError } from "../ack.js";
import type { MessagingClient } from "../../grpc/clients/messaging.client.js";

// §3: bound free-text + array fields so a naive or abusive client cannot exceed
// the 1 MB socket frame, blow up storage, or fan an oversized payload out to a
// whole room. These are coarse gateway guards; chat-service enforces the
// authoritative per-attachment media limits.
const MAX_TEXT_LEN = 4000; // message body / caption (matches chat-service CHAT_TEXT_MAX_CHARS)
const MAX_JSON_LEN = 16384; // pre-encoded contentJson on edits
const MAX_FILES = 30; // attachments per message (gallery)
const MAX_URLS = 20; // link previews per message
const MAX_EMOJI_LEN = 32; // one emoji grapheme incl. ZWJ/skin-tone sequences
const MAX_NAME_LEN = 120; // denormalized senderName fanned out to the room
const MAX_URL_LEN = 3000; // a single URL / objectKey / avatar

// ─── Inbound payload schemas ────────────────────────────────────────────────
const ConvJoinSchema = z.object({ conversationId: z.string().min(1) });
const ConvLeaveSchema = z.object({ conversationId: z.string().min(1) });
const TypingSchema = z.object({
  conversationId: z.string().min(1),
  // V2 §2.8: client supplies its own display name so recipients can show
  // "Alice is typing…" without an extra profile fetch.
  senderName: z.string().max(100).optional(),
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
  // §3.5: instant-preview metadata — blurhash (image/video) renders the bubble
  // at the right aspect ratio before download; waveform (voice) paints the bars.
  blurhash: z.string().max(120).optional(),
  waveform: z.array(z.number()).max(2048).optional(),
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
  clientMessageId: z.string().optional(),
  contentType: z
    .string()
    .min(1)
    .transform((v) => v.toUpperCase()),
  contentText: z.string().max(MAX_TEXT_LEN).optional(),
  // Deprecated single object-key shorthand — prefer files[] (a single file is an
  // array of one). Kept for back-compat; the gateway folds it into files[].
  mediaKey: z.string().max(MAX_URL_LEN).optional(),
  files: z.array(FileAttachmentSchema).max(MAX_FILES).optional(),
  urls: z.array(z.string().url().max(MAX_URL_LEN)).max(MAX_URLS).optional(),
  location: LocationSchema.optional(),
  contact: ContactSchema.optional(),
  repliedToId: z.string().optional(),
  conversationType: z.preprocess(
    (value) =>
      typeof value === "string" ? value.toString().toLowerCase() : value,
    z.enum(["private", "group"]).default("private")
  ),
  receiverId: z.string().optional(),
  senderName: z.string().max(MAX_NAME_LEN).optional(),
  senderAvatar: z.string().max(MAX_URL_LEN).optional(),
  // §5.1: client compose time (epoch ms) — display only, never overwrites serverTs.
  clientTs: z.number().int().nonnegative().optional(),
});
const MessageReadSchema = z.object({
  conversationId: z.string().min(1),
  upToMessageId: z.string().min(1),
});
const MessageReactSchema = z.object({
  messageId: z.string().min(1),
  conversationId: z.string().min(1),
  // §3: a single emoji grapheme — bounded length (handles multi-codepoint ZWJ
  // and skin-tone sequences) but rejects pasted text used as a "reaction".
  emoji: z.string().min(1).max(MAX_EMOJI_LEN),
  // §2.4: route group reactions to the group collection (default private).
  conversationType: z.preprocess(
    (v) => (typeof v === "string" ? v.toLowerCase() : v),
    z.enum(["private", "group"]).default("private")
  ),
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

const CatchupSchema = z.object({
  rooms: z
    .array(
      z.object({
        roomId: z.string().min(1),
        sinceSeq: z.number().int().nonnegative().default(0),
        conversationType: z.preprocess(
          (v) => (typeof v === "string" ? v.toLowerCase() : v),
          z.enum(["private", "group"]).default("private")
        ),
        limit: z.number().int().positive().max(200).optional(),
      })
    )
    .min(1)
    .max(50),
});

// ─── Redis pub/sub message shape published by messaging-service ──────────────
interface RedisSocketEvent {
  event: string;
  data: unknown;
}

export function registerChatNamespace(
  io: SocketIOServer,
  messagingClient: MessagingClient,
  redisSub: Redis,
  redisPub: Redis
): void {
  const chat: Namespace = io.of("/chat");
  chat.use(gatewaySocketAuthMiddleware);

  // Dedicated subscriber for conversation, call, and user channels.
  // Backend services publish: { event: "message:new"|"message:edited"|..., data: {...} }
  // to the matching Redis channel. V2 events (pin:updated, read_sync) ride the
  // existing conv:* / user:* channels — no new subscription needed.
  void redisSub.psubscribe("conv:*");
  void redisSub.psubscribe("call:*");
  void redisSub.psubscribe("user:*");
  redisSub.on(
    "pmessage",
    (pattern: string, channel: string, message: string) => {
      const allowedPatterns = ["conv:*", "call:*", "user:*"];
      if (!allowedPatterns.includes(pattern)) return;
      try {
        const parsed = JSON.parse(message) as RedisSocketEvent;

        // V2 §2.3 fix: inject conversationId into message:delete so clients can
        // route the tombstone even if the conversation isn't currently loaded.
        // The channel is always "conv:<conversationId>", so we parse it here.
        if (parsed.event === "message:delete" && pattern === "conv:*") {
          const conversationId = channel.slice("conv:".length);
          const enriched = {
            conversationId,
            ...(parsed.data as object),
          };
          chat.to(channel).emit(parsed.event, enriched);
          return;
        }

        chat.to(channel).emit(parsed.event, parsed.data);
      } catch (err) {
        logger.warn(
          `/chat Redis message parse error on ${channel}: ${String(err)}`
        );
      }
    }
  );

  const MessageForwardSchema = z.object({
    messageId: z.string().min(1),
    targetConversationId: z.string().min(1),
    clientMessageId: z.string().min(1),
    conversationType: z.preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.enum(["private", "group"]).default("private")
    ),
    receiverId: z.string().optional(),
    senderName: z.string().optional(),
    senderAvatar: z.string().optional(),
  });
  const MessageReactionsGetSchema = z.object({
    messageId: z.string().min(1),
    conversationId: z.string().min(1),
    conversationType: z.preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.enum(["private", "group"]).default("private")
    ),
  });
  const MessageEditSchema = z.object({
    messageId: z.string().min(1),
    conversationId: z.string().min(1),
    contentText: z.string().max(MAX_TEXT_LEN).optional(),
    contentJson: z.string().max(MAX_JSON_LEN).optional(),
    conversationType: z.preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.enum(["private", "group"]).default("private")
    ),
  });
  const MessageDeliveredSchema = z.object({
    conversationId: z.string().min(1),
    upToMessageId: z.string().min(1),
  });
  const PresenceSubscribeSchema = z.object({
    peerIds: z.array(z.string().min(1)).max(500),
  });
  const CallInitiateSchema = z.object({
    calleeId: z.string().min(1),
    callType: z.enum(["AUDIO", "VIDEO"]).default("AUDIO"),
    privateRoomId: z.string().optional(),
  });
  const CallAnswerSchema = z.object({ callId: z.string().min(1) });
  const CallDeclineSchema = z.object({ callId: z.string().min(1) });
  const CallEndSchema = z.object({ callId: z.string().min(1) });
  const CallIceSchema = z.object({
    callId: z.string().min(1),
    candidate: z.unknown(),
  });

  chat.on("connection", (socket: Socket) => {
    const { userId, locale } = socket.data;
    const deviceId = socket.data.sessionId ?? socket.id;
    void socket.join(`user:${userId}`);
    logger.debug(`/chat connected userId=${userId}`);

    // Mark the user online in chat-service presence (best-effort).
    if (userId) {
      const platform =
        (socket.handshake.query?.platform as string) ||
        (socket.handshake.headers["x-platform"] as string) ||
        "unknown";
      const clientType =
        (socket.handshake.query?.clientType as string) ||
        (socket.handshake.headers["x-client-type"] as string) ||
        "unknown";
      messagingClient
        .presenceConnect({
          userId,
          deviceId,
          platform,
          clientType,
          appState: "FOREGROUND",
        })
        .catch((err: unknown) =>
          logger.warn(`/chat presence:connect error: ${String(err)}`)
        );
    }

    socket.on(
      "conv:join",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = ConvJoinSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        // Idempotent: re-joining an already-tracked room is a no-op in Socket.IO.
        // NOT_FOUND / FORBIDDEN are enforced downstream at message:send time via
        // the gRPC call to messaging-service — not at join time, because the
        // gateway has no membership oracle for arbitrary conversation IDs.
        // CONFLICT (already joined) is treated as success, not an error.
        void socket.join(`conv:${r.data.conversationId}`);
        ackOk(callback, "SOCKET_CONVERSATION_JOINED", locale);
      }
    );

    socket.on(
      "conv:leave",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = ConvLeaveSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        // Idempotent: leaving a room the socket is not in is a no-op.
        // Clients may call leave on reconnect clean-up even if the prior session
        // already left — that is safe.
        void socket.leave(`conv:${r.data.conversationId}`);
        ackOk(callback, "SOCKET_CONVERSATION_LEFT", locale);
      }
    );

    socket.on(
      "message:send",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessageSendSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
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
          .then((result) =>
            ackOk(callback, "SOCKET_MESSAGE_SENT", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/chat message:send gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    socket.on(
      "message:read",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessageReadSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        messagingClient
          .markMessagesRead({ ...r.data, readerId: userId })
          .then((result) =>
            ackOk(callback, "SOCKET_MESSAGE_READ", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/chat message:read gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    socket.on(
      "message:react",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessageReactSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        messagingClient
          .sendReaction({ ...r.data, userId })
          .then((result) =>
            ackOk(callback, "SOCKET_MESSAGE_REACTED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/chat message:react gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    socket.on(
      "messages:fetch",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessagesFetchSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        messagingClient
          .getConversationMessages({ ...r.data, requesterId: userId })
          .then((result) =>
            ackOk(callback, "SOCKET_MESSAGES_FETCHED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/chat messages:fetch gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    // Reconnect gap-fill: fetch missed messages per room since a known seq.
    socket.on(
      "chat:catchup",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const parsed = CatchupSchema.safeParse(payload);
        if (!parsed.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        void (async () => {
          const rooms = parsed.data.rooms;
          const results = await Promise.allSettled(
            rooms.map((room) =>
              messagingClient.catchupRoom({
                conversationId: room.roomId,
                requesterId: userId,
                sinceSeq: room.sinceSeq,
                limit: room.limit ?? 100,
                conversationType: room.conversationType,
              })
            )
          );

          const ackRooms: Array<{
            roomId: string;
            hasMore: boolean;
            lastSeq: number;
            authorized: boolean;
          }> = [];

          results.forEach((res, idx) => {
            const room = rooms[idx]!;
            if (res.status === "fulfilled") {
              const r = res.value;
              socket.emit("chat:catchup:result", {
                roomId: room.roomId,
                events: r.events.map((e) => ({
                  ...e,
                  sequenceNumber: Number(e.sequenceNumber),
                  sentAt: Number(e.sentAt),
                  editedAt: Number(e.editedAt),
                })),
                hasMore: r.hasMore,
                lastSeq: Number(r.lastSeq),
              });
              ackRooms.push({
                roomId: room.roomId,
                hasMore: r.hasMore,
                lastSeq: Number(r.lastSeq),
                authorized: r.authorized,
              });
            } else {
              logger.warn(
                `/chat chat:catchup gRPC error for room ${room.roomId}: ${String(
                  res.reason
                )}`
              );
            }
          });

          ackOk(callback, "SOCKET_CATCHUP_COMPLETED", locale, {
            rooms: ackRooms,
          });
        })();
      }
    );

    // Feature 13: Edit message
    socket.on(
      "message:edit",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessageEditSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        messagingClient
          .editMessage({ ...r.data, editorId: userId })
          .then((result) =>
            ackOk(callback, "SOCKET_MESSAGE_EDITED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/chat message:edit gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    // Feature 15: Delivered receipts (client emits on receiving message:new)
    socket.on(
      "message:delivered",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessageDeliveredSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        messagingClient
          .markDelivered({ ...r.data, recipientId: userId })
          .then((result) =>
            ackOk(callback, "SOCKET_MESSAGE_DELIVERED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/chat message:delivered gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    // Feature 18/19: Presence heartbeat + peer subscription
    socket.on("presence:heartbeat", (payload: unknown) => {
      const appState =
        (payload as { appState?: string } | undefined)?.appState ??
        "FOREGROUND";
      messagingClient
        .presenceHeartbeat({ userId, deviceId, appState })
        .catch((err: unknown) =>
          logger.warn(`/chat presence:heartbeat error: ${String(err)}`)
        );
    });

    socket.on(
      "presence:subscribe",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = PresenceSubscribeSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        for (const peerId of r.data.peerIds) {
          void socket.join(`user:${peerId}`);
        }
        ackOk(callback, "SOCKET_PRESENCE_SUBSCRIBED", locale);
      }
    );

    socket.on(
      "presence:unsubscribe",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = PresenceSubscribeSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        for (const peerId of r.data.peerIds) {
          void socket.leave(`user:${peerId}`);
        }
        ackOk(callback, "SOCKET_PRESENCE_UNSUBSCRIBED", locale);
      }
    );

    // Gap #6: bulk-clear all peer presence subscriptions in one call.
    socket.on(
      "presence:unsubscribe_all",
      (_payload: unknown, callback?: (res: unknown) => void) => {
        let unsubscribedCount = 0;
        for (const room of socket.rooms) {
          // Leave every user:* room except the socket's own identity room.
          if (room.startsWith("user:") && room !== `user:${userId}`) {
            void socket.leave(room);
            unsubscribedCount++;
          }
        }
        ackOk(callback, "SOCKET_PRESENCE_UNSUBSCRIBED_ALL", locale, {
          unsubscribedCount,
        });
      }
    );

    // Gap #6: query which peers this socket is currently tracking.
    socket.on(
      "presence:list",
      (_payload: unknown, callback?: (res: unknown) => void) => {
        const peerIds: string[] = [];
        for (const room of socket.rooms) {
          if (room.startsWith("user:") && room !== `user:${userId}`) {
            peerIds.push(room.slice("user:".length));
          }
        }
        ackOk(callback, "SOCKET_PRESENCE_LIST_FETCHED", locale, { peerIds });
      }
    );

    // Gap #7: per-socket typing-expiry timers.
    // Fire-and-forget (no ack). Server holds a 6 s countdown per
    // conversationId; if typing:stop is never received (e.g. app crash,
    // network drop) the timer fires and broadcasts the stop automatically.
    // On disconnect all pending timers are flushed and stops are broadcast.
    const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

    const clearTyping = (conversationId: string): void => {
      const t = typingTimers.get(conversationId);
      if (t !== undefined) {
        clearTimeout(t);
        typingTimers.delete(conversationId);
      }
    };

    socket.on("typing:start", (payload: unknown) => {
      const r = TypingSchema.safeParse(payload);
      if (!r.success) return;
      const { conversationId, senderName } = r.data;

      // Reset the expiry window each time the client refreshes typing:start.
      clearTyping(conversationId);

      chat.to(`conv:${conversationId}`).emit("typing:start", {
        userId,
        conversationId,
        // V2 §2.8: include sender name when supplied so recipients don't need a
        // profile fetch to render "Alice is typing…"
        ...(senderName ? { senderName } : {}),
      });

      typingTimers.set(
        conversationId,
        setTimeout(() => {
          typingTimers.delete(conversationId);
          chat
            .to(`conv:${conversationId}`)
            .emit("typing:stop", { userId, conversationId });
        }, 6000)
      );
    });

    socket.on("typing:stop", (payload: unknown) => {
      const r = TypingSchema.safeParse(payload);
      if (!r.success) return;
      const { conversationId, senderName } = r.data;

      clearTyping(conversationId);
      chat.to(`conv:${conversationId}`).emit("typing:stop", {
        userId,
        conversationId,
        ...(senderName ? { senderName } : {}),
      });
    });

    // Feature 1: Forward message
    socket.on(
      "message:forward",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessageForwardSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        messagingClient
          .forwardMessage({
            messageId: r.data.messageId,
            targetConversationId: r.data.targetConversationId,
            senderId: userId,
            receiverId: r.data.receiverId ?? "",
            clientMessageId: r.data.clientMessageId,
            conversationType: r.data.conversationType,
            senderName: r.data.senderName ?? "",
            senderAvatar: r.data.senderAvatar ?? "",
          })
          .then((result) =>
            ackOk(callback, "SOCKET_MESSAGE_FORWARDED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/chat message:forward gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    // Feature 2: Get reaction users
    socket.on(
      "message:reactions:get",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessageReactionsGetSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        messagingClient
          .getMessageReactions({ ...r.data, requesterId: userId })
          .then((result) =>
            ackOk(callback, "SOCKET_REACTIONS_FETCHED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(
              `/chat message:reactions:get gRPC error: ${String(err)}`
            );
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    // Feature 4: Call signaling
    socket.on(
      "call:initiate",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CallInitiateSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        messagingClient
          .initiateCall({
            callerId: userId,
            calleeId: r.data.calleeId,
            type: r.data.callType,
            privateRoomId: r.data.privateRoomId,
          })
          .then((result) =>
            ackOk(callback, "SOCKET_CALL_INITIATED", locale, {
              callId: result.callId,
              status: result.status,
              rtcConfig: result.rtcConfig,
            })
          )
          .catch((err: unknown) => {
            logger.warn(`/chat call:initiate gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    socket.on(
      "call:answer",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CallAnswerSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        messagingClient
          .answerCall({ ...r.data, calleeId: userId })
          .then((result) =>
            ackOk(callback, "SOCKET_CALL_ANSWERED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/chat call:answer gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    socket.on(
      "call:decline",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CallDeclineSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        messagingClient
          .declineCall({ ...r.data, calleeId: userId })
          .then((result) =>
            ackOk(callback, "SOCKET_CALL_DECLINED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/chat call:decline gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    socket.on(
      "call:end",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CallEndSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        messagingClient
          .endCall({ callId: r.data.callId, userId })
          .then((result) =>
            ackOk(callback, "SOCKET_CALL_ENDED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/chat call:end gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    // ICE candidates: relay directly via Redis — no gRPC, no DB
    socket.on("call:ice", (payload: unknown) => {
      const r = CallIceSchema.safeParse(payload);
      if (!r.success) return;
      void redisPub.publish(
        `call:${r.data.callId}`,
        JSON.stringify({
          event: "call:ice",
          data: {
            callId: r.data.callId,
            candidate: r.data.candidate,
            from: userId,
          },
        })
      );
    });

    socket.on("disconnect", (reason: string) => {
      logger.debug(`/chat disconnected userId=${userId} reason=${reason}`);

      // Flush all pending typing-expiry timers and broadcast stop so peers are
      // never stuck with a "typing…" indicator after the socket closes.
      for (const [conversationId, timer] of typingTimers) {
        clearTimeout(timer);
        chat
          .to(`conv:${conversationId}`)
          .emit("typing:stop", { userId, conversationId });
      }
      typingTimers.clear();

      if (userId) {
        messagingClient
          .presenceDisconnect({ userId, deviceId })
          .catch((err: unknown) =>
            logger.warn(`/chat presence:disconnect error: ${String(err)}`)
          );
      }
    });
  });
}
