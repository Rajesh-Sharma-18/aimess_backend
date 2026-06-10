import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { logger } from "@aimess/logger";
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

// auth-service getAccountSummary runs two PostgreSQL queries (loadActiveAuthUser
// + findAccountSummaryByUserId). Under staging load these can take up to ~1 s,
// which is well inside the default 2 s opossum timeout on a good day but easily
// breaches it when the DB connection pool is briefly saturated — causing the
// breaker to trip and return null for ALL users for the 10 s resetTimeout window.
// We give this call a 5 s timeout so transient DB slowness doesn't open the breaker.
export const getAccountSummaryBreaker: Breaker<
  { userId: string },
  AccountSummaryResult
> = makeBreaker(
  "auth.getAccountSummary",
  (args: { userId: string }) =>
    call<{ userId: string }, AccountSummaryResult>("getAccountSummary", args),
  { timeout: 5000 }
);
// Log when the breaker recovers so ops can correlate staging incidents.
getAccountSummaryBreaker.on("close", () =>
  logger.info("Circuit closed: auth.getAccountSummary")
);

export const authGrpcClient = {
  async getAccountSummary(userId: string): Promise<AccountSummaryResult> {
    return getAccountSummaryBreaker.fire({ userId });
  },
};
