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

interface AccountEntry {
  userId: string;
  account: string;
}

interface BulkAccountsResult {
  accounts: AccountEntry[];
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

const bulkGetAccountsBreaker: Breaker<
  { userIds: string[] },
  BulkAccountsResult
> = makeBreaker("auth.bulkGetAccounts", (args: { userIds: string[] }) =>
  call<{ userIds: string[] }, BulkAccountsResult>("bulkGetAccounts", args)
);

export const authGrpcClient = {
  async bulkGetAccounts(
    userIds: string[]
  ): Promise<Array<{ userId: string; account: string }>> {
    const result = await bulkGetAccountsBreaker.fire({ userIds });
    return result.accounts ?? [];
  },
};
