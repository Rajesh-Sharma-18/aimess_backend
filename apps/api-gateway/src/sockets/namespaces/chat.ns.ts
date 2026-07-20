import type { Server as SocketIOServer, Namespace, Socket } from "socket.io";
import type { Redis } from "ioredis";
import { z } from "zod";
import { logger } from "@aimess/logger";
import { createGatewaySocketAuthMiddleware } from "../auth.middleware.js";
import { ackOk, ackError, resolveGrpcAckError } from "../ack.js";
import { personalizeGroupSocketMessage } from "../system-message-personalize.js";
import { emitPersonalizedSender } from "../emit-personalized.js";
import type {
  CatchupEventDto,
  MessagingClient,
} from "../../grpc/clients/messaging.client.js";
import type { UserClient } from "../../grpc/clients/user.client.js";
import type { MediaClient } from "../../grpc/clients/media.client.js";
import {
  resolveSocketUserDetails,
  buildTypingBroadcast,
} from "../user-details.js";
import {
  createPresenceIndicator,
  createDirectRosterBroadcast,
  createRoomBroadcast,
} from "../presence-indicator.js";
import { env } from "../../config/env.js";
import { createSessionTimers } from "../session-timers.js";

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

/**
 * Cross-namespace request-DTO parity (/community is the reference contract).
 *
 * /community names the same concepts `roomId`, `message`, `parentMessageId`, and
 * `content.text`; /chat has always named them `conversationId`, `contentText`,
 * `repliedToId`, and `contentText`. Renaming the /chat fields would break every
 * shipped Web/Android/iOS client, so instead this normalizes the /community
 * spelling INTO the /chat spelling before validation: both are accepted on the
 * wire, the legacy /chat name stays canonical downstream, and nothing existing
 * changes meaning. The legacy name always wins when a client sends both.
 *
 * Applied to every /chat inbound schema — a schema that has no such field simply
 * strips the injected key, so this is safe to apply uniformly.
 */
const withCommunityAliases = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    const v = value as Record<string, unknown>;
    const aliased = { ...v };
    if (aliased.conversationId === undefined && v.roomId !== undefined) {
      aliased.conversationId = v.roomId;
    }
    if (aliased.contentText === undefined && v.message !== undefined) {
      aliased.contentText = v.message;
    }
    if (
      aliased.contentText === undefined &&
      v.content !== null &&
      typeof v.content === "object" &&
      !Array.isArray(v.content)
    ) {
      aliased.contentText = (v.content as Record<string, unknown>).text;
    }
    if (aliased.repliedToId === undefined && v.parentMessageId !== undefined) {
      aliased.repliedToId = v.parentMessageId;
    }
    if (
      aliased.targetConversationId === undefined &&
      v.targetRoomId !== undefined
    ) {
      aliased.targetConversationId = v.targetRoomId;
    }
    return aliased;
  }, schema);

// ─── Inbound payload schemas ────────────────────────────────────────────────
const ConvJoinSchema = withCommunityAliases(
  z.object({ conversationId: z.string().min(1) })
);
const ConvLeaveSchema = withCommunityAliases(
  z.object({ conversationId: z.string().min(1) })
);
const TypingSchema = withCommunityAliases(
  z.object({
    conversationId: z.string().min(1),
    // V2 §2.8: client supplies its own display name so recipients can show
    // "Alice is typing…" without an extra profile fetch.
    senderName: z.string().max(100).optional(),
    // Additive and optional: lets the gateway resolve the participant roster
    // through the right branch (private participants vs. group members) for
    // room-independent typing delivery. Legacy clients omit it and get the
    // PRIVATE default, which is what /chat typing has always assumed.
    conversationType: z.preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.enum(["private", "group"]).default("private")
    ),
  })
);
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
const MessageSendSchemaBase = z.object({
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
const MessageReadSchemaBase = z.object({
  conversationId: z.string().min(1),
  upToMessageId: z.string().min(1),
});
const MessageReactSchemaBase = z.object({
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
const MessagesFetchSchemaBase = z.object({
  conversationId: z.string().min(1),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
  conversationType: z.preprocess(
    (value) =>
      typeof value === "string" ? value.toString().toLowerCase() : value,
    z.enum(["private", "group"]).default("private")
  ),
});

// Each `*Base` above defines the canonical /chat field names; the exported
// schema additionally accepts the equivalent /community spellings (roomId,
// message, content.text, parentMessageId). See withCommunityAliases.
const MessageSendSchema = withCommunityAliases(MessageSendSchemaBase);
const MessageReadSchema = withCommunityAliases(MessageReadSchemaBase);
const MessageReactSchema = withCommunityAliases(MessageReactSchemaBase);
const MessagesFetchSchema = withCommunityAliases(MessagesFetchSchemaBase);

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

// ── Friend management schemas ─────────────────────────────────────────────────
const FriendRequestSchema = z.object({
  addresseeId: z.string().uuid(),
});
const FriendAcceptSchema = z.object({
  requestId: z.string().uuid(),
});
const FriendRejectSchema = z.object({
  requestId: z.string().uuid(),
});
const FriendRemoveSchema = z.object({
  targetUserId: z.string().uuid(),
});
const FriendCancelRequestSchema = z.object({
  requestId: z.string().uuid(),
});

// ─── Redis pub/sub message shape published by messaging-service ──────────────
interface RedisSocketEvent {
  event: string;
  data: unknown;
}

/** Restore the canonical message shape stripped down by the catch-up protobuf. */
export function normalizeCatchupEvent(
  event: CatchupEventDto,
  conversationType: string
): Record<string, unknown> {
  const { systemData: rawSystemData, ...eventWithoutRawSystemData } = event;
  let content: Record<string, unknown> = {
    text: event.contentText ?? "",
    urls: [],
    files: [],
  };
  if (event.contentJson) {
    try {
      const parsedContent = JSON.parse(event.contentJson) as unknown;
      if (parsedContent && typeof parsedContent === "object") {
        content = parsedContent as Record<string, unknown>;
      }
    } catch {
      // Keep the contentText fallback above.
    }
  }

  let systemData: Record<string, unknown> | undefined;
  if (rawSystemData) {
    try {
      const parsedSystemData = JSON.parse(rawSystemData) as unknown;
      if (parsedSystemData && typeof parsedSystemData === "object") {
        systemData = parsedSystemData as Record<string, unknown>;
      }
    } catch {
      // Malformed optional metadata must not hide the message.
    }
  }

  const serverTs = Number(event.sentAt);
  return {
    ...eventWithoutRawSystemData,
    id: event.messageId,
    roomId: event.conversationId,
    conversationType: conversationType.toUpperCase(),
    content,
    reactions: [],
    sequenceNumber: Number(event.sequenceNumber),
    serverTs,
    sentAt: serverTs,
    createdAt: new Date(serverTs).toISOString(),
    editedAt: Number(event.editedAt),
    ...(systemData ? { systemData } : {}),
  };
}

export function registerChatNamespace(
  io: SocketIOServer,
  messagingClient: MessagingClient,
  redisSub: Redis,
  redisPub: Redis,
  userClient: UserClient,
  mediaClient: MediaClient
): void {
  const chat: Namespace = io.of("/chat");
  chat.use(createGatewaySocketAuthMiddleware(redisPub));

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

        // Community list-bump / read-sync events (community:updated,
        // community:read_sync, …) ride the shared user:<id> channel but belong to
        // the /community namespace only. Skip them here so they are NOT duplicated
        // onto /chat — the mirror filter in community.ns.ts forwards exactly these
        // (event name starts with "community:") from user:*. /chat keeps delivering
        // conv:updated for the private/group inbox bump.
        if (parsed.event.startsWith("community:")) return;

        // V2 §2.3 fix: inject conversationId into message:delete so clients can
        // route the tombstone even if the conversation isn't currently loaded.
        // The channel is always "conv:<conversationId>", so we parse it here.
        if (parsed.event === "message:delete" && pattern === "conv:*") {
          const conversationId = channel.slice("conv:".length);
          const enriched = {
            conversationId,
            ...(parsed.data as object),
          };
          void emitPersonalizedSender(chat, channel, parsed.event, enriched);
          return;
        }

        let personalizeFn:
          | ((data: unknown, userId: string) => unknown)
          | undefined;
        if (parsed.event === "message:new" && pattern === "conv:*") {
          const contentType = String(
            (parsed.data as { contentType?: string; messageType?: string })
              .contentType ??
              (parsed.data as { messageType?: string }).messageType ??
              ""
          ).toUpperCase();
          if (contentType === "SYSTEM") {
            personalizeFn = personalizeGroupSocketMessage;
          }
        }

        void emitPersonalizedSender(
          chat,
          channel,
          parsed.event,
          parsed.data,
          personalizeFn
        );
      } catch (err) {
        logger.warn(
          `/chat Redis message parse error on ${channel}: ${String(err)}`
        );
      }
    }
  );

  const MessageForwardSchemaBase = z.object({
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
  const MessageReactionsGetSchemaBase = z.object({
    messageId: z.string().min(1),
    conversationId: z.string().min(1),
    conversationType: z.preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.enum(["private", "group"]).default("private")
    ),
  });
  const MessageEditSchemaBase = z.object({
    messageId: z.string().min(1),
    conversationId: z.string().min(1),
    contentText: z.string().max(MAX_TEXT_LEN).optional(),
    contentJson: z.string().max(MAX_JSON_LEN).optional(),
    conversationType: z.preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.enum(["private", "group"]).default("private")
    ),
  });
  const MessageDeliveredSchemaBase = z.object({
    conversationId: z.string().min(1),
    upToMessageId: z.string().min(1),
  });
  // Parity with /community's community:message:delete / pin / unpin — private/
  // group previously had no socket RPC for these (REST-only).
  const MessageDeleteSchemaBase = z.object({
    conversationId: z.string().min(1),
    messageId: z.string().min(1),
    type: z.enum(["forMe", "forEveryone"]).default("forMe"),
    conversationType: z.preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.enum(["private", "group"]).default("private")
    ),
  });
  const MessagePinSchemaBase = z.object({
    conversationId: z.string().min(1),
    messageId: z.string().min(1),
    conversationType: z.preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.enum(["private", "group"]).default("private")
    ),
  });
  const MessageForwardSchema = withCommunityAliases(MessageForwardSchemaBase);
  const MessageReactionsGetSchema = withCommunityAliases(
    MessageReactionsGetSchemaBase
  );
  const MessageEditSchema = withCommunityAliases(MessageEditSchemaBase);
  const MessageDeliveredSchema = withCommunityAliases(
    MessageDeliveredSchemaBase
  );
  const MessageDeleteSchema = withCommunityAliases(MessageDeleteSchemaBase);
  const MessagePinSchema = withCommunityAliases(MessagePinSchemaBase);

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

  chat.on("connection", (socket: Socket) => {
    const { userId, sessionId, locale } = socket.data;
    const deviceId = sessionId ?? socket.id;
    void socket.join(`user:${userId}`);
    void socket.join(`session:${sessionId}`);
    logger.debug(`/chat connected userId=${userId}`);

    // Resolve sender identity ONCE per connection (gRPC snapshot + avatar
    // presign) so every typing broadcast can carry userDetails without a
    // per-event fetch. Fire-and-forget: a safe default is set immediately and
    // the resolved value overwrites it when ready, keeping connect latency zero.
    socket.data.userDetails = {
      userId,
      username: "",
      displayName: "",
      avatarUrl: null,
    };
    void resolveSocketUserDetails(userClient, mediaClient, userId).then(
      (ud) => {
        socket.data.userDetails = ud;
      }
    );

    // Presence key for FCM routing: notifications-service checks this before
    // pushing to avoid sending FCM to a user who is actively connected.
    // TTL = 300 s; refreshed on every presence:heartbeat so the key stays alive
    // as long as the socket is open. On clean disconnect the key is deleted
    // immediately; the TTL handles unclean disconnects (TCP drops etc.).
    void redisPub.set(`user:online:${userId}`, "1", "EX", 300);

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
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
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
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
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
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
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
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
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
                // Normalize the thin gRPC CatchupEventDto back to the same
                // canonical shape as live message:new. Without this, reconnect
                // gap-fill rows have no `id`/`content`, so DM SYSTEM call audit
                // entries (and ordinary text) cannot render until a full reload.
                events: r.events.map((event) =>
                  normalizeCatchupEvent(event, room.conversationType)
                ),
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
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
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
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    // Feature 18/19: Presence heartbeat + peer subscription
    socket.on("presence:heartbeat", (payload: unknown) => {
      const appState =
        (payload as { appState?: string } | undefined)?.appState ??
        "FOREGROUND";
      // Refresh the FCM-routing online key on every heartbeat.
      void redisPub.set(`user:online:${userId}`, "1", "EX", 300);
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

    // session:expired warning + auth:refresh — shared helper handles the 5-min
    // warn timer, 60-s grace disconnect, and token-refresh event registration.
    const {
      clearSessionTimers,
      scheduleSessionTimers,
      registerAuthRefreshHandler,
    } = createSessionTimers(socket, locale, "/chat", env.AUTH_SERVICE_URL);

    if (socket.data.tokenExpiresAt > 0) {
      scheduleSessionTimers(socket.data.tokenExpiresAt);
    }
    registerAuthRefreshHandler();

    // ── Typing indicator ────────────────────────────────────────────────────
    // Fire-and-forget (no ack). Timer/TTL/flush mechanics live in the shared
    // presence-indicator engine — the same instance /community uses.
    //
    // ROOM-INDEPENDENT, matching /community: recipients are resolved from the
    // room's participant roster and reached through their `user:<id>` sockets,
    // so a peer receives the indicator whether or not they ever sent
    // conv:join. This also closes the gap where /chat performed NO
    // authorization at all — conv:join has no membership oracle, so any
    // authenticated socket could previously join `conv:<anyRoomId>` and inject
    // a fake typing indicator into a DM or group it was not part of. The
    // roster now gates the sender, exactly as community's active-member list
    // does. Fail-closed: an empty/failed roster suppresses the event.
    //
    // The wire event names (`typing:start` / `typing:stop`) and the payload
    // (buildTypingBroadcast) are unchanged — shipped clients see no difference.
    const typingPayload = (conversationId: string, senderName?: string) =>
      buildTypingBroadcast(
        userId,
        socket.data.userDetails,
        conversationId,
        Date.now(),
        { senderName }
      );

    // Remembers what the client last told us about a room, so the TTL-expiry
    // and disconnect-flush stops — which carry no client payload — resolve the
    // roster through the same branch the start did and keep the same
    // senderName fallback in the payload.
    const typingHints = new Map<
      string,
      { kind: "private" | "group"; senderName?: string }
    >();

    const typing = createPresenceIndicator({
      startEvent: "typing:start",
      stopEvent: "typing:stop",
      broadcast: createDirectRosterBroadcast({
        namespace: chat,
        senderId: userId,
        resolveRoster: async (conversationId) => {
          try {
            const { userIds } = await messagingClient.getRoomParticipantIds({
              conversationId,
              conversationType:
                typingHints.get(conversationId)?.kind ?? "private",
            });
            return userIds;
          } catch (err) {
            logger.warn(
              `/chat typing: failed to resolve participants conversationId=${conversationId}: ${String(err)}`
            );
            return [];
          }
        },
        buildPayload: (conversationId) =>
          typingPayload(
            conversationId,
            typingHints.get(conversationId)?.senderName
          ),
      }),
    });

    const rememberTypingHint = (d: {
      conversationId: string;
      conversationType: "private" | "group";
      senderName?: string;
    }): void => {
      typingHints.set(d.conversationId, {
        kind: d.conversationType,
        senderName: d.senderName,
      });
    };

    socket.on("typing:start", (payload: unknown) => {
      const r = TypingSchema.safeParse(payload);
      if (!r.success) return;
      rememberTypingHint(r.data);
      typing.start(r.data.conversationId);
    });

    socket.on("typing:stop", (payload: unknown) => {
      const r = TypingSchema.safeParse(payload);
      if (!r.success) return;
      rememberTypingHint(r.data);
      typing.stop(r.data.conversationId);
    });

    // ── Voice recording presence ────────────────────────────────────────────
    // Same shared engine, room-based delivery — deliberately UNCHANGED in
    // behaviour and identical to /community's recording indicator, which also
    // stayed room-based when typing moved to direct delivery.
    const recordingNames = new Map<string, string | undefined>();

    const recording = createPresenceIndicator({
      startEvent: "recording:start",
      stopEvent: "recording:stop",
      broadcast: createRoomBroadcast({
        namespace: chat,
        socket,
        rooms: (conversationId) => [`conv:${conversationId}`],
        buildPayload: (conversationId) =>
          buildTypingBroadcast(
            userId,
            socket.data.userDetails,
            conversationId,
            Date.now(),
            { senderName: recordingNames.get(conversationId) }
          ),
      }),
    });

    socket.on("recording:start", (payload: unknown) => {
      const r = TypingSchema.safeParse(payload);
      if (!r.success) return;
      recordingNames.set(r.data.conversationId, r.data.senderName);
      recording.start(r.data.conversationId);
    });

    socket.on("recording:stop", (payload: unknown) => {
      const r = TypingSchema.safeParse(payload);
      if (!r.success) return;
      recordingNames.set(r.data.conversationId, r.data.senderName);
      recording.stop(r.data.conversationId);
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
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    // Delete a message (for me / for everyone) over the socket — parity with
    // /community's community:message:delete. Broadcast (message:delete on
    // conv:<id>) is published by the gRPC handler via the shared orchestrator,
    // same as the REST delete endpoint.
    socket.on(
      "message:delete",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessageDeleteSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        messagingClient
          .deleteMessage({
            conversationId: r.data.conversationId,
            messageId: r.data.messageId,
            userId,
            deleteType: r.data.type,
            conversationType: r.data.conversationType,
          })
          .then((result) =>
            ackOk(callback, "SOCKET_MESSAGE_DELETED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/chat message:delete gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    // Pin/unpin a message over the socket — parity with /community's
    // community:message:pin/unpin.
    socket.on(
      "message:pin",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessagePinSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        messagingClient
          .pinMessage({
            conversationId: r.data.conversationId,
            messageId: r.data.messageId,
            userId,
            conversationType: r.data.conversationType,
          })
          .then((result) =>
            ackOk(callback, "SOCKET_MESSAGE_PINNED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/chat message:pin gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    socket.on(
      "message:unpin",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessagePinSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        messagingClient
          .unpinMessage({
            conversationId: r.data.conversationId,
            messageId: r.data.messageId,
            userId,
            conversationType: r.data.conversationType,
          })
          .then((result) =>
            ackOk(callback, "SOCKET_MESSAGE_UNPINNED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/chat message:unpin gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
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
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
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
          .then((result) => {
            // Join the caller's socket to `call:<callId>` so lifecycle events
            // (call:answered / call:declined / call:ended) reach them.
            void socket.join(`call:${result.callId}`);
            ackOk(callback, "SOCKET_CALL_INITIATED", locale, {
              callId: result.callId,
              status: result.status,
              livekitUrl: result.livekit?.url,
              token: result.livekit?.token,
            });
          })
          .catch((err: unknown) => {
            logger.warn(`/chat call:initiate gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
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
          .then((result) => {
            // Callee joins `call:<callId>` on answer — mirrors the caller's
            // join at initiate. Both peers now receive `call:ended` etc.
            void socket.join(`call:${result.callId}`);
            ackOk(callback, "SOCKET_CALL_ANSWERED", locale, result);
          })
          .catch((err: unknown) => {
            logger.warn(`/chat call:answer gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
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
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
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
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    // Note: `call:ice` was removed with the LiveKit migration — LiveKit's
    // client SDKs handle ICE/NAT internally. See Docs/calls/CALLS-LIVEKIT.md.

    // ── Friend management ────────────────────────────────────────────────────
    // Gateway calls user-service REST endpoints on behalf of the authenticated
    // user (forwarding their JWT), then publishes real-time notifications to
    // the target's user:* Redis channel for immediate socket fan-out.

    const userSvcBase = env.USER_SERVICE_URL
      ? `${env.USER_SERVICE_URL}/api/v1/users/friends`
      : null;

    const callUserSvc = async (
      method: string,
      path: string,
      body?: object
    ): Promise<{ ok: boolean; status: number; data: unknown }> => {
      if (!userSvcBase) return { ok: false, status: 503, data: null };
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(`${userSvcBase}${path}`, {
          method,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${socket.data.accessToken}`,
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const json = (await res.json().catch(() => null)) as { data?: unknown };
        return { ok: res.ok, status: res.status, data: json?.data ?? null };
      } catch {
        clearTimeout(timeoutId);
        return { ok: false, status: 500, data: null };
      }
    };

    // Realtime friend:* fan-out (all logged-in devices, both parties) is
    // published centrally by user-service after every DB mutation — see
    // `apps/user-service/src/lib/friend-socket.ts` — so it fires identically
    // whether the client called this RPC or the REST API directly. These
    // handlers are thin proxies only; they must NOT also publish, or every
    // socket-originated action would double-emit.
    socket.on(
      "friend.request",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = FriendRequestSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        void (async () => {
          const result = await callUserSvc("POST", "/requests", {
            addresseeId: r.data.addresseeId,
          });
          if (!result.ok) {
            ackError(
              callback,
              result.status === 409 ? "CONFLICT" : "SERVICE_ERROR",
              locale
            );
            return;
          }
          const reqData = result.data as { id?: string } | null;
          ackOk(callback, "SOCKET_FRIEND_REQUEST_SENT", locale, {
            requestId: reqData?.id,
          });
        })();
      }
    );

    socket.on(
      "friend.accept",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = FriendAcceptSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        void (async () => {
          const result = await callUserSvc(
            "POST",
            `/requests/${r.data.requestId}/accept`
          );
          if (!result.ok) {
            ackError(
              callback,
              result.status === 404 ? "NOT_FOUND" : "SERVICE_ERROR",
              locale
            );
            return;
          }
          ackOk(callback, "SOCKET_FRIEND_REQUEST_ACCEPTED", locale);
        })();
      }
    );

    socket.on(
      "friend.reject",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = FriendRejectSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        void (async () => {
          const result = await callUserSvc(
            "POST",
            `/requests/${r.data.requestId}/reject`
          );
          if (!result.ok) {
            ackError(
              callback,
              result.status === 404 ? "NOT_FOUND" : "SERVICE_ERROR",
              locale
            );
            return;
          }
          ackOk(callback, "SOCKET_FRIEND_REQUEST_REJECTED", locale);
        })();
      }
    );

    socket.on(
      "friend.remove",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = FriendRemoveSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        void (async () => {
          const result = await callUserSvc("DELETE", `/${r.data.targetUserId}`);
          if (!result.ok) {
            ackError(
              callback,
              result.status === 404 ? "NOT_FOUND" : "SERVICE_ERROR",
              locale
            );
            return;
          }
          ackOk(callback, "SOCKET_FRIEND_REMOVED", locale);
        })();
      }
    );

    socket.on(
      "friend.cancel_request",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = FriendCancelRequestSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        void (async () => {
          const result = await callUserSvc(
            "DELETE",
            `/requests/${r.data.requestId}`
          );
          if (!result.ok) {
            ackError(
              callback,
              result.status === 404 ? "NOT_FOUND" : "SERVICE_ERROR",
              locale
            );
            return;
          }
          ackOk(callback, "SOCKET_FRIEND_REQUEST_CANCELLED", locale);
        })();
      }
    );

    socket.on("disconnect", (reason: string) => {
      logger.debug(`/chat disconnected userId=${userId} reason=${reason}`);

      clearSessionTimers();

      // Flush every pending presence timer and broadcast the stop, so peers are
      // never stuck with a "typing…" / "recording…" indicator after the socket
      // closes. Both flushes route through the shared engine, so /chat and
      // /community now clean up identically.
      typing.flush();
      recording.flush();

      if (userId) {
        void redisPub.del(`user:online:${userId}`);
        messagingClient
          .presenceDisconnect({ userId, deviceId })
          .catch((err: unknown) =>
            logger.warn(`/chat presence:disconnect error: ${String(err)}`)
          );
      }
    });
  });
}
