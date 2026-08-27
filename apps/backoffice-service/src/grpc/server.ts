import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { logger } from "@aimess/logger";
import { withServiceAuth } from "@aimess/grpc-utils";

import { env } from "../config/env.js";
import { adminUserRepository } from "../repositories/admin-user.repository.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/backoffice.proto"
);

// Deleted admins count as taken: the row is kept for audit and its email must
// stay reserved, otherwise a user could claim a removed admin's address.
const backofficeImpl: grpc.UntypedServiceImplementation = {
  isAdminEmailTaken: (
    call: grpc.ServerUnaryCall<{ email?: string }, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const email = (call.request.email ?? "").trim().toLowerCase();
        if (!email) {
          callback(null, { taken: false });
          return;
        }
        const admin = await adminUserRepository.findByEmail(email);
        callback(null, { taken: admin !== null });
      } catch (error) {
        logger.error(error);
        callback({
          code: grpc.status.INTERNAL,
          message: "isAdminEmailTaken failed",
        } as grpc.ServiceError);
      }
    })();
  },
};

export function startBackofficeGrpcServer(): grpc.Server {
  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });

  const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
  const BackofficeService = (proto["backoffice"] as grpc.GrpcObject)[
    "BackofficeService"
  ] as unknown as grpc.ServiceClientConstructor;

  const server = new grpc.Server();
  server.addService(
    BackofficeService.service,
    withServiceAuth("backoffice-service", backofficeImpl)
  );

  server.bindAsync(
    `0.0.0.0:${String(env.BACKOFFICE_GRPC_PORT)}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        logger.error(`backoffice-service gRPC failed to bind: ${err.message}`);
        return;
      }
      logger.info(
        `backoffice-service gRPC server listening on port ${String(boundPort)}`
      );
    }
  );

  return server;
}
