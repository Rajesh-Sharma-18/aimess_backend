/**
 * End-to-end regression scenarios for friend requests × Super Admin platform
 * ban, run in order against ONE stateful in-memory friendships table whose
 * accept/cancel honour the real PENDING guard (P2025 when the row moved).
 * HTTP → controller → service → repository contract, with only storage,
 * Redis and the broker faked. Events are counted to prove nothing duplicates.
 */
type Row = {
  id: string;
  requesterId: string;
  addresseeId: string;
  status: string;
  acceptedAt: Date | null;
  firstAcceptedAt: Date | null;
  rejectedAt: Date | null;
  cancelledAt: Date | null;
  unfriendedAt: Date | null;
  unfriendedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const db = {
  rows: new Map<string, Row>(),
  banned: new Set<string>(),
  counters: new Map<string, number>(),
};

jest.mock("../../src/repositories/friendship.repository.js", () => {
  const p2025 = () => Object.assign(new Error("not found"), { code: "P2025" });
  const move = (id: string, status: string, patch: Partial<Row>) => {
    const r = db.rows.get(id);
    if (!r || r.status !== "PENDING") throw p2025(); // where: { id, status: PENDING }
    Object.assign(r, { status, updatedAt: new Date() }, patch);
    return { ...r };
  };
  return {
    friendshipRepository: {
      findById: jest.fn(async (id: string) => {
        const r = db.rows.get(id);
        return r ? { ...r } : null;
      }),
      findAllForUser: jest.fn(async (u: string) =>
        [...db.rows.values()]
          .filter((r) => r.requesterId === u || r.addresseeId === u)
          .map((r) => ({ ...r }))
      ),
      findByPair: jest.fn(async (a: string, b: string) => {
        const r = [...db.rows.values()].find(
          (x) =>
            (x.requesterId === a && x.addresseeId === b) ||
            (x.requesterId === b && x.addresseeId === a)
        );
        return r ? { ...r } : null;
      }),
      findPendingRequests: jest.fn(async ({ userId }: { userId: string }) =>
        [...db.rows.values()].filter(
          (r) => r.status === "PENDING" && r.addresseeId === userId
        )
      ),
      countPendingRequests: jest.fn(
        async (userId: string) =>
          [...db.rows.values()].filter(
            (r) => r.status === "PENDING" && r.addresseeId === userId
          ).length
      ),
      findAllBlocks: jest.fn(async () => []),
      findBlock: jest.fn(async () => null),
      hasMutualFriend: jest.fn(async () => false),
      create: jest.fn(async (requesterId: string, addresseeId: string) => {
        const now = new Date();
        const r: Row = {
          id: jest
            .requireActual<typeof import("node:crypto")>("node:crypto")
            .randomUUID(),
          requesterId,
          addresseeId,
          status: "PENDING",
          acceptedAt: null,
          firstAcceptedAt: null,
          rejectedAt: null,
          cancelledAt: null,
          unfriendedAt: null,
          unfriendedBy: null,
          createdAt: now,
          updatedAt: now,
        };
        db.rows.set(r.id, r);
        return { ...r };
      }),
      acceptWithCounters: jest.fn(async (id: string, a: string, b: string) => {
        const row = move(id, "ACCEPTED", { acceptedAt: new Date() });
        for (const u of [a, b])
          db.counters.set(u, (db.counters.get(u) ?? 0) + 1);
        return [row];
      }),
      reject: jest.fn(async (id: string) =>
        move(id, "REJECTED", { rejectedAt: new Date() })
      ),
      cancel: jest.fn(async (id: string) =>
        move(id, "CANCELLED", { cancelledAt: new Date() })
      ),
    },
  };
});
jest.mock("../../src/repositories/friends.repository.js", () => ({
  friendsRepository: {
    listAcceptedFriendIds: jest.fn(async (u: string) =>
      [...db.rows.values()]
        .filter(
          (r) =>
            r.status === "ACCEPTED" &&
            (r.requesterId === u || r.addresseeId === u)
        )
        .map((r) => (r.requesterId === u ? r.addresseeId : r.requesterId))
    ),
    listFriendProfiles: jest.fn(async () => []),
  },
}));
jest.mock("../../src/lib/banned-users.js", () => ({
  bannedAmong: jest.fn(
    async (ids: string[]) => new Set(ids.filter((id) => db.banned.has(id)))
  ),
}));
jest.mock("../../src/config/redis.js", () => ({
  // The REST ban guard reads the same flag.
  redis: {
    status: "ready",
    get: jest.fn(async (key: string) =>
      db.banned.has(key.slice(key.lastIndexOf(":") + 1)) ? "1" : null
    ),
  },
  isUserCacheReady: jest.fn(() => false),
  connectUserRedis: jest.fn(async () => undefined),
  disableUserCache: jest.fn(),
}));
jest.mock("../../src/repositories/user-settings.repository.js", () => ({
  userSettingsRepository: {
    findFriendRequestPrivacy: jest.fn(async () => null),
    findCallAllowedIds: jest.fn(async () => []),
  },
}));
jest.mock("../../src/repositories/user-profile.repository.js", () => {
  const profile = (userId: string) => ({
    userId,
    username: `u_${userId.slice(0, 4)}`,
    firstName: "Pat",
    lastName: "Lee",
    bio: null,
    avatarUrl: null,
    coverImageUrl: null,
    isOnline: false,
    lastSeenAt: null,
    friendsCount: 99, // stale stored column: must never be what is returned
    communitiesCount: 0,
    groupsCount: 0,
    status: "ACTIVE",
    deletedAt: null,
    privacySettings: null,
  });
  return {
    userProfileRepository: {
      findByUserId: jest.fn(async (u: string) => profile(u)),
      findPublicProfileByUserId: jest.fn(async (u: string) => profile(u)),
      findManyByUserIds: jest.fn(async (ids: string[]) => ids.map(profile)),
    },
  };
});
jest.mock("../../src/lib/user-cache.js", () => ({
  userCache: { invalidateProfile: jest.fn(async () => undefined) },
}));
jest.mock("../../src/services/avatar.service.js", () => ({
  avatarService: { resolveViewUrlForClient: jest.fn(async () => null) },
}));
jest.mock("../../src/messaging/publish-friendship.js", () => ({
  publishFriendRequestedSafe: jest.fn(),
  publishFriendAcceptedSafe: jest.fn(),
  publishFriendRejectedSafe: jest.fn(),
  publishFriendCancelledSafe: jest.fn(),
  publishFriendUnfriendedSafe: jest.fn(),
  publishFriendshipBlockedSafe: jest.fn(),
  publishFriendshipCreatedSafe: jest.fn(),
  publishFriendshipDeletedSafe: jest.fn(),
}));
jest.mock("../../src/lib/friend-socket.js", () => ({
  emitFriendEventSafe: jest.fn(),
  emitFriendEventToPairSafe: jest.fn(),
  emitFriendSelfEventSafe: jest.fn(),
}));

import request from "supertest";
import { FriendSocketEvents } from "@aimess/shared-types";

import { app } from "../../src/app.js";
import { emitFriendSelfEventSafe } from "../../src/lib/friend-socket.js";
import {
  publishFriendAcceptedSafe,
  publishFriendCancelledSafe,
  publishFriendRejectedSafe,
} from "../../src/messaging/publish-friendship.js";
import { friendshipService } from "../../src/services/friendship.service.js";
import { bearer, makeAccessToken } from "../helpers/auth.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const as = (userId: string) => bearer(makeAccessToken({ userId }));
const cancelled = publishFriendCancelledSafe as jest.Mock;
const rejectedPub = publishFriendRejectedSafe as jest.Mock;
const acceptedPub = publishFriendAcceptedSafe as jest.Mock;
const selfEmit = emitFriendSelfEventSafe as jest.Mock;
const invalidatedTo = (to: string) =>
  selfEmit.mock.calls.filter(
    ([u, e]) => u === to && e === FriendSocketEvents.REQUEST_INVALIDATED
  ).length;

/** The gRPC mirror's ban hook, as `adminSetProfileStatus(BANNED)` runs it. */
async function ban(userId: string) {
  db.banned.add(userId); // auth-service sets the Redis flag first
  await friendshipService.invalidateForBannedUser(userId);
}
async function unban(userId: string) {
  db.banned.delete(userId);
  await friendshipService.announceRestoredUser(userId);
}
async function friendsCount(userId: string): Promise<number> {
  const res = await request(app).get(`/api/v1/users/${userId}`).set(as(userId));
  expect(res.status).toBe(200);
  return res.body.data.friendsCount;
}
async function incoming(userId: string) {
  const res = await request(app)
    .get("/api/v1/users/friends/requests?direction=incoming")
    .set(as(userId));
  expect(res.status).toBe(200);
  return res.body.data.requests as unknown[];
}
async function befriend(x: string, y: string) {
  const sent = await request(app)
    .post("/api/v1/users/friends/requests")
    .set(as(x))
    .send({ addresseeId: y });
  expect(sent.status).toBe(201);
  const acc = await request(app)
    .post(`/api/v1/users/friends/requests/${sent.body.data.id}/accept`)
    .set(as(y));
  expect(acc.status).toBe(200);
}

beforeEach(() => {
  db.rows.clear();
  db.banned.clear();
  db.counters.clear();
  jest.clearAllMocks();
});

it("pending request + ban + multi-device stale Reject/Accept + repeated sweep", async () => {
  // 1-2. A requests B; B sees it.
  const sent = await request(app)
    .post("/api/v1/users/friends/requests")
    .set(as(A))
    .send({ addresseeId: B });
  expect(sent.status).toBe(201);
  const fid = sent.body.data.id as string;
  expect(await incoming(B)).toHaveLength(1);

  // 3-4. Ban A: the sweep closes the request (Device 2 of B gets the events).
  await ban(A);
  expect(db.rows.get(fid)!.status).toBe("CANCELLED");
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(invalidatedTo(B)).toBe(1);

  // 5. No actionable request left for B.
  expect(await incoming(B)).toHaveLength(0);

  // Repeated processing: nothing new.
  await ban(A);
  await ban(A);
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(invalidatedTo(B)).toBe(1);

  // 6. Device 1 still shows the card: Reject, twice, and the website's Delete.
  for (const call of [
    () =>
      request(app)
        .post(`/api/v1/users/friends/requests/${fid}/reject`)
        .set(as(B)),
    () =>
      request(app)
        .post(`/api/v1/users/friends/requests/${fid}/reject`)
        .set(as(B)),
    () =>
      request(app).delete(`/api/v1/users/friends/requests/${fid}`).set(as(B)),
  ]) {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("NONE");
  }
  expect(db.rows.get(fid)!.status).toBe("CANCELLED"); // not rewritten to REJECTED
  expect(rejectedPub).not.toHaveBeenCalled();
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(invalidatedTo(B)).toBe(1);

  // 7. Stale Accept cannot make them friends.
  const acc = await request(app)
    .post(`/api/v1/users/friends/requests/${fid}/accept`)
    .set(as(B));
  expect(acc.status).toBe(404);
  expect(acc.body.code).toBe("USER_NO_LONGER_AVAILABLE");
  expect(db.rows.get(fid)!.status).toBe("CANCELLED");
  expect(acceptedPub).not.toHaveBeenCalled();
  expect(await friendsCount(B)).toBe(0);

  // 8. A stays blocked by the system ban.
  const aSend = await request(app)
    .post("/api/v1/users/friends/requests")
    .set(as(A))
    .send({ addresseeId: C });
  expect(aSend.status).toBe(403);
  expect(aSend.body.code).toBe("ACCOUNT_BANNED");

  // Unban: the cancelled request is NOT resurrected.
  await unban(A);
  expect(await incoming(B)).toHaveLength(0);
});

it("existing friends + ban: excluded from every friend's count, restored on unban", async () => {
  await befriend(A, B);
  await befriend(A, C);
  await befriend(A, D);
  await befriend(E, B);
  expect([
    await friendsCount(B),
    await friendsCount(C),
    await friendsCount(D),
    await friendsCount(E),
  ]).toEqual([2, 1, 1, 1]);

  await ban(A);
  await ban(A); // repeated processing
  expect([
    await friendsCount(B),
    await friendsCount(C),
    await friendsCount(D),
    await friendsCount(E),
  ]).toEqual([1, 0, 0, 1]);
  // Friend rows untouched (hidden, not deleted), stored counters not decremented.
  expect(
    [...db.rows.values()].filter((r) => r.status === "ACCEPTED")
  ).toHaveLength(4);
  expect(db.counters.get(B)).toBe(2);
  // Each friend told once per sweep run; E (not A's friend) never.
  expect(invalidatedTo(B)).toBe(2);
  expect(invalidatedTo(E)).toBe(0);

  selfEmit.mockClear();
  await unban(A);
  expect([
    await friendsCount(B),
    await friendsCount(C),
    await friendsCount(D),
  ]).toEqual([2, 1, 1]);
  expect(
    selfEmit.mock.calls
      .filter(([, e]) => e === FriendSocketEvents.RELATIONSHIP_SYNC)
      .map(([to]) => to)
      .sort()
  ).toEqual([B, C, D].sort());
});

it("normal flows are unchanged: send, accept, reject, cancel", async () => {
  await befriend(C, D);
  expect(await friendsCount(C)).toBe(1);

  const r1 = await request(app)
    .post("/api/v1/users/friends/requests")
    .set(as(B))
    .send({ addresseeId: E });
  const rej = await request(app)
    .post(`/api/v1/users/friends/requests/${r1.body.data.id}/reject`)
    .set(as(E));
  expect(rej.status).toBe(200);
  expect(db.rows.get(r1.body.data.id)!.status).toBe("REJECTED");
  expect(rejectedPub).toHaveBeenCalledTimes(1);
  // A second Reject of an ordinary resolved request is still a 404.
  const again = await request(app)
    .post(`/api/v1/users/friends/requests/${r1.body.data.id}/reject`)
    .set(as(E));
  expect(again.status).toBe(404);
  expect(again.body.code).toBe("FRIEND_REQUEST_NOT_FOUND");

  const r2 = await request(app)
    .post("/api/v1/users/friends/requests")
    .set(as(B))
    .send({ addresseeId: C });
  const can = await request(app)
    .delete(`/api/v1/users/friends/requests/${r2.body.data.id}`)
    .set(as(B));
  expect(can.status).toBe(200);
  expect(db.rows.get(r2.body.data.id)!.status).toBe("CANCELLED");
  const canAgain = await request(app)
    .delete(`/api/v1/users/friends/requests/${r2.body.data.id}`)
    .set(as(B));
  expect(canAgain.status).toBe(404);
});
