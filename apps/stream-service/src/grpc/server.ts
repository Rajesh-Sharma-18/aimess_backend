import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { logger } from "@aimess/logger";

import type { LivestreamCommentService } from "../services/livestream-comment.service.js";
import type { LivestreamService } from "../services/livestream.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/stream.proto"
);

export interface GrpcDeps {
  commentService: LivestreamCommentService;
  livestreamService: LivestreamService;
}

function createStreamImpl(deps: GrpcDeps): grpc.UntypedServiceImplementation {
  return {
    // PostComment — persist + broadcast a livestream comment (idempotent).
    postComment: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            livestreamId: string;
            userId: string;
            message: string;
            clientCommentId?: string;
          };
          const dto = await deps.commentService.addComment({
            livestreamId: req.livestreamId,
            userId: req.userId,
            message: req.message,
            clientCommentId: req.clientCommentId || null,
          });
          callback(null, {
            comment: {
              id: dto.id,
              sentBy: dto.sentBy,
              senderName: dto.senderName,
              senderAvatar: dto.senderAvatar,
              message: dto.message,
              createdAt: dto.createdAt.getTime(),
            },
          });
        } catch (err) {
          logger.error(`gRPC postComment error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // GetComments — newest-first cursor page.
    getComments: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            livestreamId: string;
            limit?: number;
            before?: string;
            after?: string;
          };
          const limit = req.limit && req.limit > 0 ? req.limit : 30;
          const result = await deps.commentService.getComments(
            req.livestreamId,
            {
              limit,
              before: req.before || undefined,
              after: req.after || undefined,
            }
          );
          callback(null, {
            comments: result.items.map((c) => ({
              id: c.id,
              sentBy: c.sentBy,
              senderName: c.senderName,
              senderAvatar: c.senderAvatar,
              message: c.message,
              createdAt: c.createdAt.getTime(),
            })),
            nextCursor: result.nextCursor ?? "",
            hasMore: result.hasMore,
          });
        } catch (err) {
          logger.error(`gRPC getComments error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // GetActiveStreamsByCommunityIds — which communities currently have LIVE.
    getActiveStreamsByCommunityIds: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as { communityIds?: string[] };
          const liveCommunityIds =
            await deps.livestreamService.getActiveStreamsByCommunityIds(
              Array.isArray(req.communityIds) ? req.communityIds : []
            );
          callback(null, { liveCommunityIds });
        } catch (err) {
          logger.error(
            `gRPC getActiveStreamsByCommunityIds error: ${String(err)}`
          );
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // CheckStreamAccess — join gate: ACTIVE membership (when required) + not banned.
    checkStreamAccess: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as { streamId: string; userId: string };
          const access = await deps.livestreamService.checkAccess(
            req.streamId,
            req.userId
          );
          callback(null, {
            allowed: access.allowed,
            isBanned: access.isBanned,
            status: access.status,
            reason: access.reason,
            canComment: access.canComment,
          });
        } catch (err) {
          logger.error(`gRPC checkStreamAccess error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // AdminUpdateThumbnail — admin sets or clears a stream thumbnail object key.
    adminUpdateThumbnail: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as { streamId: string; thumbnail: string };
          await deps.livestreamService.adminUpdateThumbnail(
            req.streamId,
            req.thumbnail || null
          );
          callback(null, { success: true });
        } catch (err) {
          logger.error(`gRPC adminUpdateThumbnail error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // GetStreamStats — live viewer stats for the backoffice dashboard.
    getStreamStats: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as { streamId: string };
          const stats =
            await deps.livestreamService.getStreamStatsForBackoffice(
              req.streamId
            );
          callback(null, {
            found: stats.found,
            status: stats.status,
            viewerCount: stats.viewerCount,
            peakViewers: stats.peakViewers,
            totalViews: stats.totalViews,
            totalComments: stats.totalComments,
          });
        } catch (err) {
          logger.error(`gRPC getStreamStats error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    adminForceEnd: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as { streamId: string; reason: string };
          const result = await deps.livestreamService.adminForceEnd(
            req.streamId,
            req.reason ?? ""
          );
          callback(null, { success: result.success, status: result.status });
        } catch (err) {
          logger.error(`gRPC adminForceEnd error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // GetLiveStreamsByCommunity — live stream list for community detail enrichment.
    getLiveStreamsByCommunity: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as { communityId?: string };
          const communityId = req.communityId ?? "";
          if (!communityId) {
            callback(null, { streams: [] });
            return;
          }
          const result = await deps.livestreamService.listStreams({
            communityId,
            status: "LIVE",
            limit: 20,
          });
          callback(null, {
            streams: result.items.map((s) => ({
              id: s.id,
              title: s.title,
              thumbnail: s.thumbnail ?? "",
              creatorId: s.creatorId,
              hlsUrl: s.hlsUrl ?? "",
              flvUrl: s.flvUrl ?? "",
              dashUrl: s.dashUrl ?? "",
              viewerCount: s.viewerCount,
              livedAt: s.livedAt ? s.livedAt.getTime() : 0,
            })),
          });
        } catch (err) {
          logger.error(`gRPC getLiveStreamsByCommunity error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    deleteComment: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            commentId: string;
            requesterId: string;
          };
          const result = await deps.commentService.deleteComment(
            req.commentId,
            req.requesterId
          );
          callback(null, {
            success: true,
            commentId: result.commentId,
            livestreamId: result.livestreamId,
          });
        } catch (err: unknown) {
          logger.error(`gRPC deleteComment error: ${String(err)}`);
          const name = (err as { name?: string }).name;
          if (name === "NotFoundError") {
            callback({ code: grpc.status.NOT_FOUND, message: String(err) });
          } else if (name === "ForbiddenError") {
            callback({
              code: grpc.status.PERMISSION_DENIED,
              message: String(err),
            });
          } else {
            callback({ code: grpc.status.INTERNAL, message: String(err) });
          }
        }
      })();
    },
  };
}

export function startGrpcServer(port: number, deps: GrpcDeps): grpc.Server {
  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
  const StreamService = (proto["stream"] as grpc.GrpcObject)[
    "StreamService"
  ] as unknown as grpc.ServiceClientConstructor;

  const server = new grpc.Server();
  server.addService(StreamService.service, createStreamImpl(deps));

  server.bindAsync(
    `0.0.0.0:${port}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        logger.error(`stream-service gRPC failed to bind: ${err.message}`);
        return;
      }
      logger.info(`stream-service gRPC server listening on port ${boundPort}`);
    }
  );

  return server;
}
