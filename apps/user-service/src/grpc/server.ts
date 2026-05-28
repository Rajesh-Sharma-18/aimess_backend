import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { logger } from "@aimess/logger";
import { env } from "../config/env.js";
import { friendshipRepository } from "../repositories/friendship.repository.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/user.proto"
);

export function startUserGrpcServer(): grpc.Server {
  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });

  const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
  const UserService = (proto["user"] as grpc.GrpcObject)[
    "UserService"
  ] as unknown as grpc.ServiceClientConstructor;

  // With keepCase: false, proto fields user_a → userA, user_b → userB, are_friends → areFriends
  const userImpl: grpc.UntypedServiceImplementation = {
    checkFriendship: (
      call: grpc.ServerUnaryCall<{ userA: string; userB: string }, unknown>,
      callback: grpc.sendUnaryData<{ areFriends: boolean }>
    ) => {
      void (async () => {
        try {
          const { userA, userB } = call.request;
          const row = await friendshipRepository.findActivePair(userA, userB);
          callback(null, { areFriends: row !== null });
        } catch (err) {
          logger.error(`gRPC checkFriendship error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },
  };

  const server = new grpc.Server();
  server.addService(UserService.service, userImpl);

  server.bindAsync(
    `0.0.0.0:${env.USER_GRPC_PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        logger.error(`user-service gRPC failed to bind: ${err.message}`);
        return;
      }
      logger.info(
        `user-service gRPC server listening on port ${String(boundPort)}`
      );
    }
  );

  return server;
}
