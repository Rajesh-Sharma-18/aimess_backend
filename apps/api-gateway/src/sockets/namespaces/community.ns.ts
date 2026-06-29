import type { Server as SocketIOServer, Namespace, Socket } from "socket.io";
import type { Redis } from "ioredis";
import { z } from "zod";
import { logger } from "@aimess/logger";
import { gatewaySocketAuthMiddleware } from "../auth.middleware.js";
import { ackOk, ackError } from "../ack.js";
import type { CommunityClient } from "../../grpc/clients/community.client.js";
import type { UserClient } from "../../grpc/clients/user.client.js";
import type { MediaClient } from "../../grpc/clients/media.client.js";
import {
  resolveSocketUserDetails,
  buildTypingBroadcast,
} from "../user-details.js";
import { env } from "../../config/env.js";
import { createSessionTimers } from "../session-timers.js";
import { personalizeCommunitySocketMessage } from "../system-message-personalize.js";

// §3: bound free-text fields so a naive/abusive client cannot exceed the 1 MB
// socket frame or fan an oversized payload out to a whole community room.
const MAX_TEXT_LEN = 4000; // message body / caption (matches chat-service CHAT_TEXT_MAX_CHARS)
const MAX_FILES = 30; // attachments per message (gallery)
const MAX_EMOJI_LEN = 32; // one emoji grapheme incl. ZWJ/skin-tone sequences

const CommunityJoinSchema = z.object({
  communityId: z.string().min(1),
  roomId: z.string().min(1).optional(),
});
const CommunityLeaveSchema = z.object({ communityId: z.string().min(1) });
const CommunityTypingSchema = z.object({
  communityId: z.string().min(1),
  // roomId is accepted for forward-compat/contract symmetry but is intentionally
  // NOT used for fan-out: typing is community-scoped and broadcasts to the whole
  // `community:<communityId>` room (the only room clients join). senderName is a
  // legacy display fallback only — never an identity source (userId is server-side).
  roomId: z.string().min(1).optional(),
  senderName: z.string().max(100).optional(),
});
const CommunityMsgSendFileSchema = z.object({
  url: z.string().url().optional(),
  objectKey: z.string().min(1).max(500).optional(),
  name: z.string().default(""),
  size: z.number().nonnegative().default(0),
  mime: z.string().default(""),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  durationMs: z.number().nonnegative().optional(),
  blurhash: z.string().max(120).optional(),
  waveform: z.array(z.number()).max(2048).optional(),
});

const CommunityMsgSendSchema = z.object({
  communityId: z.string().min(1),
  roomId: z.string().min(1).optional(),
  clientMessageId: z.string().optional(),
  message: z.string().max(MAX_TEXT_LEN).default(""),
  // Cross-namespace parity alias: `contentText` is accepted as an alias for `message`.
  contentText: z.string().max(MAX_TEXT_LEN).optional(),
  contentType: z
    .string()
    .min(1)
    .transform((v) => v.toUpperCase()),
  media: z
    .object({ files: z.array(CommunityMsgSendFileSchema).max(MAX_FILES) })
    .optional(),
  // Cross-namespace parity alias: top-level `files[]` is accepted as alias for `media.files[]`.
  files: z.array(CommunityMsgSendFileSchema).max(MAX_FILES).optional(),
  location: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      placeName: z.string().max(200).optional(),
      placeAddress: z.string().max(500).optional(),
    })
    .optional(),
  contact: z
    .object({
      name: z.string().min(1).max(200),
      phone: z.string().min(1).max(50),
      avatar: z.string().max(3000).optional(),
      userId: z.string().max(100).optional(),
    })
    .optional(),
  sticker: z
    .object({
      objectKey: z.string().min(1).max(500).optional(),
      url: z.string().url().optional(),
      packId: z.string().max(100),
      stickerId: z.string().max(100),
    })
    .optional(),
  parentMessageId: z.string().optional(),
});
const CommunityMsgsFetchSchema = z.object({
  roomId: z.string().min(1),
  // Gap #8: cursor must be a valid ISO 8601 date-time string AND must not be in
  // the future — a future cursor would return 0 results and is almost certainly
  // a client bug or a replay attack.
  // 5 s future grace absorbs sender-clock skew (last-message timestamps from a
  // device whose clock is slightly ahead should still be accepted as cursors).
  cursor: z
    .string()
    .datetime({ offset: true })
    .refine((d) => new Date(d) <= new Date(Date.now() + 5_000), {
      message: "cursor must not be in the future",
    })
    .optional(),
  limit: z.number().int().positive().max(100).default(30),
});
const CommunityMsgReactSchema = z.object({
  messageId: z.string().min(1),
  communityId: z.string().min(1),
  emoji: z.string().min(1).max(MAX_EMOJI_LEN),
});
const CommunityCatchupRoomSchema = z.object({
  roomId: z.string().min(1),
  sinceId: z.string().optional(),
  // P2 §13: max 100 events per room per catchup request.
  limit: z.number().int().positive().max(100).optional(),
  /**
   * Epoch-ms (positive integer). When provided the server switches to an
   * updatedAt-based query that surfaces edits, reaction changes, and
   * tombstones — ideal for returning from the background.
   * Mutually exclusive with sinceId; sinceTs takes precedence when both given.
   */
  sinceTs: z.number().int().positive().optional(),
});
// P2 §13: max 10 rooms per catchup request to prevent oversized payloads.
// Users in many communities must batch requests; the ack includes hasMore + cursors.
const CommunityCatchupSchema = z.object({
  rooms: z.array(CommunityCatchupRoomSchema).min(1).max(10),
});

const CommunityMsgEditSchema = z.object({
  messageId: z.string().min(1),
  communityId: z.string().min(1),
  roomId: z.string().min(1).optional(),
  content: z.object({ text: z.string().min(1).max(4000) }),
});

const CommunityMsgDeleteSchema = z.object({
  messageId: z.string().min(1),
  communityId: z.string().min(1),
  roomId: z.string().min(1).optional(),
  type: z.enum(["forEveryone", "forMe"]),
});

const CommunityMsgPinSchema = z.object({
  messageId: z.string().min(1),
  communityId: z.string().min(1),
  roomId: z.string().min(1).optional(),
});

const CommunityMsgUnpinSchema = z.object({
  messageId: z.string().min(1),
  communityId: z.string().min(1),
  roomId: z.string().min(1).optional(),
});

// ── Moderation schemas ───────────────────────────────────────────────────────
const KickMemberSchema = z.object({
  communityId: z.string().min(1),
  targetUserId: z.string().min(1),
  reason: z.string().max(500).optional(),
});
const BanMemberSchema = z.object({
  communityId: z.string().min(1),
  targetUserId: z.string().min(1),
  reason: z.string().max(500).optional(),
});
const UnbanMemberSchema = z.object({
  communityId: z.string().min(1),
  targetUserId: z.string().min(1),
});
const TransferAdminSchema = z.object({
  communityId: z.string().min(1),
  newAdminId: z.string().min(1),
});
const ChangeMemberRoleSchema = z.object({
  communityId: z.string().min(1),
  targetUserId: z.string().min(1),
  newRole: z.enum(["MODERATOR", "MEMBER"]),
});
const CreateReportSchema = z.object({
  communityId: z.string().min(1),
  reason: z.string().min(1).max(1000),
  targetMessageId: z.string().optional(),
});
const DeleteCommunitySchema = z.object({
  communityId: z.string().min(1),
  reason: z.string().max(500).optional(),
});

// ── New parity schemas ────────────────────────────────────────────────────────
const CommunityMsgReadSchema = z.object({
  communityId: z.string().min(1),
  roomId: z.string().min(1).optional(),
  upToMessageId: z.string().min(1),
});
const CommunityMsgReactionsGetSchema = z.object({
  messageId: z.string().min(1),
  communityId: z.string().min(1),
});
const CommunityMsgForwardSchema = z.object({
  messageId: z.string().min(1),
  communityId: z.string().min(1),
  targetCommunityId: z.string().min(1),
  targetRoomId: z.string().min(1).optional(),
  clientMessageId: z.string().min(1),
});
const CommunityMsgDeliveredSchema = z.object({
  communityId: z.string().min(1),
  roomId: z.string().min(1).optional(),
  upToMessageId: z.string().min(1),
});
interface RedisSocketEvent {
  event: string;
  data: unknown;
}

export function registerCommunityNamespace(
  io: SocketIOServer,
  communityClient: CommunityClient,
  redisSub: Redis,
  redisPub: Redis,
  userClient: UserClient,
  mediaClient: MediaClient
): void {
  const community: Namespace = io.of("/community");
  community.use(gatewaySocketAuthMiddleware);

  // Dedicated subscriber for community channels.
  // Backend services publish: { event: "community:message:new"|"community:member:joined", data: {...} }
  // to Redis channel community:<communityId>.
  // Also subscribe to user:* so community:read_sync events reach the reader's own devices.
  void redisSub.psubscribe("community:*");
  void redisSub.psubscribe("user:*");
  redisSub.on(
    "pmessage",
    (pattern: string, channel: string, message: string) => {
      // user:* relay: only forward community-scoped events to avoid cross-firing
      // chat-service events (e.g. message:new for private rooms) onto /community.
      if (pattern === "user:*") {
        try {
          const parsed = JSON.parse(message) as RedisSocketEvent;
          if ((parsed.event as string).startsWith("community:")) {
            const viewerUserId = channel.slice("user:".length);
            // ── Stream live indicator debug log ─────────────────────────────
            if (
              parsed.event === "community:stream:started" ||
              parsed.event === "community:stream:ended"
            ) {
              const d = parsed.data as {
                communityId?: string;
                streamId?: string;
              };
              logger.info(
                `🔴 [STREAM:GATEWAY:USER] user:* relay event=${parsed.event} userId=${viewerUserId} communityId=${d.communityId ?? "?"} → emitting to Socket.IO room="user:${viewerUserId}"`
              );
            }
            const payload =
              parsed.event === "community:message:new"
                ? personalizeCommunitySocketMessage(parsed.data, viewerUserId)
                : parsed.data;
            community.to(channel).emit(parsed.event, payload);
          }
        } catch (err) {
          logger.warn(
            `/community Redis user:* parse error on ${channel}: ${String(err)}`
          );
        }
        return;
      }
      if (pattern !== "community:*") return;
      try {
        const parsed = JSON.parse(message) as RedisSocketEvent;
        // ── Stream live indicator debug logs ─────────────────────────────────
        if (
          parsed.event === "community:stream:started" ||
          parsed.event === "community:stream:ended"
        ) {
          const d = parsed.data as { communityId?: string; streamId?: string };
          logger.info(
            `🔴 [STREAM:GATEWAY] Redis pmessage received event=${parsed.event} channel=${channel} communityId=${d.communityId ?? "?"} streamId=${d.streamId ?? "?"}`
          );
          logger.info(
            `🔴 [STREAM:GATEWAY] emitting ${parsed.event} to Socket.IO room="${channel}" (sockets in room must have called community:join)`
          );
        }
        if (parsed.event === "community:message:new") {
          void (async () => {
            try {
              const sockets = await community.in(channel).fetchSockets();
              for (const socket of sockets) {
                const viewerUserId = String(socket.data.userId ?? "");
                socket.emit(
                  parsed.event,
                  personalizeCommunitySocketMessage(parsed.data, viewerUserId)
                );
              }
            } catch (emitErr) {
              logger.warn(
                `/community personalized emit failed on ${channel}: ${String(emitErr)}`
              );
              community.to(channel).emit(parsed.event, parsed.data);
            }
          })();
        } else {
          community.to(channel).emit(parsed.event, parsed.data);
        }

        // Evict-on-removal: when a member is removed (banned/kicked/left), force
        // their live sockets out of the broadcast room in real time so a BANNED
        // user stops receiving community events immediately — defense-in-depth
        // alongside the community:join ban gate (which stops them on reconnect).
        if (parsed.event === "community:member:removed") {
          const removedUserId = (parsed.data as { userId?: string } | null)
            ?.userId;
          if (removedUserId) {
            void (async () => {
              try {
                const sockets = await community.in(channel).fetchSockets();
                for (const s of sockets) {
                  if (s.data.userId === removedUserId) {
                    void s.leave(channel);
                  }
                }
              } catch (evictErr) {
                logger.warn(
                  `/community evict-on-removed failed channel=${channel} user=${removedUserId}: ${String(evictErr)}`
                );
              }
            })();
          }
        }
      } catch (err) {
        logger.warn(
          `/community Redis message parse error on ${channel}: ${String(err)}`
        );
      }
    }
  );

  community.on("connection", (socket: Socket) => {
    const { userId, locale } = socket.data;
    void socket.join(`user:${userId}`);
    logger.debug(`/community connected userId=${userId}`);

    // Resolve sender identity ONCE per connection (gRPC snapshot + avatar
    // presign) so typing broadcasts carry userDetails without a per-event fetch.
    // Fire-and-forget: a safe default is set immediately and overwritten when
    // the resolved value is ready, keeping connect latency zero.
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

    // ── Typing indicator (mirrors /chat) ────────────────────────────────────
    // Fire-and-forget (no ack). Server holds a 6 s countdown per communityId;
    // if typing:stop is never received the timer fires the stop automatically.
    // On disconnect all pending timers are flushed and stops are broadcast.
    const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const clearTyping = (communityId: string): void => {
      const t = typingTimers.get(communityId);
      if (t !== undefined) {
        clearTimeout(t);
        typingTimers.delete(communityId);
      }
    };
    const communityTypingPayload = (communityId: string, senderName?: string) =>
      buildTypingBroadcast(
        userId,
        socket.data.userDetails,
        communityId,
        Date.now(),
        { senderName, communityId }
      );

    // ── FIRE-AND-FORGET (NO ACK) — FE must not pass a callback ──────────────────
    // These events have NO ack callback. If FE waits for ack, the typing indicator
    // will never appear. Emit without callback: socket.emit("typing:start", payload)
    socket.on("typing:start", (payload: unknown) => {
      const r = CommunityTypingSchema.safeParse(payload);
      if (!r.success) return; // Invalid payload is silently dropped (no ack to send)
      const { communityId, senderName } = r.data;
      clearTyping(communityId);
      community
        .to(`community:${communityId}`)
        .emit("typing:start", communityTypingPayload(communityId, senderName));
      typingTimers.set(
        communityId,
        setTimeout(() => {
          typingTimers.delete(communityId);
          community
            .to(`community:${communityId}`)
            .emit("typing:stop", communityTypingPayload(communityId));
        }, 6000)
      );
    });

    // ── FIRE-AND-FORGET (NO ACK) ──────────────────────────────────────────────
    socket.on("typing:stop", (payload: unknown) => {
      const r = CommunityTypingSchema.safeParse(payload);
      if (!r.success) return; // Invalid payload is silently dropped
      const { communityId, senderName } = r.data;
      clearTyping(communityId);
      community
        .to(`community:${communityId}`)
        .emit("typing:stop", communityTypingPayload(communityId, senderName));
    });

    socket.on(
      "community:join",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityJoinSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        const communityId = r.data.communityId;
        void (async () => {
          // Ban gate: a BANNED user must not enter the broadcast room (and thus
          // must not receive messages / member events / typing). Only an explicit
          // BANNED verdict rejects — on a gRPC/breaker failure we fail OPEN (join
          // allowed) because the act-vector (send/edit/react) is independently
          // hard-blocked at chat-service, so the only risk of a transient failure
          // is a brief receive-side leak, not an integrity breach.
          try {
            const m = await communityClient.checkCommunityMembership({
              communityId,
              userId,
            });
            if (m.isBanned) {
              ackError(callback, "FORBIDDEN", locale);
              return;
            }
          } catch (err) {
            logger.warn(
              `/community join membership check failed (fail-open) community=${communityId} user=${userId}: ${String(err)}`
            );
          }
          void socket.join(`community:${communityId}`);
          ackOk(callback, "SOCKET_COMMUNITY_JOINED", locale);
        })();
      }
    );

    socket.on(
      "community:leave",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityLeaveSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        void socket.leave(`community:${r.data.communityId}`);
        ackOk(callback, "SOCKET_COMMUNITY_LEFT", locale);
      }
    );

    socket.on(
      "community:message:send",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityMsgSendSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .sendCommunityMessage({
            communityId: r.data.communityId,
            roomId: r.data.roomId ?? r.data.communityId,
            senderId: userId,
            clientMessageId: r.data.clientMessageId,
            // Cross-namespace parity: accept contentText as an alias for message.
            message: r.data.message || r.data.contentText || "",
            contentType: r.data.contentType,
            // Cross-namespace parity: accept top-level files[] as alias for media.files[].
            mediaFiles: r.data.media?.files ?? r.data.files,
            location: r.data.location,
            contact: r.data.contact,
            sticker: r.data.sticker,
            parentMessageId: r.data.parentMessageId,
          })
          .then((result) =>
            ackOk(callback, "SOCKET_COMMUNITY_MESSAGE_SENT", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/community message:send gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    socket.on(
      "community:messages:fetch",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityMsgsFetchSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .getCommunityMessages({ ...r.data, requesterId: userId })
          .then((result) => {
            // Reshape each gRPC DTO into the wire shape the FE expects.
            // Real-time sends use `content: { text, files }` — history fetch
            // must match that shape so mapCommunityMessage renders images.
            const messages = result.messages.map((m) => {
              let files: unknown[] = [];
              if (m.attachmentsJson) {
                try {
                  const parsed = JSON.parse(m.attachmentsJson) as unknown[];
                  if (Array.isArray(parsed)) files = parsed;
                } catch (err) {
                  logger.error(
                    "Failed to parse attachmentsJson from community message:",
                    err
                  );
                }
              }
              if (files.length === 0 && m.mediaKey) {
                files = [{ url: m.mediaKey }];
              }

              let reactions: unknown[] = [];
              if (m.reactionsJson) {
                try {
                  const parsed = JSON.parse(m.reactionsJson) as unknown[];
                  if (Array.isArray(parsed)) reactions = parsed;
                } catch (err) {
                  logger.error(
                    "Failed to parse reactionsJson from community message:",
                    err
                  );
                }
              }

              let quoteData: unknown = null;
              if (m.quoteDataJson) {
                try {
                  quoteData = JSON.parse(m.quoteDataJson);
                } catch (err) {
                  logger.error(
                    "Failed to parse quoteDataJson from community message:",
                    err
                  );
                }
              }

              return {
                id: m.messageId,
                messageId: m.messageId,
                roomId: m.roomId,
                senderId: m.senderId,
                senderName: m.senderName || undefined,
                senderAvatar: m.senderAvatar || undefined,
                contentType: m.contentType,
                content: {
                  text: m.message || undefined,
                  files: files.length > 0 ? files : undefined,
                },
                message: m.message,
                reactions,
                quoteData: quoteData || undefined,
                sentAt: m.sentAt,
              };
            });
            console.log(
              "[community:messages:fetch] first raw gRPC msg:",
              JSON.stringify(result.messages[0], null, 2)
            );
            console.log(
              "[community:messages:fetch] first transformed msg:",
              JSON.stringify(messages[0], null, 2)
            );
            return ackOk(
              callback,
              "SOCKET_COMMUNITY_MESSAGES_FETCHED",
              locale,
              {
                messages,
                nextCursor: result.nextCursor,
                hasMore: result.hasMore,
              }
            );
          })
          .catch((err: unknown) => {
            logger.warn(`/community messages:fetch gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    socket.on(
      "community:message:react",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityMsgReactSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .reactToCommunityMessage({ ...r.data, userId })
          .then((result) =>
            ackOk(callback, "SOCKET_COMMUNITY_MESSAGE_REACTED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/community message:react gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    // Reconnect gap-fill: fetch missed messages per community room since a
    // known message id. Mirrors chat:catchup for private/group rooms.
    socket.on(
      "community:catchup",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const parsed = CommunityCatchupSchema.safeParse(payload);
        if (!parsed.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        void (async () => {
          const rooms = parsed.data.rooms;
          const results = await Promise.allSettled(
            rooms.map((room) =>
              communityClient.communityCatchup({
                roomId: room.roomId,
                requesterId: userId,
                sinceId: room.sinceId ?? "",
                limit: room.limit ?? 100,
                sinceTs: room.sinceTs,
              })
            )
          );

          const ackRooms: Array<{
            roomId: string;
            hasMore: boolean;
            lastId: string;
            nextTs: number;
            authorized: boolean;
          }> = [];

          results.forEach((res, idx) => {
            const room = rooms[idx]!;
            if (res.status === "fulfilled") {
              const r = res.value;
              socket.emit("community:catchup:result", {
                roomId: room.roomId,
                events: r.events.map((e) => ({
                  ...e,
                  sentAt: Number(e.sentAt),
                  editedAt: Number(e.editedAt),
                  reactions: e.reactions ?? [],
                })),
                hasMore: r.hasMore,
                lastId: r.lastId,
                nextTs: Number(r.nextTs ?? 0),
              });
              ackRooms.push({
                roomId: room.roomId,
                hasMore: r.hasMore,
                lastId: r.lastId,
                nextTs: Number(r.nextTs ?? 0),
                authorized: r.authorized,
              });
            } else {
              logger.warn(
                `/community community:catchup gRPC error for room ${room.roomId}: ${String(res.reason)}`
              );
            }
          });

          ackOk(callback, "SOCKET_COMMUNITY_CATCHUP_COMPLETED", locale, {
            rooms: ackRooms,
          });
        })();
      }
    );

    socket.on(
      "community:message:edit",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityMsgEditSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .editCommunityMessage({
            messageId: r.data.messageId,
            communityId: r.data.communityId,
            userId,
            text: r.data.content.text,
          })
          .then((result) =>
            ackOk(callback, "SOCKET_COMMUNITY_MESSAGE_EDITED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/community message:edit gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    socket.on(
      "community:message:delete",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityMsgDeleteSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .deleteCommunityMessage({
            messageId: r.data.messageId,
            communityId: r.data.communityId,
            userId,
            deleteType: r.data.type,
          })
          .then((result) =>
            ackOk(callback, "SOCKET_COMMUNITY_MESSAGE_DELETED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/community message:delete gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    socket.on(
      "community:message:pin",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityMsgPinSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .pinCommunityMessage({
            ...r.data,
            roomId: r.data.roomId ?? r.data.communityId,
            userId,
          })
          .then((result) =>
            ackOk(callback, "SOCKET_COMMUNITY_MESSAGE_PINNED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/community message:pin gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    socket.on(
      "community:message:unpin",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityMsgUnpinSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .unpinCommunityMessage({
            ...r.data,
            roomId: r.data.roomId ?? r.data.communityId,
            userId,
          })
          .then((result) =>
            ackOk(callback, "SOCKET_COMMUNITY_MESSAGE_UNPINNED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/community message:unpin gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    // ── Moderation ────────────────────────────────────────────────────────────
    // All moderation actions are authorised server-side (community-service checks
    // the actor's role). The gateway passes the authenticated userId as actorId
    // so clients cannot impersonate another actor.

    socket.on(
      "community.member.kick",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = KickMemberSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .kickMember({ ...r.data, actorId: userId })
          .then((result) =>
            result.ok
              ? ackOk(
                  callback,
                  "SOCKET_COMMUNITY_MEMBER_KICKED",
                  locale,
                  result
                )
              : ackError(callback, "FORBIDDEN", locale)
          )
          .catch((err: unknown) => {
            logger.warn(`/community member.kick gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    socket.on(
      "community.member.ban",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = BanMemberSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .banMember({ ...r.data, actorId: userId })
          .then((result) =>
            result.ok
              ? ackOk(
                  callback,
                  "SOCKET_COMMUNITY_MEMBER_BANNED",
                  locale,
                  result
                )
              : ackError(callback, "FORBIDDEN", locale)
          )
          .catch((err: unknown) => {
            logger.warn(`/community member.ban gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    socket.on(
      "community.member.unban",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = UnbanMemberSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .unbanMember({ ...r.data, actorId: userId })
          .then((result) =>
            result.ok
              ? ackOk(
                  callback,
                  "SOCKET_COMMUNITY_MEMBER_UNBANNED",
                  locale,
                  result
                )
              : ackError(callback, "FORBIDDEN", locale)
          )
          .catch((err: unknown) => {
            logger.warn(`/community member.unban gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    socket.on(
      "community.admin.transfer",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = TransferAdminSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .transferAdmin({ ...r.data, actorId: userId })
          .then((result) =>
            result.ok
              ? ackOk(
                  callback,
                  "SOCKET_COMMUNITY_ADMIN_TRANSFERRED",
                  locale,
                  result
                )
              : ackError(callback, "FORBIDDEN", locale)
          )
          .catch((err: unknown) => {
            logger.warn(`/community admin.transfer gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    socket.on(
      "community.member.role_change",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = ChangeMemberRoleSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .changeMemberRole({ ...r.data, actorId: userId })
          .then((result) =>
            result.ok
              ? ackOk(callback, "SOCKET_COMMUNITY_ROLE_CHANGED", locale, result)
              : ackError(callback, "FORBIDDEN", locale)
          )
          .catch((err: unknown) => {
            logger.warn(
              `/community member.role_change gRPC error: ${String(err)}`
            );
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    socket.on(
      "community.report.create",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CreateReportSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .createReport({ ...r.data, reporterId: userId })
          .then((result) =>
            result.ok
              ? ackOk(
                  callback,
                  "SOCKET_COMMUNITY_REPORT_CREATED",
                  locale,
                  result
                )
              : ackError(callback, "SERVICE_ERROR", locale)
          )
          .catch((err: unknown) => {
            logger.warn(`/community report.create gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    socket.on(
      "community.delete",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = DeleteCommunitySchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .deleteCommunity({ ...r.data, actorId: userId })
          .then((result) => {
            if (!result.ok) {
              ackError(callback, "FORBIDDEN", locale);
              return;
            }
            // Broadcast deletion to all community members before acking.
            community
              .to(`community:${r.data.communityId}`)
              .emit("community.deleted", {
                communityId: r.data.communityId,
                deletedBy: userId,
              });
            ackOk(callback, "SOCKET_COMMUNITY_DELETED", locale, result);
          })
          .catch((err: unknown) => {
            logger.warn(`/community delete gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    // ── community:message:read ─────────────────────────────────────────────────
    socket.on(
      "community:message:read",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityMsgReadSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .markCommunityMessageRead({
            communityId: r.data.communityId,
            roomId: r.data.roomId ?? r.data.communityId,
            readerId: userId,
            upToMessageId: r.data.upToMessageId,
          })
          .then((result) =>
            ackOk(callback, "SOCKET_COMMUNITY_MESSAGE_READ", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/community message:read gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    // ── community:message:reactions:get ───────────────────────────────────────
    socket.on(
      "community:message:reactions:get",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityMsgReactionsGetSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .getCommunityMessageReactions({ ...r.data, requesterId: userId })
          .then((result) =>
            ackOk(
              callback,
              "SOCKET_COMMUNITY_REACTIONS_FETCHED",
              locale,
              result
            )
          )
          .catch((err: unknown) => {
            logger.warn(
              `/community message:reactions:get gRPC error: ${String(err)}`
            );
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    // ── community:message:forward ──────────────────────────────────────────────
    socket.on(
      "community:message:forward",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityMsgForwardSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .forwardCommunityMessage({
            sourceMessageId: r.data.messageId,
            sourceCommunityId: r.data.communityId,
            targetCommunityId: r.data.targetCommunityId,
            targetRoomId: r.data.targetRoomId ?? r.data.targetCommunityId,
            senderId: userId,
            clientMessageId: r.data.clientMessageId,
          })
          .then((result) =>
            ackOk(
              callback,
              "SOCKET_COMMUNITY_MESSAGE_FORWARDED",
              locale,
              result
            )
          )
          .catch((err: unknown) => {
            logger.warn(
              `/community message:forward gRPC error: ${String(err)}`
            );
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    // ── community:message:delivered ───────────────────────────────────────────
    socket.on(
      "community:message:delivered",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityMsgDeliveredSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .markCommunityMessageDelivered({
            communityId: r.data.communityId,
            roomId: r.data.roomId ?? r.data.communityId,
            recipientId: userId,
            upToMessageId: r.data.upToMessageId,
          })
          .then((result) =>
            ackOk(
              callback,
              "SOCKET_COMMUNITY_MESSAGE_DELIVERED",
              locale,
              result
            )
          )
          .catch((err: unknown) => {
            logger.warn(
              `/community message:delivered gRPC error: ${String(err)}`
            );
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );

    // ── auth:refresh + session:expired ────────────────────────────────────────
    const {
      clearSessionTimers,
      scheduleSessionTimers,
      registerAuthRefreshHandler,
    } = createSessionTimers(socket, locale, "/community", env.AUTH_SERVICE_URL);

    if (socket.data.tokenExpiresAt > 0) {
      scheduleSessionTimers(socket.data.tokenExpiresAt);
    }
    registerAuthRefreshHandler();

    socket.on("disconnect", (reason: string) => {
      logger.debug(`/community disconnected userId=${userId} reason=${reason}`);

      // Clear session expiry timers.
      clearSessionTimers();

      // Flush all pending typing-expiry timers and broadcast stop so members are
      // never stuck with a "typing…" indicator after the socket closes.
      for (const [communityId, timer] of typingTimers) {
        clearTimeout(timer);
        community
          .to(`community:${communityId}`)
          .emit("typing:stop", communityTypingPayload(communityId));
      }
      typingTimers.clear();
    });
  });
}
