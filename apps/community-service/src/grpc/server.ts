import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { logger } from "@aimess/logger";

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
