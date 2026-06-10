import type { Server as SocketIOServer, Namespace, Socket } from "socket.io";
import type { Redis } from "ioredis";
import { z } from "zod";
import { logger } from "@aimess/logger";
import { gatewaySocketAuthMiddleware } from "../auth.middleware.js";
import type { CommunityClient } from "../../grpc/clients/community.client.js";

const CommunityJoinSchema = z.object({
  communityId: z.string().min(1),
  roomId: z.string().min(1),
});
const CommunityLeaveSchema = z.object({ communityId: z.string().min(1) });
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
  roomId: z.string().min(1),
  clientMessageId: z.string().optional(),
  message: z.string().default(""),
  contentType: z
    .string()
    .min(1)
    .transform((v) => v.toUpperCase()),
  media: z.object({ files: z.array(CommunityMsgSendFileSchema) }).optional(),
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
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});
const CommunityMsgReactSchema = z.object({
  messageId: z.string().min(1),
  communityId: z.string().min(1),
  emoji: z.string().min(1),
});
const CommunityCatchupRoomSchema = z.object({
  roomId: z.string().min(1),
  sinceId: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
  /**
   * Epoch-ms (positive integer). When provided the server switches to an
   * updatedAt-based query that surfaces edits, reaction changes, and
   * tombstones — ideal for returning from the background.
   * Mutually exclusive with sinceId; sinceTs takes precedence when both given.
   */
  sinceTs: z.number().int().positive().optional(),
});
const CommunityCatchupSchema = z.object({
  rooms: z.array(CommunityCatchupRoomSchema).min(1).max(20),
});

const CommunityMsgEditSchema = z.object({
  messageId: z.string().min(1),
  communityId: z.string().min(1),
  roomId: z.string().min(1),
  content: z.object({ text: z.string().min(1).max(4000) }),
});

const CommunityMsgDeleteSchema = z.object({
  messageId: z.string().min(1),
  communityId: z.string().min(1),
  roomId: z.string().min(1),
  type: z.enum(["forEveryone", "forMe"]),
});

const CommunityMsgPinSchema = z.object({
  messageId: z.string().min(1),
  communityId: z.string().min(1),
  roomId: z.string().min(1),
});

const CommunityMsgUnpinSchema = z.object({
  messageId: z.string().min(1),
  communityId: z.string().min(1),
  roomId: z.string().min(1),
});

interface RedisSocketEvent {
  event: string;
  data: unknown;
}

export function registerCommunityNamespace(
  io: SocketIOServer,
  communityClient: CommunityClient,
  redisSub: Redis
): void {
  const community: Namespace = io.of("/community");
  community.use(gatewaySocketAuthMiddleware);

  // Dedicated subscriber for community channels.
  // Backend services publish: { event: "community:message:new"|"community:member:joined", data: {...} }
  // to Redis channel community:<communityId>.
  void redisSub.psubscribe("community:*");
  redisSub.on(
    "pmessage",
    (pattern: string, channel: string, message: string) => {
      if (pattern !== "community:*") return;
      try {
        const parsed = JSON.parse(message) as RedisSocketEvent;
        community.to(channel).emit(parsed.event, parsed.data);
      } catch (err) {
        logger.warn(
          `/community Redis message parse error on ${channel}: ${String(err)}`
        );
      }
    }
  );

  community.on("connection", (socket: Socket) => {
    const { userId } = socket.data;
    void socket.join(`user:${userId}`);
    logger.debug(`/community connected userId=${userId}`);

    socket.on("community:join", (payload: unknown) => {
      const r = CommunityJoinSchema.safeParse(payload);
      if (!r.success) return;
      void socket.join(`community:${r.data.communityId}`);
    });

    socket.on("community:leave", (payload: unknown) => {
      const r = CommunityLeaveSchema.safeParse(payload);
      if (!r.success) return;
      void socket.leave(`community:${r.data.communityId}`);
    });

    socket.on(
      "community:message:send",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const ack = typeof callback === "function" ? callback : () => undefined;
        const r = CommunityMsgSendSchema.safeParse(payload);
        if (!r.success) {
          ack({ success: false, error: "INVALID_PAYLOAD" });
          return;
        }
        communityClient
          .sendCommunityMessage({
            communityId: r.data.communityId,
            roomId: r.data.roomId,
            senderId: userId,
            clientMessageId: r.data.clientMessageId,
            message: r.data.message,
            contentType: r.data.contentType,
            mediaFiles: r.data.media?.files,
            location: r.data.location,
            contact: r.data.contact,
            sticker: r.data.sticker,
            parentMessageId: r.data.parentMessageId,
          })
          .then((result) => ack({ success: true, data: result }))
          .catch((err: unknown) => {
            logger.warn(`/community message:send gRPC error: ${String(err)}`);
            ack({ success: false, error: "SERVICE_ERROR" });
          });
      }
    );

    socket.on(
      "community:messages:fetch",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const ack = typeof callback === "function" ? callback : () => undefined;
        const r = CommunityMsgsFetchSchema.safeParse(payload);
        if (!r.success) {
          ack({ success: false, error: "INVALID_PAYLOAD" });
          return;
        }
        communityClient
          .getCommunityMessages({ ...r.data, requesterId: userId })
          .then((result) => ack({ success: true, data: result }))
          .catch((err: unknown) => {
            logger.warn(`/community messages:fetch gRPC error: ${String(err)}`);
            ack({ success: false, error: "SERVICE_ERROR" });
          });
      }
    );

    socket.on(
      "community:message:react",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const ack = typeof callback === "function" ? callback : () => undefined;
        const r = CommunityMsgReactSchema.safeParse(payload);
        if (!r.success) {
          ack({ success: false, error: "INVALID_PAYLOAD" });
          return;
        }
        communityClient
          .reactToCommunityMessage({ ...r.data, userId })
          .then((result) => ack({ success: true, data: result }))
          .catch((err: unknown) => {
            logger.warn(`/community message:react gRPC error: ${String(err)}`);
            ack({ success: false, error: "SERVICE_ERROR" });
          });
      }
    );

    // Reconnect gap-fill: fetch missed messages per community room since a
    // known message id. Mirrors chat:catchup for private/group rooms.
    socket.on(
      "community:catchup",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const ack = typeof callback === "function" ? callback : () => undefined;
        const parsed = CommunityCatchupSchema.safeParse(payload);
        if (!parsed.success) {
          ack({ success: false, error: "INVALID_PAYLOAD" });
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

          ack({ success: true, data: { rooms: ackRooms } });
        })();
      }
    );

    socket.on(
      "community:message:edit",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const ack = typeof callback === "function" ? callback : () => undefined;
        const r = CommunityMsgEditSchema.safeParse(payload);
        if (!r.success) {
          ack({ success: false, error: "INVALID_PAYLOAD" });
          return;
        }
        communityClient
          .editCommunityMessage({
            messageId: r.data.messageId,
            communityId: r.data.communityId,
            userId,
            text: r.data.content.text,
          })
          .then((result) => ack({ success: true, data: result }))
          .catch((err: unknown) => {
            logger.warn(`/community message:edit gRPC error: ${String(err)}`);
            ack({ success: false, error: "SERVICE_ERROR" });
          });
      }
    );

    socket.on(
      "community:message:delete",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const ack = typeof callback === "function" ? callback : () => undefined;
        const r = CommunityMsgDeleteSchema.safeParse(payload);
        if (!r.success) {
          ack({ success: false, error: "INVALID_PAYLOAD" });
          return;
        }
        communityClient
          .deleteCommunityMessage({
            messageId: r.data.messageId,
            communityId: r.data.communityId,
            userId,
            deleteType: r.data.type,
          })
          .then((result) => ack({ success: true, data: result }))
          .catch((err: unknown) => {
            logger.warn(`/community message:delete gRPC error: ${String(err)}`);
            ack({ success: false, error: "SERVICE_ERROR" });
          });
      }
    );

    socket.on(
      "community:message:pin",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const ack = typeof callback === "function" ? callback : () => undefined;
        const r = CommunityMsgPinSchema.safeParse(payload);
        if (!r.success) {
          ack({ success: false, error: "INVALID_PAYLOAD" });
          return;
        }
        communityClient
          .pinCommunityMessage({ ...r.data, userId })
          .then((result) => ack({ success: true, data: result }))
          .catch((err: unknown) => {
            logger.warn(`/community message:pin gRPC error: ${String(err)}`);
            ack({ success: false, error: "SERVICE_ERROR" });
          });
      }
    );

    socket.on(
      "community:message:unpin",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const ack = typeof callback === "function" ? callback : () => undefined;
        const r = CommunityMsgUnpinSchema.safeParse(payload);
        if (!r.success) {
          ack({ success: false, error: "INVALID_PAYLOAD" });
          return;
        }
        communityClient
          .unpinCommunityMessage({ ...r.data, userId })
          .then((result) => ack({ success: true, data: result }))
          .catch((err: unknown) => {
            logger.warn(`/community message:unpin gRPC error: ${String(err)}`);
            ack({ success: false, error: "SERVICE_ERROR" });
          });
      }
    );

    socket.on("disconnect", (reason: string) => {
      logger.debug(`/community disconnected userId=${userId} reason=${reason}`);
    });
  });
}
