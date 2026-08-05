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
  /** Presigned GET URL, resolved server-side by user-service. "" when none. */
  avatarUrl: string;
}

interface BulkSnapshotsResult {
  users: UserSnapshotRecord[];
}

export interface CallPrivacy {
  /** `EVERYONE` is the only scope that admits a non-friend caller. */
  whoCanCallMe: "EVERYONE" | "FRIENDS" | "SELECTED_FRIENDS" | "NO_ONE";
  allowedUserIds: string[];
}

export type ChatFriendshipStatus = "FRIEND" | "PENDING" | "NONE" | "BLOCKED";

export interface ChatFriendshipInfo {
  status: ChatFriendshipStatus;
  direction: "OUTGOING" | "INCOMING" | null;
  /**
   * Additive user-search-shaped fields — optional at the type level so existing
   * test mocks that only supply {status, direction} keep compiling. The gRPC
   * client always populates them (defaulting to null/false when missing); the
   * consumer of `PeerFriendshipRelationship` derives its shape from these.
   */
  friendshipId?: string | null;
  requesterId?: string | null;
  canAccept?: boolean;
  canReject?: boolean;
  canCancel?: boolean;
}

interface FriendshipInfoRecord {
  userId: string;
  status: string;
  direction: string;
  friendshipId?: string;
  requesterId?: string;
  canAccept?: boolean;
  canReject?: boolean;
  canCancel?: boolean;
}

interface CheckFriendshipsResult {
  friendIds: string[];
  relationships: FriendshipInfoRecord[];
}

export type FriendshipViewStatus =
  | "NONE"
  | "PENDING"
  | "ACCEPTED"
  | "REJECTED"
  | "CANCELLED"
  | "UNFRIENDED"
  | "BLOCKED";

export interface FriendshipView {
  status: FriendshipViewStatus;
  direction: "OUTGOING" | "INCOMING" | null;
  canAccept: boolean;
  canReject: boolean;
  canCancel: boolean;
}

interface FriendshipViewRecord {
  found: boolean;
  status: string;
  direction: string;
  canAccept: boolean;
  canReject: boolean;
  canCancel: boolean;
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

const getFriendshipViewBreaker: Breaker<
  { friendshipId: string; viewerId: string },
  FriendshipViewRecord
> = makeBreaker(
  "user.getFriendshipView",
  (args: { friendshipId: string; viewerId: string }) =>
    call<{ friendshipId: string; viewerId: string }, FriendshipViewRecord>(
      "getFriendshipView",
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
            friendshipId: r.friendshipId ? r.friendshipId : null,
            requesterId: r.requesterId ? r.requesterId : null,
            canAccept: r.canAccept ?? false,
            canReject: r.canReject ?? false,
            canCancel: r.canCancel ?? false,
          },
        ])
      );
    } catch {
      return new Map();
    }
  },

  /**
   * Current friendship state for a Notification Center row, viewer-relative.
   * Notification is an immutable event log — this is the dynamic lookup that
   * resolves whether a FRIEND_REQUEST row is still actionable. Fail-open to
   * null on transport failure so a friendship-service blip never 500s the
   * notifications list; the caller falls back to omitting `friendship`.
   */
  async getFriendshipView(
    friendshipId: string,
    viewerId: string
  ): Promise<FriendshipView | null> {
    try {
      const r = await getFriendshipViewBreaker.fire({
        friendshipId,
        viewerId,
      });
      if (!r.found) return null;
      return {
        status: (r.status || "NONE") as FriendshipViewStatus,
        direction:
          r.direction === "OUTGOING" || r.direction === "INCOMING"
            ? r.direction
            : null,
        canAccept: r.canAccept,
        canReject: r.canReject,
        canCancel: r.canCancel,
      };
    } catch {
      return null;
    }
  },
};
