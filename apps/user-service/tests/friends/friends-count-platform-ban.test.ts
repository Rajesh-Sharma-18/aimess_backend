/**
 * friendsCount × Super Admin platform ban.
 *
 * Domain rule (friends.service `activeFriendIds`): a ban keeps the friendship
 * row and only hides it, off the Redis ban key; an unban restores it. So the
 * profile `friendsCount` is computed from the same live set as the friends
 * list — never from the stored counter column, which a ban does not touch.
 *
 * Graph: A is friends with B, C and D; B is also friends with E. A gets banned.
 */
jest.mock("../../src/repositories/friends.repository.js", () => ({
  friendsRepository: {
    listAcceptedFriendIds: jest.fn(),
    listFriendProfiles: jest.fn(async () => []),
  },
}));
jest.mock("../../src/repositories/user-profile.repository.js", () => ({
  userProfileRepository: { findPublicProfileByUserId: jest.fn() },
}));
jest.mock("../../src/repositories/friendship.repository.js", () => ({
  friendshipRepository: {
    findBlock: jest.fn(async () => null),
    findByPair: jest.fn(async () => null),
    hasMutualFriend: jest.fn(async () => false),
  },
}));
jest.mock("../../src/repositories/user-settings.repository.js", () => ({
  userSettingsRepository: { findCallAllowedIds: jest.fn(async () => []) },
}));
jest.mock("../../src/services/avatar.service.js", () => ({
  avatarService: { resolveViewUrlForClient: jest.fn(async () => null) },
}));
jest.mock("../../src/lib/banned-users.js", () => ({
  bannedAmong: jest.fn(),
}));

import request from "supertest";

import { app } from "../../src/app.js";
import { bannedAmong } from "../../src/lib/banned-users.js";
import { friendsRepository } from "../../src/repositories/friends.repository.js";
import { userProfileRepository } from "../../src/repositories/user-profile.repository.js";
import { bearer, makeAccessToken } from "../helpers/auth.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const FRIENDS: Record<string, string[]> = {
  [A]: [B, C, D],
  [B]: [A, E],
  [C]: [A],
  [D]: [A],
  [E]: [B],
};
let bannedIds = new Set<string>();

// Stale on purpose: the stored column still counts A after the ban.
const STORED_COUNT: Record<string, number> = { [B]: 2, [C]: 1, [D]: 1, [E]: 1 };

beforeEach(() => {
  jest.clearAllMocks();
  bannedIds = new Set();
  (friendsRepository.listAcceptedFriendIds as jest.Mock).mockImplementation(
    async (id: string) => FRIENDS[id] ?? []
  );
  (bannedAmong as jest.Mock).mockImplementation(
    async (ids: string[]) => new Set(ids.filter((id) => bannedIds.has(id)))
  );
  (
    userProfileRepository.findPublicProfileByUserId as jest.Mock
  ).mockImplementation(async (userId: string) => ({
    userId,
    username: `u_${userId.slice(0, 4)}`,
    firstName: "Pat",
    lastName: "Lee",
    bio: null,
    avatarUrl: null,
    coverImageUrl: null,
    isOnline: false,
    lastSeenAt: null,
    friendsCount: STORED_COUNT[userId] ?? 0,
    communitiesCount: 0,
    groupsCount: 0,
    status: bannedIds.has(userId) ? "BANNED" : "ACTIVE",
    deletedAt: null,
    privacySettings: null,
  }));
});

/** Own profile, as that user (self always passes `whoCanViewProfile`). */
async function ownCount(userId: string): Promise<number> {
  const res = await request(app)
    .get(`/api/v1/users/${userId}`)
    .set(bearer(makeAccessToken({ userId })));
  expect(res.status).toBe(200);
  return res.body.data.friendsCount;
}

async function listTotal(userId: string): Promise<number> {
  const res = await request(app)
    .get("/api/v1/users/friends")
    .set(bearer(makeAccessToken({ userId })));
  expect(res.status).toBe(200);
  return res.body.data.totalCount;
}

describe("friendsCount after a platform ban", () => {
  it("counts every friend before the ban", async () => {
    expect(await ownCount(B)).toBe(2);
    expect(await ownCount(C)).toBe(1);
  });

  it("excludes the banned friend from EVERY friend's count, and nobody else's", async () => {
    bannedIds.add(A);

    expect(await ownCount(B)).toBe(1); // E only
    expect(await ownCount(C)).toBe(0);
    expect(await ownCount(D)).toBe(0);
    // E was never A's friend: untouched.
    expect(await ownCount(E)).toBe(1);
  });

  it("matches the friends list total (one definition of friends)", async () => {
    bannedIds.add(A);
    for (const id of [B, C, D, E]) {
      expect(await ownCount(id)).toBe(await listTotal(id));
    }
  });

  it("is stable under repeated reads / repeated ban processing and never negative", async () => {
    bannedIds.add(A);
    const first = await ownCount(C);
    const second = await ownCount(C);
    expect([first, second]).toEqual([0, 0]);
  });

  it("restores the friend in the count after unban (friendship was only hidden)", async () => {
    bannedIds.add(A);
    expect(await ownCount(B)).toBe(1);
    bannedIds.delete(A);
    expect(await ownCount(B)).toBe(2);
    expect(await listTotal(B)).toBe(2);
  });
});
