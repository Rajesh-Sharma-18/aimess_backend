import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { env } from "../../config/env.js";
import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../../packages/grpc-contracts/proto/user.proto"
);

export interface UserSnapshotRecord {
  userId: string;
  username: string;
  displayName: string;
  avatarObjectKey: string;
}
export type UserClient = {
  bulkGetUserSnapshots(userIds: string[]): Promise<UserSnapshotRecord[] | null>;
};

export function createUserClient(): UserClient {
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

  // USER_GRPC_URL is optional in env — degrade gracefully (breaker .catch → null)
  // rather than crash the gateway when user-service gRPC is unconfigured.
  const client = new ServiceCtor(
    env.USER_GRPC_URL ?? "",
    grpc.credentials.createInsecure()
  );

  const call = <TReq, TRes>(method: string, req: TReq) =>
    makeGrpcCall<TReq, TRes>(client, method, req);

  const bulkBreaker = makeBreaker(
    "user.bulkGetUserSnapshots",
    (p: { userIds: string[] }) =>
      call<{ userIds: string[] }, { users: UserSnapshotRecord[] }>(
        "bulkGetUserSnapshots",
        p
      ).then((r) => r.users ?? [])
  );

  return {
    bulkGetUserSnapshots: (userIds) =>
      bulkBreaker.fire({ userIds }).catch(() => null),
  };
}
