import path from "node:path";
import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";
import { logger } from "@aimess/logger";

import { env } from "../config/env.js";

// auth-service is ESM ("type":"module"), so derive the directory from
// import.meta — a bare __dirname resolves to the Prisma client's globalThis
// shim, which points at src/generated/prisma and breaks this path.
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  currentDir,
  "../../../../packages/grpc-contracts/proto/notification.proto"
);

interface RecordSessionActionParams {
  userId: string;
  sessionId: string;
  action: string;
  body: string;
}

let _breaker: ReturnType<
  typeof makeBreaker<
    RecordSessionActionParams,
    { notificationId: string; updated: boolean }
  >
> | null = null;

function getBreaker() {
  if (!_breaker) {
    const pkgDef = protoLoader.loadSync(PROTO_PATH, {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
    const ServiceCtor = (proto["notification"] as grpc.GrpcObject)[
      "NotificationService"
    ] as grpc.ServiceClientConstructor;
    const client = new ServiceCtor(
      env.CHAT_SERVICE_GRPC_URL,
      grpc.credentials.createInsecure()
    );
    _breaker = makeBreaker(
      "auth.recordSessionAction",
      (p: RecordSessionActionParams) =>
        makeGrpcCall<
          RecordSessionActionParams,
          { notificationId: string; updated: boolean }
        >(client, "recordSessionAction", {
          userId: p.userId,
          sessionId: p.sessionId,
          action: p.action,
          body: p.body,
        })
    );
  }
  return _breaker;
}

/**
 * Fire-and-forget: update the login-detected inbox notification when the user
 * clicks "Terminate" or "It's Me". A failure here must never fail the
 * session-revoke or trust response.
 */
export function recordSessionActionSafe(
  params: RecordSessionActionParams
): void {
  void getBreaker()
    .fire(params)
    .catch((err: unknown) => {
      logger.warn("Failed to record session notification action", { err });
    });
}
