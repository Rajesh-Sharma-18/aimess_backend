import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { logger } from "@aimess/logger";

import { env } from "../config/env.js";
import { mediaImpl } from "./handlers/media.handler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/media.proto"
);

export function startMediaGrpcServer(): grpc.Server {
  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });

  const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
  const MediaService = (proto["media"] as grpc.GrpcObject)[
    "MediaService"
  ] as unknown as grpc.ServiceClientConstructor;

  const server = new grpc.Server();
  server.addService(MediaService.service, mediaImpl);

  server.bindAsync(
    `0.0.0.0:${env.MEDIA_GRPC_PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        logger.error(`media-service gRPC failed to bind: ${err.message}`);
        return;
      }
      logger.info(
        `media-service gRPC server listening on port ${String(boundPort)}`
      );
    }
  );

  return server;
}
