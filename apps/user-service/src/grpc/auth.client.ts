import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { makeBreaker, makeGrpcCall, type Breaker } from "@aimess/grpc-utils";

import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/auth.proto"
);

export interface LinkedAccountInfo {
  provider: string;
  connected: boolean;
  providerUserId: string;
  providerEmail: string;
  linkedAt: string;
}

export interface AccountSummaryResult {
  userId: string;
  account: string;
  email: string;
  emailVerified: boolean;
  hasPassword: boolean;
  primaryAccount: string; // "" when absent
  providers: LinkedAccountInfo[];
}

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

const call = <TReq, TRes>(method: string, req: TReq) =>
  makeGrpcCall<TReq, TRes>(client, method, req);

export const getAccountSummaryBreaker: Breaker<
  { userId: string },
  AccountSummaryResult
> = makeBreaker("auth.getAccountSummary", (args: { userId: string }) =>
  call<{ userId: string }, AccountSummaryResult>("getAccountSummary", args)
);

export const authGrpcClient = {
  async getAccountSummary(userId: string): Promise<AccountSummaryResult> {
    return getAccountSummaryBreaker.fire({ userId });
  },
};
