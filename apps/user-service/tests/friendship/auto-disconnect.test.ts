/**
 * POST /api/v1/users/friends/auto-disconnect
 *
 * Tests the auto-disconnect endpoint end-to-end (app + real service layer,
 * mocked repositories). Mirrors the mock-setup pattern from
 * auto-connect.test.ts / friendship.test.ts.
 */

jest.mock("../../src/repositories/friendship.repository.js", () => ({
  friendshipRepository: {
    findAcceptedFriends: jest.fn(async () => []),
    autoDisconnectBatch: jest.fn(async () => 0),
  },
}));
jest.mock("../../src/repositories/user-profile.repository.js", () => ({
  userProfileRepository: {
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
  publishFriendshipCreatedSafe: jest.fn(),
  publishFriendshipDeletedSafe: jest.fn(),
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
import {
  publishFriendUnfriendedSafe,
  publishFriendshipDeletedSafe,
} from "../../src/messaging/publish-friendship.js";
import { TEST_USER_ID, bearer, makeAccessToken } from "../helpers/auth.js";

const fRepo = friendshipRepository as unknown as Record<string, jest.Mock>;
const pRepo = userProfileRepository as unknown as Record<string, jest.Mock>;
const cache = userCache as unknown as Record<string, jest.Mock>;
const unfriended = publishFriendUnfriendedSafe as unknown as jest.Mock;
const friendshipDeleted = publishFriendshipDeletedSafe as unknown as jest.Mock;

const ME = TEST_USER_ID;
const auth = () => bearer(makeAccessToken());

/** Build an ACCEPTED friendship row as returned by findAcceptedFriends. */
function acceptedFriend(
  id: string,
  peer: string,
  meIsRequester = true
): { id: string; requesterId: string; addresseeId: string; acceptedAt: Date } {
  return {
    id,
    requesterId: meIsRequester ? ME : peer,
    addresseeId: meIsRequester ? peer : ME,
    acceptedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

const PEER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PEER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PEER_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const URL = "/api/v1/users/friends/auto-disconnect";

describe("POST /api/v1/users/friends/auto-disconnect", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fRepo.findAcceptedFriends.mockResolvedValue([]);
    fRepo.autoDisconnectBatch.mockResolvedValue(0);
    pRepo.findByUserId.mockResolvedValue({ userId: ME });
  });

  // --- Auth ---

  it("1. No auth header → 401", async () => {
    const res = await request(app).post(URL);
    expect(res.status).toBe(401);
  });

  // --- Caller profile not provisioned ---

  it("2. Caller's UserProfile not provisioned → 404, autoDisconnectBatch never runs", async () => {
    pRepo.findByUserId.mockResolvedValue(null);

    const res = await request(app).post(URL).set(auth());

    expect(res.status).toBe(404);
    expect(fRepo.autoDisconnectBatch).not.toHaveBeenCalled();
  });

  // --- Zero friends ---

  it("3. No friends → 200, all counters 0, no events published", async () => {
    fRepo.findAcceptedFriends.mockResolvedValue([]);

    const res = await request(app).post(URL).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({
      totalFriends: 0,
      friendsDisconnected: 0,
      friends: [],
    });
    expect(fRepo.autoDisconnectBatch).not.toHaveBeenCalled();
    expect(unfriended).not.toHaveBeenCalled();
    expect(friendshipDeleted).not.toHaveBeenCalled();
  });

  // --- Happy path ---

  it("4. 3 friends → disconnects all 3, returns their userIds", async () => {
    fRepo.findAcceptedFriends.mockResolvedValue([
      acceptedFriend("f-a", PEER_A),
      acceptedFriend("f-b", PEER_B, false),
      acceptedFriend("f-c", PEER_C),
    ]);
    fRepo.autoDisconnectBatch.mockResolvedValue(3);

    const res = await request(app).post(URL).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      totalFriends: 3,
      friendsDisconnected: 3,
    });
    expect(res.body.data.friends).toEqual(
      expect.arrayContaining([PEER_A, PEER_B, PEER_C])
    );
  });

  // --- Peer resolution regardless of requester/addressee direction ---

  it("5. Resolves the peer correctly whether caller is requester or addressee", async () => {
    fRepo.findAcceptedFriends.mockResolvedValue([
      acceptedFriend("f-a", PEER_A, true),
      acceptedFriend("f-b", PEER_B, false),
    ]);
    fRepo.autoDisconnectBatch.mockResolvedValue(2);

    await request(app).post(URL).set(auth());

    const [, friendshipIds, peerIds] = fRepo.autoDisconnectBatch.mock
      .calls[0] as [string, string[], string[]];
    expect(friendshipIds).toEqual(expect.arrayContaining(["f-a", "f-b"]));
    expect(peerIds).toEqual(expect.arrayContaining([PEER_A, PEER_B]));
  });

  // --- Repository call shape ---

  it("6. autoDisconnectBatch is called with callerId as userId", async () => {
    fRepo.findAcceptedFriends.mockResolvedValue([
      acceptedFriend("f-a", PEER_A),
    ]);
    fRepo.autoDisconnectBatch.mockResolvedValue(1);

    await request(app).post(URL).set(auth());

    expect(fRepo.autoDisconnectBatch).toHaveBeenCalledWith(
      ME,
      ["f-a"],
      [PEER_A]
    );
  });

  // --- Event publishing (same event pair as manual unfriend) ---

  it("7. publishFriendUnfriendedSafe + publishFriendshipDeletedSafe called once per friendship", async () => {
    fRepo.findAcceptedFriends.mockResolvedValue([
      acceptedFriend("f-a", PEER_A),
      acceptedFriend("f-b", PEER_B),
    ]);
    fRepo.autoDisconnectBatch.mockResolvedValue(2);

    await request(app).post(URL).set(auth());

    expect(unfriended).toHaveBeenCalledTimes(2);
    expect(unfriended).toHaveBeenCalledWith(
      expect.objectContaining({
        friendshipId: "f-a",
        unfriendedById: ME,
        otherUserId: PEER_A,
      })
    );
    expect(unfriended).toHaveBeenCalledWith(
      expect.objectContaining({
        friendshipId: "f-b",
        unfriendedById: ME,
        otherUserId: PEER_B,
      })
    );
    expect(friendshipDeleted).toHaveBeenCalledTimes(2);
    expect(friendshipDeleted).toHaveBeenCalledWith(ME, PEER_A);
    expect(friendshipDeleted).toHaveBeenCalledWith(ME, PEER_B);
  });

  // --- Cache invalidation ---

  it("8. userCache.invalidateProfile called for caller + every unique peer", async () => {
    fRepo.findAcceptedFriends.mockResolvedValue([
      acceptedFriend("f-a", PEER_A),
      acceptedFriend("f-b", PEER_B),
    ]);
    fRepo.autoDisconnectBatch.mockResolvedValue(2);

    await request(app).post(URL).set(auth());

    const invalidatedIds = cache.invalidateProfile.mock.calls.map(
      (c: unknown[]) => c[0]
    );
    expect(new Set(invalidatedIds)).toEqual(new Set([ME, PEER_A, PEER_B]));
  });

  // --- Chunking (large friend list) ---

  it("9. Large batch: >500 friends → autoDisconnectBatch called twice (chunking)", async () => {
    const friends = Array.from({ length: 501 }, (_, i) =>
      acceptedFriend(
        `f-${i}`,
        `user-${String(i).padStart(4, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
      )
    );
    fRepo.findAcceptedFriends.mockResolvedValue(friends);
    fRepo.autoDisconnectBatch.mockResolvedValue(500).mockResolvedValueOnce(500);

    await request(app).post(URL).set(auth());

    expect(fRepo.autoDisconnectBatch).toHaveBeenCalledTimes(2);
    const [, firstIds] = fRepo.autoDisconnectBatch.mock.calls[0] as [
      string,
      string[],
    ];
    const [, secondIds] = fRepo.autoDisconnectBatch.mock.calls[1] as [
      string,
      string[],
    ];
    expect(firstIds).toHaveLength(500);
    expect(secondIds).toHaveLength(1);
  });

  // --- Partial concurrent-race count ---

  it("10. friendsDisconnected reflects the repository's actual updated count, not the requested count", async () => {
    // Simulates a friendship concurrently unfriended between the read and the
    // batch update — repo reports fewer rows actually flipped than requested.
    fRepo.findAcceptedFriends.mockResolvedValue([
      acceptedFriend("f-a", PEER_A),
      acceptedFriend("f-b", PEER_B),
    ]);
    fRepo.autoDisconnectBatch.mockResolvedValue(1);

    const res = await request(app).post(URL).set(auth());

    expect(res.body.data).toMatchObject({
      totalFriends: 2,
      friendsDisconnected: 1,
    });
  });
});
