/**
 * GET /api/v1/users/:userId — block direction.
 *
 * Blocks are ONE-WAY (see `lib/block-visibility.ts`). The target's block hides
 * them from the viewer (404, never 403 — a 403 confirms the account exists).
 * The viewer's own block does NOT: a blocker keeps access so they can review
 * and undo it, and the row carries `isBlockedByMe`.
 */
jest.mock("../../src/repositories/user-profile.repository.js", () => ({
  userProfileRepository: {
    findPublicProfileByUserId: jest.fn(),
  },
}));
jest.mock("../../src/repositories/friendship.repository.js", () => ({
  friendshipRepository: {
    findBlock: jest.fn(async () => null),
    findByPair: jest.fn(async () => null),
    hasMutualFriend: jest.fn(async () => false),
  },
}));
jest.mock("../../src/services/avatar.service.js", () => ({
  avatarService: {
    resolveViewUrlForClient: jest.fn(async () => null),
  },
}));

import request from "supertest";

import { app } from "../../src/app.js";
import { friendshipRepository } from "../../src/repositories/friendship.repository.js";
import { userProfileRepository } from "../../src/repositories/user-profile.repository.js";
import { TEST_USER_ID, bearer, makeAccessToken } from "../helpers/auth.js";

const pRepo = userProfileRepository as unknown as Record<string, jest.Mock>;
const fRepo = friendshipRepository as unknown as Record<string, jest.Mock>;

// Deliberately NOT TEST_USER_ID — a self-read short-circuits the block lookup.
const PEER_ID = "22222222-2222-4222-8222-222222222222";
const auth = () => bearer(makeAccessToken());
const blockRow = (blockerId: string, blockedId: string) => ({
  id: "block-1",
  blockerId,
  blockedId,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
});

beforeEach(() => {
  jest.clearAllMocks();
  pRepo.findPublicProfileByUserId.mockResolvedValue({
    userId: PEER_ID,
    username: "peer",
    firstName: "Pat",
    lastName: "Peer",
    bio: null,
    avatarUrl: null,
    coverImageUrl: null,
    isOnline: false,
    lastSeenAt: null,
    friendsCount: 0,
    communitiesCount: 0,
    groupsCount: 0,
    status: "ACTIVE",
    deletedAt: null,
    privacySettings: null,
  });
  fRepo.findBlock.mockResolvedValue(null);
  fRepo.findByPair.mockResolvedValue(null);
  fRepo.hasMutualFriend.mockResolvedValue(false);
});

describe("GET /api/v1/users/:userId — block symmetry", () => {
  it("resolves the profile when neither side has blocked", async () => {
    const res = await request(app).get(`/api/v1/users/${PEER_ID}`).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.userId).toBe(PEER_ID);
  });

  it("404s when the TARGET blocked the viewer", async () => {
    fRepo.findBlock.mockImplementation(async (blocker: string) =>
      blocker === PEER_ID ? blockRow(PEER_ID, TEST_USER_ID) : null
    );

    const res = await request(app).get(`/api/v1/users/${PEER_ID}`).set(auth());

    expect(res.status).toBe(404);
  });

  it("still resolves when the VIEWER blocked the target (one-way)", async () => {
    fRepo.findBlock.mockImplementation(async (blocker: string) =>
      blocker === TEST_USER_ID ? blockRow(TEST_USER_ID, PEER_ID) : null
    );

    const res = await request(app).get(`/api/v1/users/${PEER_ID}`).set(auth());

    // The blocker keeps access — they manage and undo their own block.
    expect(res.status).toBe(200);
    expect(res.body.data.isBlockedByMe).toBe(true);
  });

  it("still resolves the caller's OWN profile (no self-block lookup)", async () => {
    pRepo.findPublicProfileByUserId.mockResolvedValue({
      userId: TEST_USER_ID,
      username: "self",
      firstName: "Self",
      lastName: "User",
      bio: null,
      avatarUrl: null,
      coverImageUrl: null,
      isOnline: true,
      lastSeenAt: null,
      friendsCount: 0,
      communitiesCount: 0,
      groupsCount: 0,
      status: "ACTIVE",
      deletedAt: null,
      privacySettings: null,
    });

    const res = await request(app)
      .get(`/api/v1/users/${TEST_USER_ID}`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(fRepo.findBlock).not.toHaveBeenCalled();
  });
});
