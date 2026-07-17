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

export interface CallPrivacy {
  whoCanCallMe: "FRIENDS" | "SELECTED_FRIENDS" | "NO_ONE";
  allowedUserIds: string[];
}

export type ChatFriendshipStatus = "FRIEND" | "PENDING" | "NONE" | "BLOCKED";

export interface ChatFriendshipInfo {
  status: ChatFriendshipStatus;
  direction: "OUTGOING" | "INCOMING" | null;
}

interface FriendshipInfoRecord {
  userId: string;
  status: string;
  direction: string;
}

interface CheckFriendshipsResult {
  friendIds: string[];
  relationships: FriendshipInfoRecord[];
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

const getCallPrivacyBreaker: Breaker<{ userId: string }, CallPrivacy> =
  makeBreaker("user.getCallPrivacy", (args: { userId: string }) =>
    call<{ userId: string }, CallPrivacy>("getCallPrivacy", args)
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

  async getCallPrivacy(userId: string): Promise<CallPrivacy> {
    const r = await getCallPrivacyBreaker.fire({ userId });
    return {
      whoCanCallMe: r.whoCanCallMe ?? "FRIENDS",
      allowedUserIds: r.allowedUserIds ?? [],
    };
  },

  /**
   * Batch friendship status/direction for private-chat responses (conversation
   * list / room details). Source of truth is user-service, not chat-service's
   * own eventually-consistent local read-model — see `friendship.repository.ts`
   * for why that local copy is send-gate-only, never response data. On a
   * transport failure, callers get an empty map and fall back to `NONE` per
   * peer (fail-open on display metadata, same policy as presence).
   */
  async checkFriendships(
    callerId: string,
    candidateIds: string[]
  ): Promise<Map<string, ChatFriendshipInfo>> {
    if (candidateIds.length === 0) return new Map();
    try {
      const result = await checkFriendshipsBreaker.fire({
        callerId,
        candidateIds,
      });
      return new Map(
        (result.relationships ?? []).map((r) => [
          r.userId,
          {
            status: (r.status || "NONE") as ChatFriendshipStatus,
            direction:
              r.direction === "OUTGOING" || r.direction === "INCOMING"
                ? r.direction
                : null,
          },
        ])
      );
    } catch {
      return new Map();
    }
  },
};
