/**
 * GET /api/v1/users — user discovery / search across the friends|others|all
 * sections. The discovery service runs for real (relationship labelling,
 * block/friend exclusion, pagination math). We mock the friendship + profile
 * repositories and the avatar service.
 */
jest.mock("../../src/repositories/friendship.repository.js", () => ({
  friendshipRepository: {
    findAcceptedFriends: jest.fn(async () => []),
    findAllForUser: jest.fn(async () => []),
    findAllBlocks: jest.fn(async () => []),
  },
}));
jest.mock("../../src/repositories/user-profile.repository.js", () => ({
  userProfileRepository: {
    findUsersInList: jest.fn(async () => []),
    countUsersInList: jest.fn(async () => 0),
    findUsersNotInList: jest.fn(async () => []),
    countUsersNotInList: jest.fn(async () => 0),
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
import {
  TEST_USER_ID,
  bearer,
  makeAccessToken,
  makeExpiredAccessToken,
} from "../helpers/auth.js";

const fRepo = friendshipRepository as unknown as Record<string, jest.Mock>;
const pRepo = userProfileRepository as unknown as Record<string, jest.Mock>;

const auth = () => bearer(makeAccessToken());

const PEER = "33333333-3333-4333-8333-333333333333";

function discoveryProfile(i: number, overrides: Record<string, unknown> = {}) {
  return {
    userId: `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, "0")}`,
    username: `user${i}`,
    firstName: `Bob${i}`,
    lastName: "Builder",
    bio: null,
    avatarUrl: null,
    isOnline: false,
    ...overrides,
  };
}

describe("GET /api/v1/users (discovery)", () => {
  it("defaults to the 'others' section and excludes friends/blocks/self", async () => {
    fRepo.findAllForUser.mockResolvedValue([
      {
        id: "f1",
        requesterId: TEST_USER_ID,
        addresseeId: PEER,
        status: "ACCEPTED",
      },
    ]);
    fRepo.findAllBlocks.mockResolvedValue([]);
    pRepo.findUsersNotInList.mockResolvedValue([discoveryProfile(1)]);
    pRepo.countUsersNotInList.mockResolvedValue(1);

    const res = await request(app).get("/api/v1/users").set(auth());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.users).toHaveLength(1);
    expect(res.body.data.total).toBe(1);
    // Excludes self + the accepted friend PEER.
    const excludeArg = pRepo.findUsersNotInList.mock.calls[0][0];
    expect(excludeArg).toContain(TEST_USER_ID);
    expect(excludeArg).toContain(PEER);
  });

  it("labels a pending-out relationship in the 'others' section", async () => {
    fRepo.findAllForUser.mockResolvedValue([
      {
        id: "f9",
        requesterId: TEST_USER_ID,
        addresseeId: PEER,
        status: "PENDING",
      },
    ]);
    pRepo.findUsersNotInList.mockResolvedValue([
      discoveryProfile(1, { userId: PEER }),
    ]);
    pRepo.countUsersNotInList.mockResolvedValue(1);

    const res = await request(app).get("/api/v1/users").set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.users[0].relationshipStatus).toBe("PENDING_OUT");
    expect(res.body.data.users[0].friendshipId).toBe("f9");
  });

  it("returns the friends section with FRIEND relationship status", async () => {
    fRepo.findAcceptedFriends.mockResolvedValue([
      {
        id: "f1",
        requesterId: TEST_USER_ID,
        addresseeId: PEER,
        acceptedAt: new Date(),
      },
    ]);
    pRepo.findUsersInList.mockResolvedValue([
      discoveryProfile(1, { userId: PEER }),
    ]);
    pRepo.countUsersInList.mockResolvedValue(1);

    const res = await request(app)
      .get("/api/v1/users?section=friends")
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.users[0].relationshipStatus).toBe("FRIEND");
    expect(res.body.data.users[0].friendshipId).toBe("f1");
  });

  it("returns an empty friends section when the user has no friends", async () => {
    fRepo.findAcceptedFriends.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/v1/users?section=friends")
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.users).toEqual([]);
    expect(res.body.data.total).toBe(0);
    expect(pRepo.findUsersInList).not.toHaveBeenCalled();
  });

  it("supports the 'all' section with a search term and pagination", async () => {
    fRepo.findAllBlocks.mockResolvedValue([]);
    pRepo.findUsersNotInList.mockResolvedValue([discoveryProfile(2)]);
    pRepo.countUsersNotInList.mockResolvedValue(5);

    const res = await request(app)
      .get("/api/v1/users?section=all&q=bob&page=2&limit=1")
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(5);
    // page=2,limit=1 → skip=1
    expect(pRepo.findUsersNotInList).toHaveBeenCalledWith(
      expect.any(Array),
      "bob",
      1,
      1
    );
  });

  it("returns an empty list when no profiles match", async () => {
    pRepo.findUsersNotInList.mockResolvedValue([]);
    pRepo.countUsersNotInList.mockResolvedValue(0);

    const res = await request(app)
      .get("/api/v1/users?q=zzzznomatch")
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.users).toEqual([]);
    expect(res.body.data.total).toBe(0);
  });

  it.each([
    ["invalid section enum", "section=enemies"],
    ["zero page", "page=0"],
    ["negative page", "page=-1"],
    ["limit above max (50)", "limit=51"],
    ["zero limit", "limit=0"],
    ["non-numeric page", "page=two"],
    ["q over 100 chars", `q=${"a".repeat(101)}`],
  ])("returns 400 on invalid query: %s", async (_label, qs) => {
    const res = await request(app).get(`/api/v1/users?${qs}`).set(auth());

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("safely handles a NoSQL-injection-shaped q (treated as a literal string)", async () => {
    pRepo.findUsersNotInList.mockResolvedValue([]);
    pRepo.countUsersNotInList.mockResolvedValue(0);

    const res = await request(app)
      .get(`/api/v1/users?q=${encodeURIComponent('{"$ne":null}')}`)
      .set(auth());

    // Object-shaped injection is coerced to a plain string and passed as a
    // literal search term; it never reaches the DB as an operator.
    expect(res.status).toBe(200);
    expect(pRepo.findUsersNotInList).toHaveBeenCalledWith(
      expect.any(Array),
      '{"$ne":null}',
      expect.any(Number),
      expect.any(Number)
    );
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/v1/users");
    expect(res.status).toBe(401);
  });

  it("returns 401 with an expired token", async () => {
    const res = await request(app)
      .get("/api/v1/users")
      .set(bearer(makeExpiredAccessToken()));
    expect(res.status).toBe(401);
  });
});
