import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { logger } from "@aimess/logger";
import { withServiceAuth } from "@aimess/grpc-utils";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/notification.proto"
);

const notificationImpl: grpc.UntypedServiceImplementation = {
  getNotifications: (
    _call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) =>
    callback(null, {
      notifications: [],
      nextCursor: "",
      hasMore: false,
      unreadCount: 0,
    }),

  markNotificationsRead: (
    _call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => callback(null, { updatedCount: 0, remainingUnread: 0 }),
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
  const NotificationService = (proto["notification"] as grpc.GrpcObject)[
    "NotificationService"
  ] as unknown as grpc.ServiceClientConstructor;

  const server = new grpc.Server();
  server.addService(
    NotificationService.service,
    withServiceAuth("notifications-service", notificationImpl)
  );

  server.bindAsync(
    `0.0.0.0:${port}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        logger.error(
          `notifications-service gRPC failed to bind: ${err.message}`
        );
        return;
      }
      logger.info(
        `notifications-service gRPC server listening on port ${boundPort}`
      );
    }
  );

  return server;
}
