import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import {
  makeBreakerNoArgs,
  makeGrpcCall,
  type NoArgBreaker,
} from "@aimess/grpc-utils";

import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/messaging.proto"
);

// int64 arrives as a STRING (longs: String) — coerce on read.
interface RawGroupCount {
  total: string | number;
}

const pkgDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
const ServiceCtor = (proto["messaging"] as grpc.GrpcObject)[
  "MessagingService"
] as grpc.ServiceClientConstructor;
const client = new ServiceCtor(
  env.CHAT_GRPC_URL,
  grpc.credentials.createInsecure()
);

const call = <TReq, TRes>(method: string, req: TReq) =>
  makeGrpcCall<TReq, TRes>(client, method, req);

export const getGroupCountBreaker: NoArgBreaker<RawGroupCount> =
  makeBreakerNoArgs("chat.getGroupCount", () =>
    call<unknown, RawGroupCount>("getGroupCount", {})
  );

export const chatClient = {
  async getGroupCount(): Promise<number> {
    const r = await getGroupCountBreaker.fire();
    return Number(r.total);
  },
};
