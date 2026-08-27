import path from "node:path";
import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";

import { env } from "../config/env.js";

// auth-service is ESM ("type":"module"), so derive the directory from
// import.meta — a bare __dirname resolves to the Prisma client's globalThis
// shim, which points at src/generated/prisma and breaks this path.
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  currentDir,
  "../../../../packages/grpc-contracts/proto/backoffice.proto"
);

let _breaker: ReturnType<
  typeof makeBreaker<{ email: string }, { taken: boolean }>
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
    const ServiceCtor = (proto["backoffice"] as grpc.GrpcObject)[
      "BackofficeService"
    ] as grpc.ServiceClientConstructor;
    const client = new ServiceCtor(
      env.BACKOFFICE_GRPC_URL,
      grpc.credentials.createInsecure()
    );
    _breaker = makeBreaker("auth.isAdminEmailTaken", (p: { email: string }) =>
      makeGrpcCall<{ email: string }, { taken: boolean }>(
        client,
        "isAdminEmailTaken",
        { email: p.email }
      )
    );
  }
  return _breaker;
}

/**
 * True when an admin/sub-admin account in admin_db already owns this email.
 * Throws when backoffice-service is unreachable — the caller must fail closed,
 * because letting the write through would permanently duplicate the address
 * across two databases that have no shared unique index.
 */
export async function isAdminEmailTaken(email: string): Promise<boolean> {
  const result = await getBreaker().fire({ email });
  return result.taken === true;
}
