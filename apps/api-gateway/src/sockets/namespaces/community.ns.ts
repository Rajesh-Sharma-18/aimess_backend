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
const CommunityMsgSendSchema = z.object({
  communityId: z.string().min(1),
  roomId: z.string().min(1),
  clientMessageId: z.string().min(1),
  message: z.string().min(1),
  contentType: z.string().min(1),
  mediaKey: z.string().optional(),
});
const CommunityMsgsFetchSchema = z.object({
  roomId: z.string().min(1),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
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
          .sendCommunityMessage({ ...r.data, senderId: userId })
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

    socket.on("disconnect", (reason: string) => {
      logger.debug(`/community disconnected userId=${userId} reason=${reason}`);
    });
  });
}
