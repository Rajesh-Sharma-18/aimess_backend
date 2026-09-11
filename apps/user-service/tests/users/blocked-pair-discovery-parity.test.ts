/**
 * Discovery surfaces for a pair that has a conversation and a block.
 *
 * A block hides the blocker from the person they blocked — everywhere except a
 * pair that already has a private conversation. That pair is in the blocked
 * user's own inbox already, so subtracting it from search and Recent hid
 * nothing they could not already see; all it did was make the doors disagree.
 * The chat list opened the conversation; search dropped the row (or, once a
 * block had unfriended them, offered "Send Request" for it).
 *
 * So: a room exists → the row survives, flagged and inert. No room → the block
 * still removes the blocker from this viewer's world, and the profile 404s.
 */
jest.mock("../../src/repositories/recent-user-search.repository.js", () => ({
  recentUserSearchRepository: {
    findByUserId: jest.fn(async () => []),
    upsert: jest.fn(async () => undefined),
  },
}));
jest.mock("../../src/repositories/user-profile.repository.js", () => ({
  userProfileRepository: {
    findByUserIds: jest.fn(async () => []),
    findDiscoverableByUserIds: jest.fn(async () => []),
    findDiscoverableByNormalizedUsername: jest.fn(async () => null),
    findPublicProfileByUserId: jest.fn(async () => null),
    findUsersInList: jest.fn(async () => []),
    findUsersNotInList: jest.fn(async () => []),
  },
}));
jest.mock("../../src/repositories/friendship.repository.js", () => ({
  friendshipRepository: {
    resolveViewerGraph: jest.fn(async () => ({
      friendIds: [],
      friendOfFriendIds: [],
    })),
    hasMutualFriend: jest.fn(async () => false),
    findAllBlocks: jest.fn(async () => []),
    findAllForUser: jest.fn(async () => []),
    findBlock: jest.fn(async () => null),
    findByPair: jest.fn(async () => null),
  },
}));
jest.mock("../../src/services/avatar.service.js", () => ({
  avatarService: { resolveViewUrlForClient: jest.fn(async () => null) },
}));

import request from "supertest";

import { app } from "../../src/app.js";
import { recentUserSearchRepository } from "../../src/repositories/recent-user-search.repository.js";
import { userProfileRepository } from "../../src/repositories/user-profile.repository.js";
import { friendshipRepository } from "../../src/repositories/friendship.repository.js";
import { messagingGrpcClient } from "../../src/grpc/messaging.client.js";
import { TEST_USER_ID, bearer, makeAccessToken } from "../helpers/auth.js";

const recentRepo = recentUserSearchRepository as unknown as Record<
  string,
  jest.Mock
>;
const pRepo = userProfileRepository as unknown as Record<string, jest.Mock>;
const friendRepo = friendshipRepository as unknown as Record<string, jest.Mock>;
const grpc = messagingGrpcClient as unknown as Record<string, jest.Mock>;

const auth = () => bearer(makeAccessToken());

/** The blocker. Blocks are one-way: BLOCKER blocked TEST_USER_ID. */
const BLOCKER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROOM = "prv_shared";

const profile = (userId: string, over = {}) => ({
  userId,
  username: "janedoe",
  firstName: "Jane",
  lastName: "Doe",
  avatarUrl: null,
  isOnline: true,
  ...over,
});

/** A block against the viewer, and optionally a conversation with the blocker. */
function blockedByBlocker(opts: { withRoom: boolean }) {
  friendRepo.findAllBlocks.mockResolvedValue([
    { blockerId: BLOCKER, blockedId: TEST_USER_ID },
  ]);
  const matches = opts.withRoom ? [{ peerUserId: BLOCKER, roomId: ROOM }] : [];
  grpc.resolvePrivateRooms.mockResolvedValue(matches);
  grpc.listPrivateRoomPeers.mockResolvedValue(matches);
}

beforeEach(() => {
  jest.clearAllMocks();
  recentRepo.findByUserId.mockResolvedValue([]);
  pRepo.findDiscoverableByUserIds.mockResolvedValue([]);
  pRepo.findUsersInList.mockResolvedValue([]);
  pRepo.findUsersNotInList.mockResolvedValue([]);
  pRepo.findPublicProfileByUserId.mockResolvedValue(null);
  friendRepo.findAllBlocks.mockResolvedValue([]);
  friendRepo.findAllForUser.mockResolvedValue([]);
  friendRepo.findBlock.mockResolvedValue(null);
  friendRepo.findByPair.mockResolvedValue(null);
  friendRepo.resolveViewerGraph.mockResolvedValue({
    friendIds: [],
    friendOfFriendIds: [],
  });
  friendRepo.hasMutualFriend.mockResolvedValue(false);
  grpc.resolvePrivateRooms.mockResolvedValue([]);
  grpc.listPrivateRoomPeers.mockResolvedValue([]);
  grpc.listActiveGroups.mockResolvedValue([]);
  grpc.listOtherGroups.mockResolvedValue([]);
  grpc.getGroupsByIds.mockResolvedValue([]);
});

describe("GET /api/v1/users/search (Recent) — a blocker the viewer has a chat with", () => {
  const recentRow = {
    id: "row-1",
    userId: TEST_USER_ID,
    targetType: "USER",
    targetId: BLOCKER,
    lastViewedAt: new Date("2026-08-27T10:00:00Z"),
    createdAt: new Date("2026-08-27T10:00:00Z"),
  };

  it("keeps the row when a conversation exists — flagged, inert, carrying the roomId", async () => {
    blockedByBlocker({ withRoom: true });
    recentRepo.findByUserId.mockResolvedValue([recentRow]);
    pRepo.findDiscoverableByUserIds.mockResolvedValue([profile(BLOCKER)]);

    const res = await request(app).get("/api/v1/users/search").set(auth());

    expect(res.status).toBe(200);
    const row = res.body.data.recent[0];
    expect(row.userId).toBe(BLOCKER);
    expect(row.isBlockedByPeer).toBe(true);
    expect(row.isBlockedByMe).toBe(false);
    // The row exists so the CONVERSATION can be opened from here — same screen
    // the chat list reaches.
    expect(row.roomId).toBe(ROOM);
    // ...and offers nothing the API would refuse.
    expect(row.canSendRequest).toBe(false);
    expect(row.relationship.canSendRequest).toBe(false);
    // A blocker's presence is not a liveness probe for the person they blocked.
    expect(row.isOnline).toBe(false);
  });

  it("drops the row when there is no conversation — the block still hides them", async () => {
    blockedByBlocker({ withRoom: false });
    recentRepo.findByUserId.mockResolvedValue([recentRow]);
    pRepo.findDiscoverableByUserIds.mockResolvedValue([profile(BLOCKER)]);

    const res = await request(app).get("/api/v1/users/search").set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.recent).toHaveLength(0);
  });
});

describe("GET /api/v1/users/search?q= — the same rule on the query path", () => {
  it("keeps a blocker with a conversation out of the exclude list", async () => {
    blockedByBlocker({ withRoom: true });
    pRepo.findUsersNotInList.mockResolvedValue([profile(BLOCKER)]);

    const res = await request(app)
      .get("/api/v1/users/search?q=jane")
      .set(auth());

    expect(res.status).toBe(200);
    const excluded = pRepo.findUsersNotInList.mock.calls[0]![0] as string[];
    expect(excluded).not.toContain(BLOCKER);
    const row = res.body.data.other[0];
    expect(row.isBlockedByPeer).toBe(true);
    expect(row.roomId).toBe(ROOM);
    expect(row.canSendRequest).toBe(false);
  });

  it("still excludes a blocker the viewer has no conversation with", async () => {
    blockedByBlocker({ withRoom: false });

    await request(app).get("/api/v1/users/search?q=jane").set(auth());

    const excluded = pRepo.findUsersNotInList.mock.calls[0]![0] as string[];
    expect(excluded).toContain(BLOCKER);
  });
});

describe("GET /api/v1/users/:userId — the profile door", () => {
  const publicProfile = {
    ...profile(BLOCKER),
    bio: "hi",
    coverImageUrl: null,
    lastSeenAt: null,
    friendsCount: 3,
    groupsCount: 0,
    communitiesCount: 0,
    status: "ACTIVE",
    deletedAt: null,
    privacySettings: null,
  };

  it("resolves when the pair has a conversation — flagged, content still closed", async () => {
    pRepo.findPublicProfileByUserId.mockResolvedValue(publicProfile);
    // findBlock(target, viewer) — the blocker's block against this viewer.
    friendRepo.findBlock.mockImplementation(async (a: string) =>
      a === BLOCKER ? { id: "b1" } : null
    );
    grpc.resolvePrivateRooms.mockResolvedValue([
      { peerUserId: BLOCKER, roomId: ROOM },
    ]);

    const res = await request(app).get(`/api/v1/users/${BLOCKER}`).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.isBlockedByPeer).toBe(true);
    expect(res.body.data.isBlockedByMe).toBe(false);
    expect(res.body.data.relationship.canSendRequest).toBe(false);
    // Reachable so the conversation stays openable — not so the profile the
    // block took away comes back.
    expect(res.body.data.bio).toBeNull();
    expect(res.body.data.friendsCount).toBeNull();
    expect(res.body.data.isOnline).toBeNull();
  });

  it("still 404s when there is no conversation", async () => {
    pRepo.findPublicProfileByUserId.mockResolvedValue(publicProfile);
    friendRepo.findBlock.mockImplementation(async (a: string) =>
      a === BLOCKER ? { id: "b1" } : null
    );
    grpc.resolvePrivateRooms.mockResolvedValue([]);

    const res = await request(app).get(`/api/v1/users/${BLOCKER}`).set(auth());

    expect(res.status).toBe(404);
  });
});
