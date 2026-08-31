/**
 * GET /api/v1/users — three modes:
 *   no type  → split mode  (friends[] + otherPeople[], max 5 each, no pagination)
 *   type=friends → paginated friends only  (users[] + pagination{})
 *   type=others  → paginated non-friends   (users[] + pagination{})
 *
 * Mocks: friendship + profile repositories and avatar service.
 */
jest.mock("../../src/repositories/friendship.repository.js", () => ({
  friendshipRepository: {
    resolveViewerGraph: jest.fn(async () => ({
      friendIds: [],
      friendOfFriendIds: [],
    })),
    hasMutualFriend: jest.fn(async () => false),
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

const PEER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PEER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function profile(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    userId,
    username: `user_${userId.slice(0, 4)}`,
    firstName: "Alice",
    lastName: "Smith",
    bio: null,
    avatarUrl: null,
    isOnline: false,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  fRepo.findAcceptedFriends.mockResolvedValue([]);
  fRepo.findAllForUser.mockResolvedValue([]);
  fRepo.findAllBlocks.mockResolvedValue([]);
  pRepo.findUsersInList.mockResolvedValue([]);
  pRepo.countUsersInList.mockResolvedValue(0);
  pRepo.findUsersNotInList.mockResolvedValue([]);
  pRepo.countUsersNotInList.mockResolvedValue(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// SPLIT MODE  (no type param)
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/v1/users — split mode (no type)", () => {
  it("puts an accepted friend in friends[] and a stranger in otherPeople[]", async () => {
    fRepo.findAcceptedFriends.mockResolvedValue([
      {
        id: "f1",
        requesterId: TEST_USER_ID,
        addresseeId: PEER_A,
        acceptedAt: new Date(),
      },
    ]);
    pRepo.findUsersInList.mockResolvedValue([profile(PEER_A)]);
    pRepo.countUsersInList.mockResolvedValue(1);

    fRepo.findAllForUser.mockResolvedValue([
      {
        id: "f1",
        requesterId: TEST_USER_ID,
        addresseeId: PEER_A,
        status: "ACCEPTED",
      },
    ]);
    pRepo.findUsersNotInList.mockResolvedValue([profile(PEER_B)]);
    pRepo.countUsersNotInList.mockResolvedValue(1);

    const res = await request(app).get("/api/v1/users").set(auth());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.friends).toHaveLength(1);
    expect(res.body.data.friends[0].userId).toBe(PEER_A);
    expect(res.body.data.friends[0].relationshipStatus).toBe("FRIEND");
    expect(res.body.data.otherPeople).toHaveLength(1);
    expect(res.body.data.otherPeople[0].userId).toBe(PEER_B);
    // No pagination in split mode
    expect(res.body.data.pagination).toBeUndefined();
  });

  it("queries each group with skip=0 and limit=5", async () => {
    fRepo.findAcceptedFriends.mockResolvedValue([
      {
        id: "f1",
        requesterId: TEST_USER_ID,
        addresseeId: PEER_A,
        acceptedAt: new Date(),
      },
    ]);
    pRepo.findUsersInList.mockResolvedValue([]);

    await request(app).get("/api/v1/users?q=alice").set(auth());

    expect(pRepo.findUsersInList).toHaveBeenCalledWith(
      expect.any(Array),
      "alice",
      0,
      5
    );
    expect(pRepo.findUsersNotInList).toHaveBeenCalledWith(
      expect.any(Array),
      "alice",
      0,
      5,
      expect.objectContaining({ friendIds: expect.any(Array) })
    );
  });

  it("labels an outgoing request as PENDING with requesterId=self (split mode)", async () => {
    fRepo.findAllForUser.mockResolvedValue([
      {
        id: "f9",
        requesterId: TEST_USER_ID,
        addresseeId: PEER_A,
        status: "PENDING",
      },
    ]);
    pRepo.findUsersNotInList.mockResolvedValue([profile(PEER_A)]);
    pRepo.countUsersNotInList.mockResolvedValue(1);

    const res = await request(app).get("/api/v1/users").set(auth());

    expect(res.body.data.friends).toHaveLength(0);
    expect(res.body.data.otherPeople[0].relationshipStatus).toBe("PENDING");
    expect(res.body.data.otherPeople[0].requesterId).toBe(TEST_USER_ID);
    expect(res.body.data.otherPeople[0].friendshipId).toBe("f9");
  });

  it("labels an incoming request as PENDING with requesterId=peer (split mode)", async () => {
    fRepo.findAllForUser.mockResolvedValue([
      {
        id: "f2",
        requesterId: PEER_A,
        addresseeId: TEST_USER_ID,
        status: "PENDING",
      },
    ]);
    pRepo.findUsersNotInList.mockResolvedValue([profile(PEER_A)]);
    pRepo.countUsersNotInList.mockResolvedValue(1);

    const res = await request(app).get("/api/v1/users").set(auth());

    expect(res.body.data.otherPeople[0].relationshipStatus).toBe("PENDING");
    expect(res.body.data.otherPeople[0].requesterId).toBe(PEER_A);
  });

  it("returns both arrays empty when no matches", async () => {
    const res = await request(app)
      .get("/api/v1/users?q=zzzznomatch")
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.friends).toEqual([]);
    expect(res.body.data.otherPeople).toEqual([]);
    expect(res.body.data.pagination).toBeUndefined();
  });

  it("skips findUsersInList entirely when user has no accepted friends", async () => {
    // findAcceptedFriends returns [] → _queryFriends short-circuits
    pRepo.findUsersNotInList.mockResolvedValue([profile(PEER_B)]);
    pRepo.countUsersNotInList.mockResolvedValue(1);

    const res = await request(app).get("/api/v1/users").set(auth());

    expect(pRepo.findUsersInList).not.toHaveBeenCalled();
    expect(res.body.data.friends).toEqual([]);
    expect(res.body.data.otherPeople).toHaveLength(1);
  });

  it("excludes accepted friends from the others DB query", async () => {
    fRepo.findAllForUser.mockResolvedValue([
      {
        id: "f1",
        requesterId: TEST_USER_ID,
        addresseeId: PEER_A,
        status: "ACCEPTED",
      },
    ]);

    await request(app).get("/api/v1/users").set(auth());

    const excludeArg: string[] = pRepo.findUsersNotInList.mock.calls[0][0];
    expect(excludeArg).toContain(TEST_USER_ID);
    expect(excludeArg).toContain(PEER_A); // friend excluded from others query
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TYPE=FRIENDS MODE
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/v1/users?type=friends", () => {
  it("returns paginated users[] with pagination metadata", async () => {
    fRepo.findAcceptedFriends.mockResolvedValue([
      {
        id: "f1",
        requesterId: TEST_USER_ID,
        addresseeId: PEER_A,
        acceptedAt: new Date(),
      },
    ]);
    pRepo.findUsersInList.mockResolvedValue([profile(PEER_A)]);
    pRepo.countUsersInList.mockResolvedValue(10);

    const res = await request(app)
      .get("/api/v1/users?type=friends&page=2&limit=5")
      .set(auth());

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.users)).toBe(true);
    expect(res.body.data.users[0].userId).toBe(PEER_A);
    expect(res.body.data.users[0].relationshipStatus).toBe("FRIEND");
    expect(res.body.data.pagination.total).toBe(10);
    expect(res.body.data.pagination.page).toBe(2);
    expect(res.body.data.pagination.limit).toBe(5);
    expect(res.body.data.pagination.totalPages).toBe(2);
    expect(res.body.data.pagination.hasNext).toBe(false);
    expect(res.body.data.pagination.hasPrevious).toBe(true);
    // No split-mode fields
    expect(res.body.data.friends).toBeUndefined();
    expect(res.body.data.otherPeople).toBeUndefined();
  });

  it("returns empty users[] when user has no friends", async () => {
    // findAcceptedFriends returns [] → short-circuits before findUsersInList
    const res = await request(app)
      .get("/api/v1/users?type=friends")
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.users).toEqual([]);
    expect(res.body.data.pagination.total).toBe(0);
    expect(pRepo.findUsersInList).not.toHaveBeenCalled();
  });

  it("passes q and pagination skip to the repository", async () => {
    fRepo.findAcceptedFriends.mockResolvedValue([
      {
        id: "f1",
        requesterId: TEST_USER_ID,
        addresseeId: PEER_A,
        acceptedAt: new Date(),
      },
    ]);

    await request(app)
      .get("/api/v1/users?type=friends&q=alice&page=3&limit=2")
      .set(auth());

    // page=3, limit=2 → skip=4
    expect(pRepo.findUsersInList).toHaveBeenCalledWith(
      expect.any(Array),
      "alice",
      4,
      2
    );
  });

  it("does not call findUsersNotInList or findAllForUser", async () => {
    fRepo.findAcceptedFriends.mockResolvedValue([]);

    await request(app).get("/api/v1/users?type=friends").set(auth());

    expect(pRepo.findUsersNotInList).not.toHaveBeenCalled();
    expect(fRepo.findAllForUser).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TYPE=OTHERS MODE
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/v1/users?type=others", () => {
  it("returns paginated users[] excluding friends and blocked users", async () => {
    fRepo.findAllForUser.mockResolvedValue([
      {
        id: "f1",
        requesterId: TEST_USER_ID,
        addresseeId: PEER_A,
        status: "ACCEPTED",
      },
    ]);
    fRepo.findAllBlocks.mockResolvedValue([]);
    pRepo.findUsersNotInList.mockResolvedValue([profile(PEER_B)]);
    pRepo.countUsersNotInList.mockResolvedValue(5);

    const res = await request(app).get("/api/v1/users?type=others").set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.users[0].userId).toBe(PEER_B);
    expect(res.body.data.pagination.total).toBe(5);
    // Accepted friend PEER_A excluded from DB query
    const excludeArg: string[] = pRepo.findUsersNotInList.mock.calls[0][0];
    expect(excludeArg).toContain(PEER_A);
    // No split-mode fields
    expect(res.body.data.friends).toBeUndefined();
    expect(res.body.data.otherPeople).toBeUndefined();
  });

  it("labels an outgoing request as PENDING with requesterId=self in type=others results", async () => {
    fRepo.findAllForUser.mockResolvedValue([
      {
        id: "f9",
        requesterId: TEST_USER_ID,
        addresseeId: PEER_A,
        status: "PENDING",
      },
    ]);
    pRepo.findUsersNotInList.mockResolvedValue([profile(PEER_A)]);
    pRepo.countUsersNotInList.mockResolvedValue(1);

    const res = await request(app).get("/api/v1/users?type=others").set(auth());

    expect(res.body.data.users[0].relationshipStatus).toBe("PENDING");
    expect(res.body.data.users[0].requesterId).toBe(TEST_USER_ID);
    expect(res.body.data.users[0].friendshipId).toBe("f9");
  });

  it("passes q and skip correctly", async () => {
    fRepo.findAllBlocks.mockResolvedValue([]);

    await request(app)
      .get("/api/v1/users?type=others&q=bob&page=2&limit=1")
      .set(auth());

    // page=2, limit=1 → skip=1
    expect(pRepo.findUsersNotInList).toHaveBeenCalledWith(
      expect.any(Array),
      "bob",
      1,
      1,
      expect.objectContaining({ friendIds: expect.any(Array) })
    );
  });

  it("does not call findAcceptedFriends or findUsersInList", async () => {
    await request(app).get("/api/v1/users?type=others").set(auth());

    expect(fRepo.findAcceptedFriends).not.toHaveBeenCalled();
    expect(pRepo.findUsersInList).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/v1/users — validation", () => {
  it.each([
    ["invalid type enum", "type=everyone"],
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
    const res = await request(app)
      .get(`/api/v1/users?q=${encodeURIComponent('{"$ne":null}')}`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(pRepo.findUsersNotInList).toHaveBeenCalledWith(
      expect.any(Array),
      '{"$ne":null}',
      expect.any(Number),
      expect.any(Number),
      expect.objectContaining({ friendIds: expect.any(Array) })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/v1/users — auth", () => {
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
