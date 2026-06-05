import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { makeBreaker, makeGrpcCall, type Breaker } from "@aimess/grpc-utils";

import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/user.proto"
);

interface UserSnapshotRecord {
  userId: string;
  username: string;
  displayName: string;
  avatarObjectKey: string;
}

interface BulkSnapshotsResult {
  users: UserSnapshotRecord[];
}

const pkgDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
const ServiceCtor = (proto["user"] as grpc.GrpcObject)[
  "UserService"
] as grpc.ServiceClientConstructor;
const client = new ServiceCtor(
  env.USER_SERVICE_GRPC_URL,
  grpc.credentials.createInsecure()
);

const call = <TReq, TRes>(method: string, req: TReq) =>
  makeGrpcCall<TReq, TRes>(client, method, req);

const bulkGetUserSnapshotsBreaker: Breaker<
  { userIds: string[] },
  BulkSnapshotsResult
> = makeBreaker("user.bulkGetUserSnapshots", (args: { userIds: string[] }) =>
  call<{ userIds: string[] }, BulkSnapshotsResult>("bulkGetUserSnapshots", args)
);

export const userGrpcClient = {
  async bulkGetUserSnapshots(userIds: string[]): Promise<UserSnapshotRecord[]> {
    const result = await bulkGetUserSnapshotsBreaker.fire({ userIds });
    return result.users ?? [];
  },
};
