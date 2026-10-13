/** GET /api/v1/users/by-username/:username — the chat `@handle` tap. */
jest.mock("../../src/repositories/user-profile.repository.js", () => ({
  userProfileRepository: {
    findByUsername: jest.fn(),
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
jest.mock("../../src/repositories/friends.repository.js", () => ({
  friendsRepository: { listAcceptedFriendIds: jest.fn(async () => []) },
}));
jest.mock("../../src/services/avatar.service.js", () => ({
  avatarService: { resolveViewUrlForClient: jest.fn(async () => null) },
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
const peer = {
  userId: PEER_ID,
  username: "patricktran",
  firstName: "Patrick",
  lastName: "Tran",
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
};

beforeEach(() => {
  jest.clearAllMocks();
  pRepo.findByUsername.mockResolvedValue(peer);
  pRepo.findPublicProfileByUserId.mockResolvedValue(peer);
  fRepo.findBlock.mockResolvedValue(null);
  fRepo.findByPair.mockResolvedValue(null);
});

describe("GET /api/v1/users/by-username/:username", () => {
  it("resolves the same viewer-scoped profile as /users/:userId", async () => {
    const res = await request(app).get("/api/v1/users/by-username/PatrickTran").set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.userId).toBe(PEER_ID);
    expect(pRepo.findByUsername).toHaveBeenCalledWith("PatrickTran");
    expect(pRepo.findPublicProfileByUserId).toHaveBeenCalledWith(PEER_ID);
  });

  it("404s an unknown username", async () => {
    pRepo.findByUsername.mockResolvedValue(null);

    const res = await request(app).get("/api/v1/users/by-username/nobody_here").set(auth());

    expect(res.status).toBe(404);
  });

  it("404s a reserved username whose profile is not complete yet", async () => {
    pRepo.findByUsername.mockResolvedValue({ ...peer, firstName: "", lastName: "" });

    const res = await request(app).get("/api/v1/users/by-username/patricktran").set(auth());

    expect(res.status).toBe(404);
  });

  it("keeps the block rule: the target's block 404s", async () => {
    fRepo.findBlock.mockImplementation(async (blocker: string) =>
      blocker === PEER_ID
        ? { id: "b", blockerId: PEER_ID, blockedId: TEST_USER_ID, createdAt: new Date() }
        : null
    );

    const res = await request(app).get("/api/v1/users/by-username/patricktran").set(auth());

    expect(res.status).toBe(404);
  });

  it("400s a malformed handle", async () => {
    const res = await request(app).get("/api/v1/users/by-username/bad-handle").set(auth());

    expect(res.status).toBe(400);
  });
});
