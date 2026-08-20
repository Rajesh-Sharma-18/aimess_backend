import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { makeBreaker, makeGrpcCall, type Breaker } from "@aimess/grpc-utils";

import { env } from "../config/env.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dir,
  "../../../../packages/grpc-contracts/proto/user.proto"
);

interface UserSnapshotRecord {
  userId: string;
  username: string;
  displayName: string;
  avatarObjectKey: string;
  /**
   * Account deleted. user-service already blanked username/avatarObjectKey and
   * set displayName to the shared "Deleted Account" literal, so this flag only
   * decides what NOT to do: never treat the id as an addable/inviteable user,
   * never let a stored member snapshot win over these anonymized values.
   */
  isDeleted: boolean;
  /**
   * Account admin-suspended or admin-banned. Unlike `isDeleted` the identity is
   * still real (history renders normally) — this flag only gates ACTIONS whose
   * target must be able to log in and respond: invites, member adds, DM cards.
   */
  isSuspended: boolean;
}

interface BulkSnapshotsResult {
  users: UserSnapshotRecord[];
}

export interface FriendshipInfoRecord {
  userId: string;
  status: "FRIEND" | "PENDING" | "NONE" | "BLOCKED";
  direction: string;
  /** TRUE when EITHER side blocks the other — `status` only reports outgoing. */
  blockedEitherWay: boolean;
}

interface CheckFriendshipsResult {
  friendIds: string[];
  relationships?: FriendshipInfoRecord[];
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
  env.USER_GRPC_URL,
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

const checkFriendshipsBreaker: Breaker<
  { callerId: string; candidateIds: string[] },
  CheckFriendshipsResult
> = makeBreaker(
  "user.checkFriendships",
  (args: { callerId: string; candidateIds: string[] }) =>
    call<{ callerId: string; candidateIds: string[] }, CheckFriendshipsResult>(
      "checkFriendships",
      args
    )
);

export const userGrpcClient = {
  async bulkGetUserSnapshots(userIds: string[]): Promise<UserSnapshotRecord[]> {
    const result = await bulkGetUserSnapshotsBreaker.fire({ userIds });
    return result.users ?? [];
  },

  async checkFriendships(
    callerId: string,
    candidateIds: string[]
  ): Promise<string[]> {
    const result = await checkFriendshipsBreaker.fire({
      callerId,
      candidateIds,
    });
    return result.friendIds ?? [];
  },

  /**
   * Same RPC as {@link checkFriendships}, but keeps the full per-candidate
   * relationship instead of only the ACCEPTED subset — the BLOCKED rows are
   * what invite eligibility needs (a block in EITHER direction is reported as
   * BLOCKED by user-service).
   */
  async checkRelationships(
    callerId: string,
    candidateIds: string[]
  ): Promise<FriendshipInfoRecord[]> {
    const result = await checkFriendshipsBreaker.fire({
      callerId,
      candidateIds,
    });
    return result.relationships ?? [];
  },
};
