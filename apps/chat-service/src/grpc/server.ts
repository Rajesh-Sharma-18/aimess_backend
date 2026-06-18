import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { logger } from "@aimess/logger";
import {
  createMessagingImpl,
  createCommunityImpl,
  createNotificationImpl,
} from "./service-impl.js";
import type { GrpcDeps } from "./service-impl.js";

export type { GrpcDeps };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/messaging.proto"
);
const COMMUNITY_PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/community.proto"
);
const NOTIFICATION_PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/notification.proto"
);

export function startGrpcServer(port: number, deps: GrpcDeps): grpc.Server {
  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
  const MessagingService = (proto["messaging"] as grpc.GrpcObject)[
    "MessagingService"
  ] as unknown as grpc.ServiceClientConstructor;

  const communityPkgDef = protoLoader.loadSync(COMMUNITY_PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const communityProto = grpc.loadPackageDefinition(
    communityPkgDef
  ) as grpc.GrpcObject;
  const CommunityService = (communityProto["community"] as grpc.GrpcObject)[
    "CommunityService"
  ] as unknown as grpc.ServiceClientConstructor;

  const notificationPkgDef = protoLoader.loadSync(NOTIFICATION_PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const notificationProto = grpc.loadPackageDefinition(
    notificationPkgDef
  ) as grpc.GrpcObject;
  const NotificationGrpcService = (
    notificationProto["notification"] as grpc.GrpcObject
  )["NotificationService"] as unknown as grpc.ServiceClientConstructor;

  const server = new grpc.Server();
  server.addService(MessagingService.service, createMessagingImpl(deps));
  server.addService(CommunityService.service, createCommunityImpl(deps));
  server.addService(
    NotificationGrpcService.service,
    createNotificationImpl(deps)
  );

  server.bindAsync(
    `0.0.0.0:${port}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        logger.error(`chat-service gRPC failed to bind: ${err.message}`);
        return;
      }
      logger.info(`chat-service gRPC server listening on port ${boundPort}`);
    }
  );

  return server;
}
