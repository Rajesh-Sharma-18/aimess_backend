/**
 * A platform-banned account is gone from discovery, but a ban does not erase
 * history: a viewer who already shares a private conversation with it can still
 * open its profile (read-only). Anyone else gets the same 404 as a missing user.
 *
 * The conversation is resolved server-side from the JWT viewer id; nothing the
 * client sends (a roomId, a flag) can widen access.
 */
jest.mock("../../src/repositories/user-profile.repository.js", () => ({
  userProfileRepository: {
    findPublicProfileByUserId: jest.fn(async () => null),
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
  avatarService: { resolveViewUrlForClient: jest.fn(async () => null) },
}));

import request from "supertest";

import { app } from "../../src/app.js";
import { userProfileRepository } from "../../src/repositories/user-profile.repository.js";
import { friendshipRepository } from "../../src/repositories/friendship.repository.js";
import { messagingGrpcClient } from "../../src/grpc/messaging.client.js";
import { TEST_USER_ID, bearer, makeAccessToken } from "../helpers/auth.js";

const pRepo = userProfileRepository as unknown as Record<string, jest.Mock>;
const friendRepo = friendshipRepository as unknown as Record<string, jest.Mock>;
const grpc = messagingGrpcClient as unknown as Record<string, jest.Mock>;

const MIND_FLAYER = "1b98aed5-cc15-41d6-95bb-bef47a44f063";
const ROOM = "prv_PP3Zn6RX8d-YYwhY";

const publicProfile = (status: string) => ({
  userId: MIND_FLAYER,
  username: "mind_flayer",
  firstName: "Mind",
  lastName: "Flayer",
  avatarUrl: null,
  isOnline: true,
  bio: "hi",
  coverImageUrl: null,
  lastSeenAt: new Date(),
  friendsCount: 3,
  groupsCount: 1,
  communitiesCount: 0,
  status,
  deletedAt: null,
  privacySettings: {
    whoCanViewProfile: "EVERYONE",
    whoCanSeeOnlineStatus: "EVERYONE",
    whoCanSendFriendRequests: "EVERYONE",
  },
});

const get = (path = `/api/v1/users/${MIND_FLAYER}`) =>
  request(app).get(path).set(bearer(makeAccessToken()));

beforeEach(() => {
  jest.clearAllMocks();
  friendRepo.findBlock.mockResolvedValue(null);
  friendRepo.findByPair.mockResolvedValue(null);
  grpc.resolvePrivateRooms.mockResolvedValue([]);
});

describe("GET /api/v1/users/:userId — banned target", () => {
  it("active target with a conversation: normal profile", async () => {
    pRepo.findPublicProfileByUserId.mockResolvedValue(publicProfile("ACTIVE"));
    grpc.resolvePrivateRooms.mockResolvedValue([
      { peerUserId: MIND_FLAYER, roomId: ROOM },
    ]);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.data.isBanned).toBe(false);
  });

  it("banned target + existing private conversation: profile still viewable, read-only", async () => {
    pRepo.findPublicProfileByUserId.mockResolvedValue(publicProfile("BANNED"));
    grpc.resolvePrivateRooms.mockResolvedValue([
      { peerUserId: MIND_FLAYER, roomId: ROOM },
    ]);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.data.isBanned).toBe(true);
    expect(res.body.data.username).toBe("mind_flayer");
    // No presence and no new interaction offered.
    expect(res.body.data.isOnline).toBeNull();
    expect(res.body.data.lastSeenAt).toBeNull();
    expect(res.body.data.relationship.canSendRequest).toBe(false);
    // The room is looked up for the JWT viewer, never a client-supplied id.
    expect(grpc.resolvePrivateRooms).toHaveBeenCalledWith(TEST_USER_ID, [
      MIND_FLAYER,
    ]);
  });

  it("banned target + no conversation (unrelated viewer): 404", async () => {
    pRepo.findPublicProfileByUserId.mockResolvedValue(publicProfile("BANNED"));
    const res = await get();
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("USER_PROFILE_NOT_FOUND");
  });

  it("a client-supplied roomId cannot stand in for a real conversation", async () => {
    pRepo.findPublicProfileByUserId.mockResolvedValue(publicProfile("BANNED"));
    const res = await get(
      `/api/v1/users/${MIND_FLAYER}?roomId=${ROOM}&hasConversation=true`
    );
    expect(res.status).toBe(404);
  });

  it("chat-service outage fails closed", async () => {
    pRepo.findPublicProfileByUserId.mockResolvedValue(publicProfile("BANNED"));
    grpc.resolvePrivateRooms.mockResolvedValue([]); // breaker fallback
    expect((await get()).status).toBe(404);
  });

  it("a target who blocked the viewer stays content-closed even with a room", async () => {
    pRepo.findPublicProfileByUserId.mockResolvedValue(publicProfile("BANNED"));
    grpc.resolvePrivateRooms.mockResolvedValue([
      { peerUserId: MIND_FLAYER, roomId: ROOM },
    ]);
    friendRepo.findBlock.mockImplementation(async (a: string) =>
      a === MIND_FLAYER ? { id: "b1" } : null
    );
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.data.isBlockedByPeer).toBe(true);
    expect(res.body.data.bio).toBeNull();
  });

  it("unbanned target: normal profile, add-friend eligibility back", async () => {
    pRepo.findPublicProfileByUserId.mockResolvedValue(publicProfile("ACTIVE"));
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.data.isBanned).toBe(false);
    expect(res.body.data.relationship.canSendRequest).toBe(true);
  });
});
