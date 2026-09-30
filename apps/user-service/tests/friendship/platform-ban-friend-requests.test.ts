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
    cancel: jest.fn(),
  },
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
} from "../../src/messaging/publish-friendship.js";
import { friendshipRepository } from "../../src/repositories/friendship.repository.js";
import { friendshipService } from "../../src/services/friendship.service.js";
import { TEST_USER_ID, bearer, makeAccessToken } from "../helpers/auth.js";

const fRepo = friendshipRepository as unknown as Record<string, jest.Mock>;
const banned = bannedAmong as unknown as jest.Mock;
const redisGet = (redis as unknown as { get: jest.Mock }).get;
const selfEmit = emitFriendSelfEventSafe as unknown as jest.Mock;
const pairEmit = emitFriendEventToPairSafe as unknown as jest.Mock;
const cancelledPub = publishFriendCancelledSafe as unknown as jest.Mock;
const acceptedPub = publishFriendAcceptedSafe as unknown as jest.Mock;

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
