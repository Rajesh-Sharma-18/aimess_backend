import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { logger } from "@aimess/logger";

import { communityRepository } from "../repositories/community.repository.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/community.proto"
);

const communityImpl: grpc.UntypedServiceImplementation = {
  sendCommunityMessage: (
    _call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => callback(null, { messageId: "", roomId: "", sentAt: 0 }),

  getCommunityMessages: (
    _call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => callback(null, { messages: [], nextCursor: "", hasMore: false }),

  // Reconciliation pull: chat-service lists communities (+ members) on boot to
  // provision any missing chat rooms / sync RoomMember rows. Cursor on community id.
  listCommunities: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as { afterId?: string; limit?: number };
        const limit =
          req.limit && req.limit > 0 ? Math.min(req.limit, 200) : 100;
        // Over-fetch one for an exact hasMore.
        const rows = await communityRepository.listForReconciliation({
          afterId: req.afterId || null,
          limit: limit + 1,
        });
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        callback(null, {
          communities: page.map((c) => ({
            id: c.id,
            name: c.name,
            adminId: c.adminId,
            avatarUrl: c.avatarUrl ?? "",
            deleted: c.deletedAt != null,
            members: c.members.map((m) => ({
              userId: m.userId,
              status: String(m.status),
              role: String(m.role),
              joinedAt: m.joinedAt instanceof Date ? m.joinedAt.getTime() : 0,
            })),
          })),
          nextAfterId: hasMore && last ? last.id : "",
          hasMore,
        });
      } catch (err) {
        logger.error("listCommunities gRPC handler failed", err);
        callback({
          code: grpc.status.INTERNAL,
          message: "listCommunities failed",
        } as grpc.ServiceError);
      }
    })();
  },
};

export function startGrpcServer(port: number): grpc.Server {
  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
  const CommunityService = (proto["community"] as grpc.GrpcObject)[
    "CommunityService"
  ] as unknown as grpc.ServiceClientConstructor;

  const server = new grpc.Server();
  server.addService(CommunityService.service, communityImpl);

  server.bindAsync(
    `0.0.0.0:${port}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        logger.error(`community-service gRPC failed to bind: ${err.message}`);
        return;
      }
      logger.info(
        `community-service gRPC server listening on port ${boundPort}`
      );
    }
  );

  return server;
}
