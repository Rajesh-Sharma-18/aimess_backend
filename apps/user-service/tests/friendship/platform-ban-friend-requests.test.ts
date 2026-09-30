/**
 * Friend requests × Super Admin platform ban (AIMESS_FRIEND_REQUEST_PLATFORM_BAN_FLOW).
 *
 * A = requester, B = addressee. Covers F1–F7 at the service/HTTP seam:
 * the ban sweep (`invalidateForBannedUser`), the send/accept gates and the
 * accept race. Read-side filtering (pending list, friends list, search) is
 * covered by friend-requests / friends-list / banned-user-discovery tests.
 */
jest.mock("../../src/repositories/friendship.repository.js", () => ({
  friendshipRepository: {
    findAllForUser: jest.fn(async () => []),
    findById: jest.fn(),
    findByPair: jest.fn(async () => null),
    findAllBlocks: jest.fn(async () => []),
    create: jest.fn(),
    acceptWithCounters: jest.fn(),
    reject: jest.fn(),
    cancel: jest.fn(),
  },
}));
jest.mock("../../src/repositories/friends.repository.js", () => ({
  friendsRepository: { listAcceptedFriendIds: jest.fn(async () => []) },
}));
jest.mock("../../src/repositories/user-settings.repository.js", () => ({
  userSettingsRepository: {
    findFriendRequestPrivacy: jest.fn(async () => null),
  },
}));
jest.mock("../../src/repositories/user-profile.repository.js", () => ({
  userProfileRepository: {
    findByUserId: jest.fn(async (userId: string) => ({
      userId,
      username: `u_${userId.slice(0, 4)}`,
      firstName: "Pat",
      lastName: "Lee",
      avatarUrl: null,
      deletedAt: null,
    })),
    findManyByUserIds: jest.fn(async () => []),
  },
}));
jest.mock("../../src/lib/user-cache.js", () => ({
  userCache: { invalidateProfile: jest.fn(async () => undefined) },
}));
jest.mock("../../src/lib/banned-users.js", () => ({
  bannedAmong: jest.fn(async () => new Set<string>()),
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
jest.mock("../../src/config/redis.js", () => ({
  redis: { status: "ready", get: jest.fn(async () => null) },
  isUserCacheReady: jest.fn(() => false),
  connectUserRedis: jest.fn(async () => undefined),
  disableUserCache: jest.fn(),
}));

import request from "supertest";
import { FriendSocketEvents } from "@aimess/shared-types";

import { app } from "../../src/app.js";
import { redis } from "../../src/config/redis.js";
import { bannedAmong } from "../../src/lib/banned-users.js";
import {
  emitFriendEventToPairSafe,
  emitFriendSelfEventSafe,
} from "../../src/lib/friend-socket.js";
import {
  publishFriendAcceptedSafe,
  publishFriendCancelledSafe,
  publishFriendRejectedSafe,
} from "../../src/messaging/publish-friendship.js";
import { friendshipRepository } from "../../src/repositories/friendship.repository.js";
import { friendsRepository } from "../../src/repositories/friends.repository.js";
import { friendshipService } from "../../src/services/friendship.service.js";
import { TEST_USER_ID, bearer, makeAccessToken } from "../helpers/auth.js";

const fRepo = friendshipRepository as unknown as Record<string, jest.Mock>;
const banned = bannedAmong as unknown as jest.Mock;
const redisGet = (redis as unknown as { get: jest.Mock }).get;
const selfEmit = emitFriendSelfEventSafe as unknown as jest.Mock;
const pairEmit = emitFriendEventToPairSafe as unknown as jest.Mock;
const cancelledPub = publishFriendCancelledSafe as unknown as jest.Mock;
const acceptedPub = publishFriendAcceptedSafe as unknown as jest.Mock;
const rejectedPub = publishFriendRejectedSafe as unknown as jest.Mock;

const A = "33333333-3333-4333-8333-333333333333";
const B = "55555555-5555-4555-8555-555555555555";
const C = "77777777-7777-4777-8777-777777777777";
const FID_AB = "44444444-4444-4444-8444-444444444444";
const FID_CB = "66666666-6666-4666-8666-666666666666";
const FID_BD = "88888888-8888-4888-8888-888888888888";

function row(
  id: string,
  requesterId: string,
  addresseeId: string,
  status = "PENDING"
) {
  return {
    id,
    requesterId,
    addresseeId,
    status,
    acceptedAt: null,
    rejectedAt: null,
    cancelledAt: status === "CANCELLED" ? new Date() : null,
    unfriendedAt: null,
    unfriendedBy: null,
    firstAcceptedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

const p2025 = () => Object.assign(new Error("not found"), { code: "P2025" });

const invalidations = () =>
  selfEmit.mock.calls.filter(
    ([, e]) => e === FriendSocketEvents.REQUEST_INVALIDATED
  );

beforeEach(() => {
  jest.clearAllMocks();
  banned.mockResolvedValue(new Set());
  redisGet.mockResolvedValue(null);
  fRepo.findAllForUser.mockResolvedValue([]);
  // The PENDING-guarded cancel returns the same row, now CANCELLED.
  fRepo.cancel.mockImplementation(async (id: string) => {
    const rows = await fRepo.findAllForUser.mock.results[0].value;
    const r = rows.find((x: { id: string }) => x.id === id);
    return row(id, r.requesterId, r.addresseeId, "CANCELLED");
  });
});

describe("ban sweep — invalidateForBannedUser", () => {
  it("F1/F2/F3: cancels pending requests in BOTH directions and tells each peer", async () => {
    // B is banned: A→B outgoing (F2) and B→D (F1 roles swapped) plus C→B (F3).
    fRepo.findAllForUser.mockResolvedValue([
      row(FID_AB, A, B),
      row(FID_CB, C, B),
      row(FID_BD, B, TEST_USER_ID),
    ]);

    await friendshipService.invalidateForBannedUser(B);

    expect(fRepo.cancel.mock.calls.map(([id]) => id)).toEqual([
      FID_AB,
      FID_CB,
      FID_BD,
    ]);
    // friend.cancelled deletes both sides' notification rows (badge fix).
    expect(cancelledPub).toHaveBeenCalledTimes(3);
    // Older clients drop the card off the ordinary cancel event.
    expect(
      pairEmit.mock.calls.filter(
        ([, , e]) => e === FriendSocketEvents.REQUEST_CANCELLED
      )
    ).toHaveLength(3);
    // Each OTHER party gets `friend:request:invalidated` naming B, never the ban.
    expect(invalidations().map(([to, , data]) => [to, data])).toEqual([
      [A, { peerId: B, friendshipId: FID_AB, reason: "unavailable" }],
      [C, { peerId: B, friendshipId: FID_CB, reason: "unavailable" }],
      [
        TEST_USER_ID,
        { peerId: B, friendshipId: FID_BD, reason: "unavailable" },
      ],
    ]);
    expect(invalidations().some(([to]) => to === B)).toBe(false);
  });

  it("F4: leaves friendships intact (restored on unban) but tells friends to drop B", async () => {
    fRepo.findAllForUser.mockResolvedValue([row(FID_AB, A, B, "ACCEPTED")]);

    await friendshipService.invalidateForBannedUser(B);

    expect(fRepo.cancel).not.toHaveBeenCalled();
    expect(cancelledPub).not.toHaveBeenCalled();
    expect(invalidations().map(([to, , data]) => [to, data])).toEqual([
      [A, { peerId: B, friendshipId: null, reason: "unavailable" }],
    ]);
  });

  it("ignores history rows and is idempotent", async () => {
    fRepo.findAllForUser.mockResolvedValue([
      row(FID_AB, A, B, "CANCELLED"),
      row(FID_CB, C, B, "REJECTED"),
      row(FID_BD, B, C, "UNFRIENDED"),
    ]);

    await friendshipService.invalidateForBannedUser(B);

    expect(fRepo.cancel).not.toHaveBeenCalled();
    expect(selfEmit).not.toHaveBeenCalled();
  });

  it("skips a row a concurrent accept/cancel already moved", async () => {
    fRepo.findAllForUser.mockResolvedValue([row(FID_AB, A, B)]);
    fRepo.cancel.mockRejectedValue(p2025());

    await friendshipService.invalidateForBannedUser(B);

    expect(cancelledPub).not.toHaveBeenCalled();
    expect(invalidations()).toHaveLength(0);
  });
});

describe("request/accept gates", () => {
  const auth = () => bearer(makeAccessToken());

  it("F7: sending to an already-banned user → 404 USER_NO_LONGER_AVAILABLE, no row", async () => {
    banned.mockImplementation(async (ids: string[]) => new Set(ids));

    const res = await request(app)
      .post("/api/v1/users/friends/requests")
      .set(auth())
      .send({ addresseeId: B });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("USER_NO_LONGER_AVAILABLE");
    expect(fRepo.create).not.toHaveBeenCalled();
  });

  it("F6: a banned sender whose token is still alive → 403 ACCOUNT_BANNED, no row", async () => {
    redisGet.mockResolvedValue("1");

    const res = await request(app)
      .post("/api/v1/users/friends/requests")
      .set(auth())
      .send({ addresseeId: B });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_BANNED");
    expect(fRepo.create).not.toHaveBeenCalled();
  });

  it("F1: accepting a banned requester's request → 404 USER_NO_LONGER_AVAILABLE", async () => {
    fRepo.findById.mockResolvedValue(row(FID_AB, A, TEST_USER_ID));
    banned.mockImplementation(async (ids: string[]) => new Set(ids));

    const res = await request(app)
      .post(`/api/v1/users/friends/requests/${FID_AB}/accept`)
      .set(auth());

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("USER_NO_LONGER_AVAILABLE");
    expect(fRepo.acceptWithCounters).not.toHaveBeenCalled();
  });

  it("F5: ban lands between the check and the write → no friendship, no accepted event", async () => {
    fRepo.findById.mockResolvedValue(row(FID_AB, A, TEST_USER_ID));
    // Live at the pre-check, banned by the time the conditional write runs
    // (the sweep cancelled the row, so the PENDING-guarded update found none).
    banned
      .mockResolvedValueOnce(new Set())
      .mockImplementation(async (ids: string[]) => new Set(ids));
    fRepo.acceptWithCounters.mockRejectedValue(p2025());

    const res = await request(app)
      .post(`/api/v1/users/friends/requests/${FID_AB}/accept`)
      .set(auth());

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("USER_NO_LONGER_AVAILABLE");
    expect(acceptedPub).not.toHaveBeenCalled();
  });

  it("a lost accept race with a plain cancel still reads as request-not-found", async () => {
    fRepo.findById.mockResolvedValue(row(FID_AB, A, TEST_USER_ID));
    fRepo.acceptWithCounters.mockRejectedValue(p2025());

    const res = await request(app)
      .post(`/api/v1/users/friends/requests/${FID_AB}/accept`)
      .set(auth());

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("FRIEND_REQUEST_NOT_FOUND");
  });
});

describe("stale cards after the sweep (A requested B = TEST_USER_ID, A banned)", () => {
  const auth = () => bearer(makeAccessToken());
  const bannedA = () =>
    banned.mockImplementation(
      async (ids: string[]) => new Set(ids.filter((id) => id === A))
    );
  const anyEvent = () =>
    selfEmit.mock.calls.length +
    pairEmit.mock.calls.length +
    cancelledPub.mock.calls.length +
    rejectedPub.mock.calls.length;

  it("stale Reject on a request the sweep closed → 200 no-op, nothing written or emitted", async () => {
    bannedA();
    fRepo.findById.mockResolvedValue(row(FID_AB, A, TEST_USER_ID, "CANCELLED"));

    const res = await request(app)
      .post(`/api/v1/users/friends/requests/${FID_AB}/reject`)
      .set(auth());

    expect(res.status).toBe(200);
    // Viewer-relative view of the closed row: no request, no friendship.
    expect(res.body.data.status).toBe("NONE");
    expect(fRepo.reject).not.toHaveBeenCalled();
    expect(fRepo.cancel).not.toHaveBeenCalled();
    expect(anyEvent()).toBe(0);
  });

  it("repeated stale Reject stays 200 and silent", async () => {
    bannedA();
    fRepo.findById.mockResolvedValue(row(FID_AB, A, TEST_USER_ID, "CANCELLED"));

    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post(`/api/v1/users/friends/requests/${FID_AB}/reject`)
        .set(auth());
      expect(res.status).toBe(200);
    }
    expect(fRepo.reject).not.toHaveBeenCalled();
    expect(anyEvent()).toBe(0);
  });

  it("stale Delete (website's Reject: DELETE /requests/:id) → 200 no-op", async () => {
    bannedA();
    fRepo.findById.mockResolvedValue(row(FID_AB, A, TEST_USER_ID, "CANCELLED"));

    const res = await request(app)
      .delete(`/api/v1/users/friends/requests/${FID_AB}`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(fRepo.cancel).not.toHaveBeenCalled();
    expect(anyEvent()).toBe(0);
  });

  it("Reject that beats the sweep closes the request quietly, exactly once", async () => {
    bannedA();
    const pending = row(FID_AB, A, TEST_USER_ID);
    fRepo.findById.mockResolvedValue(pending);
    fRepo.findAllForUser.mockResolvedValue([pending]);
    fRepo.cancel
      .mockResolvedValueOnce(row(FID_AB, A, TEST_USER_ID, "CANCELLED"))
      .mockRejectedValue(p2025()); // the row is no longer PENDING

    const res = await request(app)
      .post(`/api/v1/users/friends/requests/${FID_AB}/reject`)
      .set(auth());
    // The sweep arrives afterwards (or runs twice) and finds nothing to do.
    await friendshipService.invalidateForBannedUser(A);
    await friendshipService.invalidateForBannedUser(A);

    expect(res.status).toBe(200);
    // Quiet cancel, never a "declined" outcome pushed to the banned requester.
    expect(fRepo.reject).not.toHaveBeenCalled();
    expect(rejectedPub).not.toHaveBeenCalled();
    expect(cancelledPub).toHaveBeenCalledTimes(1);
    expect(invalidations()).toHaveLength(1);
    expect(invalidations()[0][0]).toBe(TEST_USER_ID);
  });

  it("stale Accept on a request the sweep closed → 404 USER_NO_LONGER_AVAILABLE, no friendship", async () => {
    bannedA();
    fRepo.findById.mockResolvedValue(row(FID_AB, A, TEST_USER_ID, "CANCELLED"));

    const res = await request(app)
      .post(`/api/v1/users/friends/requests/${FID_AB}/accept`)
      .set(auth());

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("USER_NO_LONGER_AVAILABLE");
    expect(fRepo.acceptWithCounters).not.toHaveBeenCalled();
    expect(acceptedPub).not.toHaveBeenCalled();
  });

  describe("validation is not weakened", () => {
    it("unknown request id → 404 FRIEND_REQUEST_NOT_FOUND", async () => {
      bannedA();
      fRepo.findById.mockResolvedValue(null);
      const res = await request(app)
        .post(`/api/v1/users/friends/requests/${FID_AB}/reject`)
        .set(auth());
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("FRIEND_REQUEST_NOT_FOUND");
    });

    it("someone else's request → 404 even if its requester is banned", async () => {
      bannedA();
      fRepo.findById.mockResolvedValue(row(FID_AB, A, C, "CANCELLED"));
      const res = await request(app)
        .post(`/api/v1/users/friends/requests/${FID_AB}/reject`)
        .set(auth());
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("FRIEND_REQUEST_NOT_FOUND");
    });

    it("an already-closed request whose requester is NOT banned → 404 as before", async () => {
      fRepo.findById.mockResolvedValue(
        row(FID_AB, A, TEST_USER_ID, "CANCELLED")
      );
      const res = await request(app)
        .post(`/api/v1/users/friends/requests/${FID_AB}/reject`)
        .set(auth());
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("FRIEND_REQUEST_NOT_FOUND");
    });

    it("a malformed id → 400, never reaches the service", async () => {
      const res = await request(app)
        .post(`/api/v1/users/friends/requests/not-a-uuid/reject`)
        .set(auth());
      expect(res.status).toBe(400);
      expect(fRepo.findById).not.toHaveBeenCalled();
    });

    it("a normal Reject (requester not banned) still records REJECTED", async () => {
      fRepo.findById.mockResolvedValue(row(FID_AB, A, TEST_USER_ID));
      fRepo.reject.mockResolvedValue({
        ...row(FID_AB, A, TEST_USER_ID, "REJECTED"),
        rejectedAt: new Date(),
      });
      const res = await request(app)
        .post(`/api/v1/users/friends/requests/${FID_AB}/reject`)
        .set(auth());
      expect(res.status).toBe(200);
      expect(fRepo.reject).toHaveBeenCalledWith(FID_AB);
      expect(rejectedPub).toHaveBeenCalledTimes(1);
    });
  });
});

describe("unban — announceRestoredUser", () => {
  it("tells each friend to re-read the relationship; resurrects no request", async () => {
    (friendsRepository.listAcceptedFriendIds as jest.Mock).mockResolvedValue([
      A,
      C,
    ]);

    await friendshipService.announceRestoredUser(B);

    expect(selfEmit.mock.calls.map(([to, e, data]) => [to, e, data])).toEqual([
      [A, FriendSocketEvents.RELATIONSHIP_SYNC, { peerId: B }],
      [C, FriendSocketEvents.RELATIONSHIP_SYNC, { peerId: B }],
    ]);
    expect(fRepo.cancel).not.toHaveBeenCalled();
    expect(fRepo.create).not.toHaveBeenCalled();
  });
});
