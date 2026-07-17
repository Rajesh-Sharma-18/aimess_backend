/**
 * POST /api/v1/users/friends/auto-connect
 *
 * Tests the auto-connect endpoint end-to-end (app + real service layer, mocked
 * repositories). Mirrors the mock-setup pattern from friendship.test.ts.
 */

jest.mock("../../src/repositories/friendship.repository.js", () => ({
  friendshipRepository: {
    findAllForUser: jest.fn(async () => []),
    findAllBlocks: jest.fn(async () => []),
    autoAcceptBatch: jest.fn(async () => []),
  },
}));
jest.mock("../../src/repositories/user-profile.repository.js", () => ({
  userProfileRepository: {
    findAllActiveExcept: jest.fn(async () => []),
    findByUserId: jest.fn(),
  },
}));
jest.mock("../../src/lib/user-cache.js", () => ({
  userCache: {
    invalidateProfile: jest.fn(async () => undefined),
  },
}));
jest.mock("../../src/messaging/publish-friendship.js", () => ({
  publishFriendRequestedSafe: jest.fn(),
  publishFriendAcceptedSafe: jest.fn(),
  publishFriendUnfriendedSafe: jest.fn(),
  publishFriendshipBlockedSafe: jest.fn(),
  publishFriendshipCreatedSafe: jest.fn(),
  publishFriendshipDeletedSafe: jest.fn(),
}));
jest.mock("../../src/lib/friend-socket.js", () => ({
  emitFriendEventSafe: jest.fn(),
  emitFriendEventToPairSafe: jest.fn(),
}));
jest.mock("../../src/grpc/messaging.client.js", () => ({
  messagingGrpcClient: {
    getOrCreatePrivateRooms: jest.fn(async () => []),
  },
}));

import request from "supertest";

import { app } from "../../src/app.js";
import { friendshipRepository } from "../../src/repositories/friendship.repository.js";
import { userProfileRepository } from "../../src/repositories/user-profile.repository.js";
import { userCache } from "../../src/lib/user-cache.js";
import { publishFriendAcceptedSafe } from "../../src/messaging/publish-friendship.js";
import { messagingGrpcClient } from "../../src/grpc/messaging.client.js";
import { TEST_USER_ID, bearer, makeAccessToken } from "../helpers/auth.js";

// Typed mock helpers
const fRepo = friendshipRepository as unknown as Record<string, jest.Mock>;
const pRepo = userProfileRepository as unknown as Record<string, jest.Mock>;
const cache = userCache as unknown as Record<string, jest.Mock>;
const accepted = publishFriendAcceptedSafe as unknown as jest.Mock;
const grpc = messagingGrpcClient as unknown as Record<string, jest.Mock>;

const ME = TEST_USER_ID;
const auth = () => bearer(makeAccessToken());

/** Build a minimal active-user stub with the given userId. */
function activeUser(userId: string) {
  return { userId };
}

/** Build a friendship row stub for classification tests. */
function existingRow(
  peer: string,
  status: string,
  requesterIsMe = true
): { id: string; requesterId: string; addresseeId: string; status: string } {
  return {
    id: `row-${peer.slice(0, 8)}`,
    requesterId: requesterIsMe ? ME : peer,
    addresseeId: requesterIsMe ? peer : ME,
    status,
  };
}

/** Build a created friendship row (ACCEPTED, with all required fields). */
function createdRow(peer: string) {
  return {
    id: `f-${peer.slice(0, 8)}`,
    requesterId: ME,
    addresseeId: peer,
    status: "ACCEPTED",
    acceptedAt: new Date("2026-01-01T00:00:00.000Z"),
    rejectedAt: null,
    cancelledAt: null,
    unfriendedAt: null,
    unfriendedBy: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

const PEER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PEER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PEER_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PEER_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PEER_E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const URL = "/api/v1/users/friends/auto-connect";

describe("POST /api/v1/users/friends/auto-connect", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Sensible defaults — overridden per test
    fRepo.findAllForUser.mockResolvedValue([]);
    fRepo.findAllBlocks.mockResolvedValue([]);
    fRepo.autoAcceptBatch.mockResolvedValue([]);
    pRepo.findAllActiveExcept.mockResolvedValue([]);
    // The caller's profile exists by default (provisioned). The missing-profile
    // race is exercised explicitly in its own test.
    pRepo.findByUserId.mockResolvedValue({ userId: ME });
    grpc.getOrCreatePrivateRooms.mockResolvedValue([]);
  });

  // --- Auth ---

  it("1. No auth header → 401", async () => {
    const res = await request(app).post(URL);
    expect(res.status).toBe(401);
  });

  // --- Zero eligible ---

  it("2. Zero eligible users (allUsers=[]) → 200, all counters 0", async () => {
    pRepo.findAllActiveExcept.mockResolvedValue([]);

    const res = await request(app).post(URL).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      totalUsersScanned: 0,
      eligibleUsers: 0,
      friendsCreated: 0,
      alreadyFriends: 0,
      blockedUsers: 0,
      pendingRequests: 0,
      skippedUsers: 0,
    });
  });

  // --- Happy path ---

  it("3. 3 eligible users, no blocks, no existing rows → friendsCreated=3, eligibleUsers=3", async () => {
    pRepo.findAllActiveExcept.mockResolvedValue([
      activeUser(PEER_A),
      activeUser(PEER_B),
      activeUser(PEER_C),
    ]);
    fRepo.autoAcceptBatch.mockResolvedValue([
      createdRow(PEER_A),
      createdRow(PEER_B),
      createdRow(PEER_C),
    ]);

    const res = await request(app).post(URL).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      totalUsersScanned: 3,
      eligibleUsers: 3,
      friendsCreated: 3,
      alreadyFriends: 0,
      blockedUsers: 0,
      pendingRequests: 0,
      skippedUsers: 0,
    });
  });

  // --- Idempotency ---

  it("4. Idempotency: existing ACCEPTED rows → friendsCreated=0, alreadyFriends=3", async () => {
    pRepo.findAllActiveExcept.mockResolvedValue([
      activeUser(PEER_A),
      activeUser(PEER_B),
      activeUser(PEER_C),
    ]);
    fRepo.findAllForUser.mockResolvedValue([
      existingRow(PEER_A, "ACCEPTED"),
      existingRow(PEER_B, "ACCEPTED"),
      existingRow(PEER_C, "ACCEPTED"),
    ]);

    const res = await request(app).post(URL).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      friendsCreated: 0,
      alreadyFriends: 3,
      eligibleUsers: 0,
    });
    expect(fRepo.autoAcceptBatch).not.toHaveBeenCalled();
  });

  // --- Mixed scenario ---

  it("5. Mixed: 1 eligible, 1 alreadyFriends, 1 blocked (caller blocks), 1 pending outgoing, 1 pending incoming → correct counts", async () => {
    pRepo.findAllActiveExcept.mockResolvedValue([
      activeUser(PEER_A), // eligible
      activeUser(PEER_B), // already friends
      activeUser(PEER_C), // blocked (caller blocks PEER_C)
      activeUser(PEER_D), // pending outgoing
      activeUser(PEER_E), // pending incoming
    ]);
    fRepo.findAllForUser.mockResolvedValue([
      existingRow(PEER_B, "ACCEPTED"),
      existingRow(PEER_D, "PENDING", true), // outgoing
      existingRow(PEER_E, "PENDING", false), // incoming
    ]);
    fRepo.findAllBlocks.mockResolvedValue([
      { blockerId: ME, blockedId: PEER_C },
    ]);
    fRepo.autoAcceptBatch.mockResolvedValue([createdRow(PEER_A)]);

    const res = await request(app).post(URL).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      totalUsersScanned: 5,
      eligibleUsers: 1,
      friendsCreated: 1,
      alreadyFriends: 1,
      blockedUsers: 1,
      pendingRequests: 2,
      skippedUsers: 0,
    });
  });

  // --- All blocked ---

  it("6. All users blocked → friendsCreated=0, blockedUsers=N", async () => {
    pRepo.findAllActiveExcept.mockResolvedValue([
      activeUser(PEER_A),
      activeUser(PEER_B),
    ]);
    fRepo.findAllBlocks.mockResolvedValue([
      { blockerId: PEER_A, blockedId: ME },
      { blockerId: ME, blockedId: PEER_B },
    ]);

    const res = await request(app).post(URL).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      friendsCreated: 0,
      blockedUsers: 2,
      eligibleUsers: 0,
    });
    expect(fRepo.autoAcceptBatch).not.toHaveBeenCalled();
  });

  // --- All already friends ---

  it("7. All already friends → friendsCreated=0, alreadyFriends=N", async () => {
    pRepo.findAllActiveExcept.mockResolvedValue([
      activeUser(PEER_A),
      activeUser(PEER_B),
      activeUser(PEER_C),
    ]);
    fRepo.findAllForUser.mockResolvedValue([
      existingRow(PEER_A, "ACCEPTED"),
      existingRow(PEER_B, "ACCEPTED", false),
      existingRow(PEER_C, "ACCEPTED"),
    ]);

    const res = await request(app).post(URL).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      friendsCreated: 0,
      alreadyFriends: 3,
    });
    expect(fRepo.autoAcceptBatch).not.toHaveBeenCalled();
  });

  // --- Pending outgoing ---

  it("8. PENDING outgoing request → counted in pendingRequests", async () => {
    pRepo.findAllActiveExcept.mockResolvedValue([activeUser(PEER_A)]);
    fRepo.findAllForUser.mockResolvedValue([
      existingRow(PEER_A, "PENDING", true),
    ]);

    const res = await request(app).post(URL).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      pendingRequests: 1,
      friendsCreated: 0,
      eligibleUsers: 0,
    });
  });

  // --- Pending incoming ---

  it("9. PENDING incoming request → counted in pendingRequests", async () => {
    pRepo.findAllActiveExcept.mockResolvedValue([activeUser(PEER_A)]);
    fRepo.findAllForUser.mockResolvedValue([
      existingRow(PEER_A, "PENDING", false), // they sent to me
    ]);

    const res = await request(app).post(URL).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      pendingRequests: 1,
      friendsCreated: 0,
    });
  });

  // --- Skipped statuses ---

  it("10. REJECTED / CANCELLED / UNFRIENDED rows → counted in skippedUsers", async () => {
    pRepo.findAllActiveExcept.mockResolvedValue([
      activeUser(PEER_A),
      activeUser(PEER_B),
      activeUser(PEER_C),
    ]);
    fRepo.findAllForUser.mockResolvedValue([
      existingRow(PEER_A, "REJECTED"),
      existingRow(PEER_B, "CANCELLED"),
      existingRow(PEER_C, "UNFRIENDED"),
    ]);

    const res = await request(app).post(URL).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      skippedUsers: 3,
      friendsCreated: 0,
      eligibleUsers: 0,
    });
    expect(fRepo.autoAcceptBatch).not.toHaveBeenCalled();
  });

  // --- Event publishing ---

  it("11. publishFriendAcceptedSafe called once per created friendship with correct payload", async () => {
    pRepo.findAllActiveExcept.mockResolvedValue([
      activeUser(PEER_A),
      activeUser(PEER_B),
    ]);
    const rowA = createdRow(PEER_A);
    const rowB = createdRow(PEER_B);
    fRepo.autoAcceptBatch.mockResolvedValue([rowA, rowB]);

    await request(app).post(URL).set(auth());

    expect(accepted).toHaveBeenCalledTimes(2);
    expect(accepted).toHaveBeenCalledWith({
      friendshipId: rowA.id,
      requesterId: ME,
      addresseeId: PEER_A,
      acceptedAt: rowA.acceptedAt.toISOString(),
    });
    expect(accepted).toHaveBeenCalledWith({
      friendshipId: rowB.id,
      requesterId: ME,
      addresseeId: PEER_B,
      acceptedAt: rowB.acceptedAt.toISOString(),
    });
  });

  // --- Cache invalidation ---

  it("12. userCache.invalidateProfile called for each unique userId involved", async () => {
    pRepo.findAllActiveExcept.mockResolvedValue([
      activeUser(PEER_A),
      activeUser(PEER_B),
    ]);
    fRepo.autoAcceptBatch.mockResolvedValue([
      createdRow(PEER_A),
      createdRow(PEER_B),
    ]);

    await request(app).post(URL).set(auth());

    const invalidatedIds = cache.invalidateProfile.mock.calls.map(
      (c: unknown[]) => c[0]
    );
    // ME, PEER_A, PEER_B — ME appears in both pairs but is deduped
    expect(new Set(invalidatedIds)).toEqual(new Set([ME, PEER_A, PEER_B]));
  });

  // --- No-op when no eligible pairs ---

  it("13. autoAcceptBatch NOT called when eligiblePairs is empty", async () => {
    pRepo.findAllActiveExcept.mockResolvedValue([activeUser(PEER_A)]);
    fRepo.findAllForUser.mockResolvedValue([existingRow(PEER_A, "ACCEPTED")]);

    await request(app).post(URL).set(auth());

    expect(fRepo.autoAcceptBatch).not.toHaveBeenCalled();
  });

  // --- Private rooms: ensure rooms exist for all friends ---

  it("14a. When friends are created, getOrCreatePrivateRooms is called for all peers", async () => {
    pRepo.findAllActiveExcept.mockResolvedValue([
      activeUser(PEER_A),
      activeUser(PEER_B),
    ]);
    fRepo.autoAcceptBatch.mockResolvedValue([
      createdRow(PEER_A),
      createdRow(PEER_B),
    ]);
    grpc.getOrCreatePrivateRooms.mockResolvedValue([
      { peerUserId: PEER_A, roomId: "prv_a" },
      { peerUserId: PEER_B, roomId: "prv_b" },
    ]);

    const res = await request(app).post(URL).set(auth());

    expect(res.status).toBe(200);
    expect(grpc.getOrCreatePrivateRooms).toHaveBeenCalledWith(
      ME,
      expect.arrayContaining([PEER_A, PEER_B])
    );
    expect(res.body.data.friends).toEqual(
      expect.arrayContaining([
        { userId: PEER_A, roomId: "prv_a" },
        { userId: PEER_B, roomId: "prv_b" },
      ])
    );
  });

  it("14b. Existing friends also get rooms created if missing", async () => {
    pRepo.findAllActiveExcept.mockResolvedValue([
      activeUser(PEER_A),
      activeUser(PEER_B),
      activeUser(PEER_C),
    ]);
    fRepo.findAllForUser.mockResolvedValue([
      existingRow(PEER_B, "ACCEPTED"),
      existingRow(PEER_C, "ACCEPTED"),
    ]);
    fRepo.autoAcceptBatch.mockResolvedValue([createdRow(PEER_A)]);
    grpc.getOrCreatePrivateRooms.mockResolvedValue([
      { peerUserId: PEER_A, roomId: "prv_a" },
      { peerUserId: PEER_B, roomId: "prv_b" },
      { peerUserId: PEER_C, roomId: "prv_c" },
    ]);

    const res = await request(app).post(URL).set(auth());

    expect(res.status).toBe(200);
    expect(grpc.getOrCreatePrivateRooms).toHaveBeenCalledWith(
      ME,
      expect.arrayContaining([PEER_A, PEER_B, PEER_C])
    );
    expect(res.body.data.friends).toEqual(
      expect.arrayContaining([
        { userId: PEER_A, roomId: "prv_a" },
        { userId: PEER_B, roomId: "prv_b" },
        { userId: PEER_C, roomId: "prv_c" },
      ])
    );
    expect(res.body.data.alreadyFriends).toBe(2);
    expect(res.body.data.friendsCreated).toBe(1);
  });

  it("14c. Empty friends array when no friends exist", async () => {
    pRepo.findAllActiveExcept.mockResolvedValue([
      activeUser(PEER_A),
      activeUser(PEER_B),
    ]);
    fRepo.findAllBlocks.mockResolvedValue([
      { blockerId: ME, blockedId: PEER_A },
      { blockerId: ME, blockedId: PEER_B },
    ]);

    const res = await request(app).post(URL).set(auth());

    expect(res.status).toBe(200);
    expect(grpc.getOrCreatePrivateRooms).not.toHaveBeenCalled();
    expect(res.body.data.friends).toEqual([]);
  });

  // --- Argument shape ---

  it("14d. autoAcceptBatch receives pairs with requesterId === callerId", async () => {
    pRepo.findAllActiveExcept.mockResolvedValue([
      activeUser(PEER_A),
      activeUser(PEER_B),
    ]);
    fRepo.autoAcceptBatch.mockResolvedValue([
      createdRow(PEER_A),
      createdRow(PEER_B),
    ]);

    await request(app).post(URL).set(auth());

    expect(fRepo.autoAcceptBatch).toHaveBeenCalledTimes(1);
    const [pairs] = fRepo.autoAcceptBatch.mock.calls[0] as [
      { requesterId: string; addresseeId: string }[],
    ];
    expect(pairs).toHaveLength(2);
    for (const pair of pairs) {
      expect(pair.requesterId).toBe(ME);
    }
    expect(pairs.map((p) => p.addresseeId)).toEqual(
      expect.arrayContaining([PEER_A, PEER_B])
    );
  });

  // --- Chunking ---

  it("15. Large batch: >500 eligible users → autoAcceptBatch called twice (chunking)", async () => {
    // 501 users: first chunk = 500, second chunk = 1
    const users = Array.from({ length: 501 }, (_, i) => ({
      userId: `user-${String(i).padStart(4, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    }));
    pRepo.findAllActiveExcept.mockResolvedValue(users);
    // Return empty arrays so publish/cache loops are trivial
    fRepo.autoAcceptBatch.mockResolvedValue([]);

    await request(app).post(URL).set(auth());

    expect(fRepo.autoAcceptBatch).toHaveBeenCalledTimes(2);
    const [firstChunk] = fRepo.autoAcceptBatch.mock.calls[0] as [unknown[]];
    const [secondChunk] = fRepo.autoAcceptBatch.mock.calls[1] as [unknown[]];
    expect(firstChunk).toHaveLength(500);
    expect(secondChunk).toHaveLength(1);
  });

  // --- Caller profile not yet provisioned (onboarding race) ---

  it("16. Caller's UserProfile not provisioned yet → 404, FK-violating insert never runs", async () => {
    // Reproduces the production 500: the user-created consumer (auth `user.created`)
    // hasn't created the caller's UserProfile when /auto-connect fires from the
    // "Complete profile" step. requesterId would have no referent and the batch
    // insert would die on `friendships_requesterId_fkey`. The guard turns this into
    // a clean, retryable 404 BEFORE touching the DB.
    pRepo.findByUserId.mockResolvedValue(null);
    pRepo.findAllActiveExcept.mockResolvedValue([activeUser(PEER_A)]);

    const res = await request(app).post(URL).set(auth());

    expect(res.status).toBe(404);
    expect(fRepo.autoAcceptBatch).not.toHaveBeenCalled();
  });
});
