/**
 * Friend requests: 50 per day per sender, then blocked for 24h (client table).
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
jest.mock("../../src/config/redis.js", () => {
  const counts = new Map<string, number>();
  const ttls = new Map<string, number>();
  return {
    redis: {
      status: "ready",
      get: jest.fn(async () => null),
      incr: jest.fn(async (k: string) => {
        counts.set(k, (counts.get(k) ?? 0) + 1);
        return counts.get(k);
      }),
      ttl: jest.fn(async (k: string) => ttls.get(k) ?? -1),
      expire: jest.fn(async (k: string, s: number) => {
        ttls.set(k, s);
        return 1;
      }),
    },
    isUserCacheReady: jest.fn(() => false),
    connectUserRedis: jest.fn(async () => undefined),
    disableUserCache: jest.fn(),
  };
});

import request from "supertest";

import { app } from "../../src/app.js";
import { friendshipRepository } from "../../src/repositories/friendship.repository.js";
import { bearer, makeAccessToken } from "../helpers/auth.js";

const fRepo = friendshipRepository as unknown as Record<string, jest.Mock>;

const addressee = (i: number) =>
  `55555555-5555-4555-8555-${String(i).padStart(12, "0")}`;

it("allows 50 requests a day, refuses the 51st with FRIEND_REQUEST_LIMIT_REACHED + 24h retry", async () => {
  fRepo.findByPair.mockResolvedValue(null);
  fRepo.create.mockImplementation(async (requesterId: string, addresseeId: string) => ({
    id: "44444444-4444-4444-8444-444444444444",
    requesterId,
    addresseeId,
    status: "PENDING",
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  const auth = bearer(makeAccessToken());

  for (let i = 1; i <= 50; i += 1) {
    const ok = await request(app)
      .post("/api/v1/users/friends/requests")
      .set(auth)
      .send({ addresseeId: addressee(i) });
    expect(ok.status).toBe(201);
  }

  const res = await request(app)
    .post("/api/v1/users/friends/requests")
    .set(auth)
    .send({ addresseeId: addressee(51) });

  expect(res.status).toBe(429);
  expect(res.body.error.code).toBe("FRIEND_REQUEST_LIMIT_REACHED");
  expect(res.body.error.retryAfter).toBe(86_400);
  expect(res.headers["retry-after"]).toBe("86400");
  expect(fRepo.create).toHaveBeenCalledTimes(50);
});
