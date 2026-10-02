import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";

import { env } from "../../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../../packages/grpc-contracts/proto/backoffice.proto"
);

export interface CustomCredential {
  configured: boolean;
  value: string;
}

export interface BackofficeClient {
  getCustomCredential(name: string, platform: string): Promise<CustomCredential>;
}

export function createBackofficeClient(): BackofficeClient {
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

  const breaker = makeBreaker(
    "backoffice.getCustomCredential",
    (req: { name: string; platform: string }) =>
      makeGrpcCall<{ name: string; platform: string }, CustomCredential>(
        client,
        "getCustomCredential",
        req
      ),
    { timeout: 2000 }
  );

  return {
    async getCustomCredential(name, platform) {
      const res = await breaker.fire({ name, platform });
      return { configured: res?.configured === true, value: res?.value ?? "" };
    },
  };
}

let singleton: BackofficeClient | null = null;

export function getBackofficeClient(): BackofficeClient {
  if (!singleton) singleton = createBackofficeClient();
  return singleton;
}
