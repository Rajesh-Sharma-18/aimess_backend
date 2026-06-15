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
          };
          const limit = req.limit && req.limit > 0 ? req.limit : 30;
          const result = await deps.commentService.getComments(
            req.livestreamId,
            { limit, before: req.before || undefined }
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
