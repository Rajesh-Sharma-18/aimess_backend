import path from "node:path";
import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";

import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/auth.proto"
);

export interface AuthSessionClient {
  /** True when the Session row exists and is not revoked. */
  isSessionActive(sessionId: string): Promise<boolean>;
}

export function createAuthSessionClient(): AuthSessionClient {
  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
  const ServiceCtor = (proto["auth"] as grpc.GrpcObject)[
    "AuthService"
  ] as grpc.ServiceClientConstructor;
  const client = new ServiceCtor(
    env.AUTH_GRPC_URL,
    grpc.credentials.createInsecure()
  );

  const breaker = makeBreaker(
    "auth.isSessionActive",
    (sessionId: string) =>
      makeGrpcCall<{ sessionId: string }, { active: boolean }>(
        client,
        "isSessionActive",
        { sessionId }
      )
  );

  return {
    isSessionActive: async (sessionId) => {
      const res = await breaker.fire(sessionId);
      return res.active === true;
    },
  };
}
