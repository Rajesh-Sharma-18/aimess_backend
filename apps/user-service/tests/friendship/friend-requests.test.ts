/**
 * GET /api/v1/users/friends/requests — list pending friend requests
 * (incoming / outgoing / all), offset-paginated. The friendship service runs
 * for real; we mock the friendship + user-profile repositories and the avatar
 * service (so no MinIO presign is attempted). Avatar object keys are null in
 * fixtures, so `toMediaObject` returns a null media object without I/O.
 */
jest.mock("../../src/repositories/friendship.repository.js", () => ({
  friendshipRepository: {
    findPendingRequests: jest.fn(),
    countPendingRequests: jest.fn(),
  },
}));
jest.mock("../../src/repositories/user-profile.repository.js", () => ({
  userProfileRepository: {
    findManyByUserIds: jest.fn(),
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
  makeForgedAccessToken,
} from "../helpers/auth.js";

const fRepo = friendshipRepository as unknown as {
  findPendingRequests: jest.Mock;
  countPendingRequests: jest.Mock;
};
const pRepo = userProfileRepository as unknown as {
  findManyByUserIds: jest.Mock;
};

const ME = TEST_USER_ID;
const OTHER = "33333333-3333-4333-8333-333333333333";
const OTHER2 = "55555555-5555-4555-8555-555555555555";
const FID = "44444444-4444-4444-8444-444444444444";
const FID2 = "66666666-6666-4666-8666-666666666666";

const auth = () => bearer(makeAccessToken());

function profile(userId: string) {
  return {
    userId,
    username: `u_${userId.slice(0, 4)}`,
    firstName: "Pat",
    lastName: "Lee",
    avatarUrl: null,
  };
}

function pendingRow(
  id: string,
  requesterId: string,
  addresseeId: string,
  iso = "2026-01-01T00:00:00.000Z"
) {
  return { id, requesterId, addresseeId, createdAt: new Date(iso) };
}

describe("GET /api/v1/users/friends/requests", () => {
  beforeEach(() => {
    fRepo.findPendingRequests.mockResolvedValue([]);
    fRepo.countPendingRequests.mockResolvedValue(0);
    pRepo.findManyByUserIds.mockResolvedValue([]);
  });

  it("defaults to incoming and maps items + total", async () => {
    fRepo.findPendingRequests.mockResolvedValue([pendingRow(FID, OTHER, ME)]);
    fRepo.countPendingRequests.mockResolvedValue(1);
    pRepo.findManyByUserIds.mockResolvedValue([profile(OTHER)]);

    const res = await request(app)
      .get("/api/v1/users/friends/requests")
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.requests).toHaveLength(1);

    const item = res.body.data.requests[0];
    expect(item.friendshipId).toBe(FID);
    expect(item.direction).toBe("INCOMING"); // requester is OTHER → me
    expect(item.user.userId).toBe(OTHER);
    expect(item.createdAt).toBe("2026-01-01T00:00:00.000Z");

    expect(fRepo.findPendingRequests).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ME,
        direction: "incoming",
        skip: 0,
        take: 20,
      })
    );
    expect(fRepo.countPendingRequests).toHaveBeenCalledWith(ME, "incoming");
  });

  it("labels requests I sent as OUTGOING", async () => {
    fRepo.findPendingRequests.mockResolvedValue([pendingRow(FID, ME, OTHER)]);
    fRepo.countPendingRequests.mockResolvedValue(1);
    pRepo.findManyByUserIds.mockResolvedValue([profile(OTHER)]);

    const res = await request(app)
      .get("/api/v1/users/friends/requests?direction=outgoing")
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.requests[0].direction).toBe("OUTGOING");
    expect(res.body.data.requests[0].user.userId).toBe(OTHER);
    expect(fRepo.findPendingRequests).toHaveBeenCalledWith(
      expect.objectContaining({ direction: "outgoing" })
    );
  });

  it("computes skip/take from page & limit", async () => {
    const res = await request(app)
      .get("/api/v1/users/friends/requests?page=3&limit=10")
      .set(auth());

    expect(res.status).toBe(200);
    expect(fRepo.findPendingRequests).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 10 })
    );
  });

  it("returns an empty list + total 0 and skips the profile lookup", async () => {
    const res = await request(app)
      .get("/api/v1/users/friends/requests")
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.requests).toEqual([]);
    expect(res.body.data.total).toBe(0);
    expect(pRepo.findManyByUserIds).not.toHaveBeenCalled();
  });

  it("drops requests whose peer profile is missing (deleted user) but keeps the DB total", async () => {
    fRepo.findPendingRequests.mockResolvedValue([
      pendingRow(FID, OTHER, ME),
      pendingRow(FID2, OTHER2, ME),
    ]);
    fRepo.countPendingRequests.mockResolvedValue(2);
    pRepo.findManyByUserIds.mockResolvedValue([profile(OTHER)]); // OTHER2 deleted

    const res = await request(app)
      .get("/api/v1/users/friends/requests")
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.requests).toHaveLength(1);
    expect(res.body.data.requests[0].user.userId).toBe(OTHER);
    expect(res.body.data.total).toBe(2);
  });

  it.each([
    ["invalid direction", "direction=sideways"],
    ["zero page", "page=0"],
    ["limit over max", "limit=51"],
    ["non-numeric limit", "limit=abc"],
  ])("returns 400 on validation failure: %s", async (_label, qs) => {
    const res = await request(app)
      .get(`/api/v1/users/friends/requests?${qs}`)
      .set(auth());

    expect(res.status).toBe(400);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/v1/users/friends/requests");
    expect(res.status).toBe(401);
  });

  it("returns 401 with a forged token", async () => {
    const res = await request(app)
      .get("/api/v1/users/friends/requests")
      .set(bearer(makeForgedAccessToken()));
    expect(res.status).toBe(401);
  });
});
