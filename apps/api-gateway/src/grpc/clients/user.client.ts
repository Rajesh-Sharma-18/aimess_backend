import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { env } from "../../config/env.js";
import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  /**
   * The subset of `peerIds` whose `whoCanSeeOnlineStatus` admits `viewerId`.
   * Returns `[]` — never the input list — when user-service is unreachable or
   * the breaker is open: presence is a privacy decision, so it fails CLOSED.
   */
  filterVisiblePresence(viewerId: string, peerIds: string[]): Promise<string[]>;
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

  const presenceBreaker = makeBreaker(
    "user.filterVisiblePresence",
    (p: { viewerId: string; peerIds: string[] }) =>
      call<typeof p, { visiblePeerIds: string[] }>(
        "filterVisiblePresence",
        p
      ).then((r) => r.visiblePeerIds ?? [])
  );

  return {
    bulkGetUserSnapshots: (userIds) =>
      bulkBreaker.fire({ userIds }).catch(() => null),
    filterVisiblePresence: (viewerId, peerIds) => {
      if (!UUID_RE.test(viewerId)) return Promise.resolve([]);
      const userIds = [...new Set(peerIds)].filter((id) => UUID_RE.test(id));
      return userIds.length === 0
        ? Promise.resolve([])
        : presenceBreaker.fire({ viewerId, peerIds: userIds }).catch(() => []);
    },
  };
}
