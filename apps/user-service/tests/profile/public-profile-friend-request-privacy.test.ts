/**
 * GET /api/v1/users/:userId — `relationship.canSendRequest` on the wire.
 *
 * `friend-request-eligibility.test.ts` pins the DECISION; this pins the
 * PLUMBING: that the profile endpoint actually resolves the target's
 * `whoCanSendFriendRequests`, pays for the mutual-friend lookup only when the
 * scope needs it, and never returns the raw scope to the viewer.
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

const PEER_ID = "22222222-2222-4222-8222-222222222222";
const auth = () => bearer(makeAccessToken());

const profileWithScope = (whoCanSendFriendRequests: string | null) => ({
  userId: PEER_ID,
  username: "spiderman_123",
  firstName: "Peter",
  lastName: "Parker",
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
  privacySettings:
    whoCanSendFriendRequests === null
      ? null
      : {
          whoCanViewProfile: "EVERYONE",
          whoCanSeeOnlineStatus: "EVERYONE",
          whoCanSendFriendRequests,
        },
});

const getProfile = () =>
  request(app).get(`/api/v1/users/${PEER_ID}`).set(auth());

beforeEach(() => {
  jest.clearAllMocks();
  fRepo.findBlock.mockResolvedValue(null);
  fRepo.findByPair.mockResolvedValue(null);
  fRepo.hasMutualFriend.mockResolvedValue(false);
});

describe("GET /api/v1/users/:userId — relationship.canSendRequest", () => {
  it("EVERYONE → a stranger may send", async () => {
    pRepo.findPublicProfileByUserId.mockResolvedValue(
      profileWithScope("EVERYONE")
    );

    const res = await getProfile();

    expect(res.status).toBe(200);
    expect(res.body.data.relationship.status).toBe("NONE");
    expect(res.body.data.relationship.canSendRequest).toBe(true);
  });

  it("NO_ONE → the profile still resolves, the action does not", async () => {
    pRepo.findPublicProfileByUserId.mockResolvedValue(
      profileWithScope("NO_ONE")
    );

    const res = await getProfile();

    // The row stays discoverable and readable — only the ACTION is withheld.
    expect(res.status).toBe(200);
    expect(res.body.data.username).toBe("spiderman_123");
    expect(res.body.data.relationship.canSendRequest).toBe(false);
  });

  it("FRIENDS → a stranger may not send", async () => {
    pRepo.findPublicProfileByUserId.mockResolvedValue(
      profileWithScope("FRIENDS")
    );

    const res = await getProfile();

    expect(res.body.data.relationship.canSendRequest).toBe(false);
  });

  it("FRIENDS_OF_FRIENDS → resolves the mutual-friend edge and admits on a hit", async () => {
    pRepo.findPublicProfileByUserId.mockResolvedValue(
      profileWithScope("FRIENDS_OF_FRIENDS")
    );
    fRepo.hasMutualFriend.mockResolvedValue(true);

    const res = await getProfile();

    expect(fRepo.hasMutualFriend).toHaveBeenCalledWith(TEST_USER_ID, PEER_ID);
    expect(res.body.data.relationship.canSendRequest).toBe(true);
  });

  it("FRIENDS_OF_FRIENDS with no mutual friend → refused", async () => {
    pRepo.findPublicProfileByUserId.mockResolvedValue(
      profileWithScope("FRIENDS_OF_FRIENDS")
    );
    fRepo.hasMutualFriend.mockResolvedValue(false);

    const res = await getProfile();

    expect(res.body.data.relationship.canSendRequest).toBe(false);
  });

  it("skips the mutual-friend query when neither scope needs it", async () => {
    pRepo.findPublicProfileByUserId.mockResolvedValue(
      profileWithScope("NO_ONE")
    );

    await getProfile();

    expect(fRepo.hasMutualFriend).not.toHaveBeenCalled();
  });

  it("no privacy row → the schema default (EVERYONE) still admits", async () => {
    pRepo.findPublicProfileByUserId.mockResolvedValue(profileWithScope(null));

    const res = await getProfile();

    expect(res.body.data.relationship.canSendRequest).toBe(true);
  });

  it("an existing friendship keeps its state and offers no re-send", async () => {
    pRepo.findPublicProfileByUserId.mockResolvedValue(
      profileWithScope("EVERYONE")
    );
    fRepo.findByPair.mockResolvedValue({
      id: "f-1",
      requesterId: TEST_USER_ID,
      addresseeId: PEER_ID,
      status: "ACCEPTED",
    });

    const res = await getProfile();

    expect(res.body.data.relationship.status).toBe("FRIEND");
    expect(res.body.data.relationship.canSendRequest).toBe(false);
  });

  it("an incoming PENDING request stays acceptable even under NO_ONE", async () => {
    // The peer's setting governs who may CREATE a request, not who may answer
    // one already in flight — `canAccept` must survive it.
    pRepo.findPublicProfileByUserId.mockResolvedValue(
      profileWithScope("NO_ONE")
    );
    fRepo.findByPair.mockResolvedValue({
      id: "f-2",
      requesterId: PEER_ID,
      addresseeId: TEST_USER_ID,
      status: "PENDING",
    });

    const res = await getProfile();

    expect(res.body.data.relationship.status).toBe("PENDING");
    expect(res.body.data.relationship.direction).toBe("INCOMING");
    expect(res.body.data.relationship.canAccept).toBe(true);
    expect(res.body.data.relationship.canSendRequest).toBe(false);
  });

  it("never returns the target's raw privacy configuration", async () => {
    pRepo.findPublicProfileByUserId.mockResolvedValue(
      profileWithScope("NO_ONE")
    );

    const res = await getProfile();

    expect(JSON.stringify(res.body)).not.toContain("whoCanSendFriendRequests");
    expect(JSON.stringify(res.body)).not.toContain("NO_ONE");
  });
});
