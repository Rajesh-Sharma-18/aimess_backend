import request from "supertest";

import { app } from "../../src/app.js";
import { prisma } from "../../src/config/prisma.js";
import { messagingGrpcClient } from "../../src/grpc/messaging.client.js";
import {
  buildUserSearchFilter,
  decodePeopleCursor,
  encodePeopleCursor,
} from "../../src/lib/user-search.util.js";
import { userProfileRepository } from "../../src/repositories/user-profile.repository.js";
import { bearer, makeAccessToken } from "../helpers/auth.js";

const grpc = messagingGrpcClient as unknown as Record<string, jest.Mock>;
const db = prisma as unknown as Record<string, unknown>;
const VIEWER = { friendIds: [], friendOfFriendIds: [] } as never;

describe("people search filter", () => {
  it("matches nothing for a query with no searchable characters", () => {
    for (const q of ["%", "_", ".", "-", "😀", "@ _"]) {
      expect(buildUserSearchFilter(q)).toEqual([{ userId: { in: [] } }]);
    }
  });

  it("browses (no text filter) on a bare @ — the start of a handle search", () => {
    for (const q of ["@", "@@", " @ "]) {
      expect(buildUserSearchFilter(q)).toEqual([]);
    }
  });

  it("ignores punctuation tokens next to a real one", () => {
    expect(buildUserSearchFilter("@ jane")).toHaveLength(1);
  });
});

describe("people search cursor", () => {
  it("round-trips a real cursor", () => {
    const row = {
      firstName: "Jane",
      userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    expect(decodePeopleCursor(encodePeopleCursor(row))).toEqual(row);
  });

  it("throws INVALID_CURSOR on garbage", () => {
    expect(() => decodePeopleCursor("not-a-real-cursor")).toThrow(
      "INVALID_CURSOR"
    );
  });
});

describe("discovery excludes incomplete profiles", () => {
  const findMany = jest.fn(async () => []);
  const findFirst = jest.fn(async () => null);
  beforeEach(() => {
    findMany.mockClear();
    findFirst.mockClear();
    db.userProfile = { findMany, findFirst };
  });

  const complete = {
    username: { not: "" },
    firstName: { not: "" },
    lastName: { not: "" },
  };

  it("in the Other People keyset", async () => {
    await userProfileRepository.findUsersNotInList([], "jane", 0, 10, VIEWER);
    expect(findMany.mock.calls[0]).toEqual([
      expect.objectContaining({ where: expect.objectContaining(complete) }),
    ]);
  });

  it("in the exact-handle head", async () => {
    await userProfileRepository.findDiscoverableByNormalizedUsername(
      "jane",
      VIEWER
    );
    expect(findFirst.mock.calls[0]).toEqual([
      expect.objectContaining({ where: expect.objectContaining(complete) }),
    ]);
  });

  it("in recent searches", async () => {
    await userProfileRepository.findDiscoverableByUserIds(["x"], VIEWER);
    expect(findMany.mock.calls[0]).toEqual([
      expect.objectContaining({ where: expect.objectContaining(complete) }),
    ]);
  });
});

describe("GET /api/v1/users/search/groups", () => {
  it("503s when chat-service cannot answer, instead of 'no groups'", async () => {
    grpc.searchActiveGroups.mockRejectedValueOnce(new Error("UNAVAILABLE"));
    const res = await request(app)
      .get("/api/v1/users/search/groups")
      .query({ q: "team" })
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(503);
  });
});
