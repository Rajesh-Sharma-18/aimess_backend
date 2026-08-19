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
  /**
   * Presigned GET URL, already resolved by user-service (proto `avatar_url`).
   * "" when there is no avatar or MinIO was unreachable. Never persist it.
   */
  avatarUrl?: string;
}
export type UserClient = {
  bulkGetUserSnapshots(userIds: string[]): Promise<UserSnapshotRecord[] | null>;
  /**
   * The subset of `peerIds` whose `whoCanSeeOnlineStatus` admits `viewerId`.
   * Returns `[]` — never the input list — when user-service is unreachable or
   * the breaker is open: presence is a privacy decision, so it fails CLOSED.
   */
  filterVisiblePresence(viewerId: string, peerIds: string[]): Promise<string[]>;
  /**
   * The two reciprocal Settings → Chat switches for one user.
   *
   * WhatsApp semantics: turning a switch off both stops YOUR signal from going
   * out AND stops you receiving anyone else's. So the same lookup answers the
   * sender-side question ("may I broadcast?") and the recipient-side one ("may
   * this viewer be shown someone else's?").
   *
   * Fails OPEN (both true) — unlike presence, a blip here must not silently
   * break a working feature, and neither signal discloses anything sensitive.
   *
   * Cached: consulted per typing burst and per read receipt delivered.
   */
  getChatFlags(userId: string): Promise<ChatFlags>;
  /**
   * Drop this user's cached flags so the very next lookup re-reads them.
   *
   * Called from the `settings:updated` relay in chat.ns — without it a switch
   * flipped mid-conversation would keep its old value for up to the TTL, which
   * reads to the user as "the toggle did nothing".
   *
   * Optional so the many hand-rolled `userClient` stubs in the socket test
   * suites keep compiling and running — a missing invalidator only costs
   * freshness, never correctness (the TTL still expires).
   */
  invalidateChatFlags?(userId: string): void;
};

export interface ChatFlags {
  typingIndicators: boolean;
  readReceipts: boolean;
}

/** See {@link UserClient.getChatFlags} — one lookup per user per minute. */
const CHAT_FLAGS_TTL_MS = 60_000;
const CHAT_FLAGS_MAX_ENTRIES = 10_000;
const CHAT_FLAGS_OPEN: ChatFlags = {
  typingIndicators: true,
  readReceipts: true,
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

  const chatSettingsBreaker = makeBreaker(
    "user.getChatSettings",
    (p: { userId: string }) => call<typeof p, ChatFlags>("getChatSettings", p)
  );

  const chatFlags = new Map<string, { value: ChatFlags; expiresAt: number }>();
  // In-flight lookups, keyed by user. A `message:read` receipt reaches this
  // gateway TWICE (chat-service publishes it on `conv:<roomId>` AND on every
  // other participant's `user:<id>`), and both relays await the same viewer's
  // flags concurrently — with no single-flight that was two identical gRPC
  // calls per receipt, and on a cold cache the second one paid the full round
  // trip too. Share the promise instead.
  const chatFlagsInFlight = new Map<string, Promise<ChatFlags>>();
  // A lookup that failed or timed out (the breaker's 2s ceiling) must not be
  // re-paid by the very next receipt: while user-service is slow, that turned
  // EVERY read receipt into a flat 2s stall with nothing ever warming up. Fail
  // open for a short window instead. Deliberately much shorter than the real
  // TTL: a user's disabled switch acts as ON for a few seconds past recovery,
  // not a minute.
  const CHAT_FLAGS_FAIL_OPEN_MS = 5_000;

  const fetchChatFlags = async (userId: string): Promise<ChatFlags> => {
    const res = await chatSettingsBreaker
      .fire({ userId })
      .catch(() => null as ChatFlags | null);
    // Map preserves insertion order — drop the oldest rather than grow unbounded.
    if (chatFlags.size >= CHAT_FLAGS_MAX_ENTRIES) {
      const oldest = chatFlags.keys().next().value;
      if (oldest !== undefined) chatFlags.delete(oldest);
    }
    if (res === null) {
      chatFlags.set(userId, {
        value: CHAT_FLAGS_OPEN,
        expiresAt: Date.now() + CHAT_FLAGS_FAIL_OPEN_MS,
      });
      return CHAT_FLAGS_OPEN;
    }
    const value: ChatFlags = {
      typingIndicators: res.typingIndicators !== false,
      readReceipts: res.readReceipts !== false,
    };
    chatFlags.set(userId, {
      value,
      expiresAt: Date.now() + CHAT_FLAGS_TTL_MS,
    });
    return value;
  };

  return {
    bulkGetUserSnapshots: (userIds) =>
      bulkBreaker.fire({ userIds }).catch(() => null),
    getChatFlags: (userId) => {
      if (!UUID_RE.test(userId)) return Promise.resolve(CHAT_FLAGS_OPEN);

      const hit = chatFlags.get(userId);
      if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.value);

      const pending = chatFlagsInFlight.get(userId);
      if (pending) return pending;
      const p = fetchChatFlags(userId).finally(() => {
        chatFlagsInFlight.delete(userId);
      });
      chatFlagsInFlight.set(userId, p);
      return p;
    },
    invalidateChatFlags: (userId) => {
      chatFlags.delete(userId);
    },
    filterVisiblePresence: (viewerId, peerIds) => {
      if (!UUID_RE.test(viewerId)) return Promise.resolve([]);
      const userIds = [...new Set(peerIds)].filter((id) => UUID_RE.test(id));
      return userIds.length === 0
        ? Promise.resolve([])
        : presenceBreaker.fire({ viewerId, peerIds: userIds }).catch(() => []);
    },
  };
}
