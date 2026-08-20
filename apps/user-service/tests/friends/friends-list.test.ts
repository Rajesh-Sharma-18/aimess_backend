/**
 * GET /api/v1/users/friends — paginated, searchable accepted-friends list.
 *
 * The friends service runs for real (cursor math, section headers). We mock the
 * friends repository (two methods: id list + profile page) and the avatar
 * service (so no MinIO presign is attempted). Avatar object key is always null
 * in fixtures, so `toMediaObject` returns a null media object without I/O.
 */
jest.mock("../../src/repositories/friends.repository.js", () => ({
  friendsRepository: {
    listAcceptedFriendIds: jest.fn(),
    listFriendProfiles: jest.fn(),
  },
}));
jest.mock("../../src/services/avatar.service.js", () => ({
  avatarService: {
    resolveViewUrlForClient: jest.fn(async () => null),
  },
}));
// `listFriends` reads the per-friend call allow-list alongside the profile page
// (one `Promise.all`). Only the friends repository was mocked, so this one hit
// a real Prisma client that the suite never configures and every populated page
// 500'd on "Cannot read properties of undefined (reading 'findMany')". The
// empty-list case passed only because it returns before this call.
jest.mock("../../src/repositories/user-settings.repository.js", () => ({
  userSettingsRepository: {
    findCallAllowedIds: jest.fn(async () => []),
  },
}));

import request from "supertest";

import { app } from "../../src/app.js";
import { friendsRepository } from "../../src/repositories/friends.repository.js";
import {
  bearer,
  makeAccessToken,
  makeExpiredAccessToken,
} from "../helpers/auth.js";

const repo = friendsRepository as unknown as {
  listAcceptedFriendIds: jest.Mock;
  listFriendProfiles: jest.Mock;
};

const auth = () => bearer(makeAccessToken());

function friendRow(i: number) {
  return {
    userId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
    username: `friend${i}`,
    firstName: `Alice${i}`,
    lastName: "Anderson",
    avatarUrl: null,
  };
}

describe("GET /api/v1/users/friends", () => {
  it("returns an empty list (not an error) when the user has no friends", async () => {
    repo.listAcceptedFriendIds.mockResolvedValue([]);

    const res = await request(app).get("/api/v1/users/friends").set(auth());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.friends).toEqual([]);
    expect(res.body.data.totalCount).toBe(0);
    expect(res.body.data.nextCursor).toBeNull();
    // Should not query profiles when there are no friend ids.
    expect(repo.listFriendProfiles).not.toHaveBeenCalled();
  });

  it("returns a page of friends with a computed section header", async () => {
    repo.listAcceptedFriendIds.mockResolvedValue(["id1", "id2"]);
    repo.listFriendProfiles.mockResolvedValue([friendRow(1), friendRow(2)]);

    const res = await request(app).get("/api/v1/users/friends").set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.friends).toHaveLength(2);
    expect(res.body.data.friends[0].section).toBe("A");
    expect(res.body.data.totalCount).toBe(2);
    expect(res.body.data.nextCursor).toBeNull();
  });

  it("sets nextCursor when there are more rows than the limit", async () => {
    repo.listAcceptedFriendIds.mockResolvedValue(["id1", "id2", "id3"]);
    // limit=2 → repo returns limit+1 (3) rows to signal "has more".
    repo.listFriendProfiles.mockResolvedValue([
      friendRow(1),
      friendRow(2),
      friendRow(3),
    ]);

    const res = await request(app)
      .get("/api/v1/users/friends?limit=2")
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.friends).toHaveLength(2);
    expect(res.body.data.nextCursor).toBe(friendRow(2).userId);
  });

  it("passes the search filter through to the repository", async () => {
    repo.listAcceptedFriendIds.mockResolvedValue(["id1"]);
    repo.listFriendProfiles.mockResolvedValue([friendRow(1)]);

    const res = await request(app)
      .get("/api/v1/users/friends?search=ali")
      .set(auth());

    expect(res.status).toBe(200);
    expect(repo.listFriendProfiles).toHaveBeenCalledWith(
      expect.objectContaining({ search: "ali" })
    );
  });

  it.each([
    ["limit above max (100)", "limit=101"],
    ["zero limit", "limit=0"],
    ["negative limit", "limit=-5"],
    ["non-numeric limit", "limit=abc"],
    ["non-uuid cursor", "cursor=not-a-uuid"],
    ["empty search", "search="],
    ["search over 100 chars", `search=${"a".repeat(101)}`],
  ])("returns 400 on invalid query: %s", async (_label, qs) => {
    const res = await request(app)
      .get(`/api/v1/users/friends?${qs}`)
      .set(auth());

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/v1/users/friends");
    expect(res.status).toBe(401);
  });

  it("returns 401 with an expired token", async () => {
    const res = await request(app)
      .get("/api/v1/users/friends")
      .set(bearer(makeExpiredAccessToken()));
    expect(res.status).toBe(401);
  });
});
