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
  /**
   * True when the account is deleted. user-service has already blanked
   * username/avatar* and set displayName to the shared "Deleted Account"
   * literal, so this flag is only needed to decide what NOT to do — skip the
   * auth-service name fallback, drop presence, hide profile navigation.
   */
  isDeleted: boolean;
}

interface BulkSnapshotsResult {
  users: UserSnapshotRecord[];
}

/** The account-wide Settings → Chat block (user-service `ChatSettings`). */
export interface ChatSettings {
  /** "OFF" | "DAYS_7" | "DAYS_15" | "DAYS_30". */
  autoDeleteTimer: string;
  typingIndicators: boolean;
  readReceipts: boolean;
}

export interface CallPrivacy {
  /**
   * Narrows who may call, on top of the mandatory friendship rule — it can no
   * longer widen it. `EVERYONE` and `FRIENDS` are therefore equivalent for
   * calling (both mean "any friend"); only `NO_ONE` and `SELECTED_FRIENDS`
   * restrict further. See `lib/call-authorization.ts`.
   */
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

const adminSearchProfileIdsBreaker: Breaker<
  { search: string },
  { userIds: string[] }
> = makeBreaker("user.adminSearchProfileIds", (args: { search: string }) =>
  call<{ search: string }, { userIds: string[] }>("adminSearchProfileIds", args)
);

const getCallPrivacyBreaker: Breaker<{ userId: string }, CallPrivacy> =
  makeBreaker("user.getCallPrivacy", (args: { userId: string }) =>
    call<{ userId: string }, CallPrivacy>("getCallPrivacy", args)
  );

const getChatSettingsBreaker: Breaker<{ userId: string }, ChatSettings> =
  makeBreaker("user.getChatSettings", (args: { userId: string }) =>
    call<{ userId: string }, ChatSettings>("getChatSettings", args)
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

const filterVisiblePresenceBreaker: Breaker<
  { viewerId: string; peerIds: string[] },
  { visiblePeerIds: string[] }
> = makeBreaker(
  "user.filterVisiblePresence",
  (args: { viewerId: string; peerIds: string[] }) =>
    call<typeof args, { visiblePeerIds: string[] }>(
      "filterVisiblePresence",
      args
    )
);

const filterPresenceViewersBreaker: Breaker<
  { subjectId: string; viewerIds: string[] },
  { allowedViewerIds: string[] }
> = makeBreaker(
  "user.filterPresenceViewers",
  (args: { subjectId: string; viewerIds: string[] }) =>
    call<typeof args, { allowedViewerIds: string[] }>(
      "filterPresenceViewers",
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

  /**
   * Admin identity search over the PROFILE fields the panel actually renders
   * (username/firstName/lastName) — auth-service only matches email/account, so
   * an admin searching a username finds nothing without this. Degrades to []
   * like every other cross-service admin identity call.
   */
  async adminSearchProfileIds(search: string): Promise<string[]> {
    if (!search.trim()) return [];
    try {
      const r = await adminSearchProfileIdsBreaker.fire({ search });
      return r.userIds ?? [];
    } catch {
      return [];
    }
  },

  async getCallPrivacy(userId: string): Promise<CallPrivacy> {
    const r = await getCallPrivacyBreaker.fire({ userId });
    return {
      whoCanCallMe: r.whoCanCallMe ?? "FRIENDS",
      allowedUserIds: r.allowedUserIds ?? [],
    };
  },

  /**
   * One user's account-wide Settings → Chat block, or `null` when the call was
   * inconclusive (transport failure / breaker open).
   *
   * `null` rather than a defaulted object on purpose: the caller caches, and a
   * cached fallback would outlive the outage that produced it. Choosing the
   * fail-open defaults is therefore the caller's job — see
   * lib/account-chat-settings.ts.
   */
  async getChatSettings(userId: string): Promise<ChatSettings | null> {
    try {
      const r = await getChatSettingsBreaker.fire({ userId });
      return {
        autoDeleteTimer: r.autoDeleteTimer || "OFF",
        typingIndicators: r.typingIndicators !== false,
        readReceipts: r.readReceipts !== false,
      };
    } catch {
      return null;
    }
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
   * Which of `peerIds` this viewer may see the online status of
   * (`whoCanSeeOnlineStatus`). Unlike the display-metadata lookups above this
   * fails CLOSED — an empty list on any transport failure — because a
   * fail-open here discloses presence the user asked us to hide. A blip
   * therefore shows peers as offline, never as leaked-online.
   */
  async filterVisiblePresence(
    viewerId: string,
    peerIds: string[]
  ): Promise<Set<string>> {
    if (peerIds.length === 0) return new Set();
    try {
      const r = await filterVisiblePresenceBreaker.fire({ viewerId, peerIds });
      return new Set(r.visiblePeerIds ?? []);
    } catch {
      return new Set();
    }
  },

  /** Inverse of {@link filterVisiblePresence}: one subject, many viewers. Same fail-CLOSED policy. */
  async filterPresenceViewers(
    subjectId: string,
    viewerIds: string[]
  ): Promise<Set<string>> {
    if (viewerIds.length === 0) return new Set();
    try {
      const r = await filterPresenceViewersBreaker.fire({
        subjectId,
        viewerIds,
      });
      return new Set(r.allowedViewerIds ?? []);
    } catch {
      return new Set();
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
