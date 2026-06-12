/**
 * /api/v1/users/friends — friendship lifecycle (send / accept / reject /
 * cancel / unfriend). The service runs for real; we mock the two repositories
 * it touches (friendship + user-profile), the user-cache, and the RabbitMQ
 * publishers (so we can assert side-effects without a broker).
 */
jest.mock("../../src/repositories/friendship.repository.js", () => ({
  friendshipRepository: {
    findByPair: jest.fn(),
    findById: jest.fn(),
    findActivePair: jest.fn(),
    findAllBlocks: jest.fn(async () => []),
    create: jest.fn(),
    resetToPending: jest.fn(),
    acceptWithCounters: jest.fn(),
    reject: jest.fn(),
    cancel: jest.fn(),
    unfriendWithCounters: jest.fn(),
  },
}));
jest.mock("../../src/repositories/user-profile.repository.js", () => ({
  userProfileRepository: {
    findByUserId: jest.fn(),
  },
}));
jest.mock("../../src/lib/user-cache.js", () => ({
  userCache: {
    invalidateProfile: jest.fn(async () => undefined),
  },
}));
jest.mock("../../src/messaging/publish-friendship.js", () => ({
  publishFriendRequestedSafe: jest.fn(),
  publishFriendAcceptedSafe: jest.fn(),
  publishFriendUnfriendedSafe: jest.fn(),
}));

import request from "supertest";

import { app } from "../../src/app.js";
import { friendshipRepository } from "../../src/repositories/friendship.repository.js";
import { userProfileRepository } from "../../src/repositories/user-profile.repository.js";
import {
  publishFriendRequestedSafe,
  publishFriendAcceptedSafe,
  publishFriendUnfriendedSafe,
} from "../../src/messaging/publish-friendship.js";
import {
  TEST_USER_ID,
  bearer,
  makeAccessToken,
  makeForgedAccessToken,
} from "../helpers/auth.js";

const fRepo = friendshipRepository as unknown as Record<string, jest.Mock>;
const pRepo = userProfileRepository as unknown as { findByUserId: jest.Mock };
const requested = publishFriendRequestedSafe as unknown as jest.Mock;
const accepted = publishFriendAcceptedSafe as unknown as jest.Mock;
const unfriended = publishFriendUnfriendedSafe as unknown as jest.Mock;

const ME = TEST_USER_ID;
const OTHER = "33333333-3333-4333-8333-333333333333";
const FRIENDSHIP_ID = "44444444-4444-4444-8444-444444444444";

const auth = () => bearer(makeAccessToken());

function liveProfile(userId: string) {
  return { userId, username: `u_${userId.slice(0, 4)}`, deletedAt: null };
}

function friendshipRow(overrides: Record<string, unknown> = {}) {
  return {
    id: FRIENDSHIP_ID,
    requesterId: ME,
    addresseeId: OTHER,
    status: "PENDING",
    acceptedAt: null,
    rejectedAt: null,
    cancelledAt: null,
    unfriendedAt: null,
    unfriendedBy: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("POST /api/v1/users/friends/requests", () => {
  beforeEach(() => {
    pRepo.findByUserId.mockImplementation(async (id: string) =>
      liveProfile(id)
    );
    fRepo.findAllBlocks.mockResolvedValue([]);
    fRepo.findByPair.mockResolvedValue(null);
    fRepo.create.mockResolvedValue(friendshipRow());
  });

  it("sends a friend request → 201 and publishes friend.requested", async () => {
    const res = await request(app)
      .post("/api/v1/users/friends/requests")
      .set(auth())
      .send({ addresseeId: OTHER });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(FRIENDSHIP_ID);
    expect(res.body.data.status).toBe("PENDING");
    expect(fRepo.create).toHaveBeenCalledWith(ME, OTHER);
    expect(requested).toHaveBeenCalledTimes(1);
  });

  it("auto-accepts a mutual pending request (they already requested me)", async () => {
    fRepo.findByPair.mockResolvedValue(
      friendshipRow({ requesterId: OTHER, addresseeId: ME, status: "PENDING" })
    );
    fRepo.acceptWithCounters.mockResolvedValue([
      friendshipRow({
        requesterId: OTHER,
        addresseeId: ME,
        status: "ACCEPTED",
        acceptedAt: new Date("2026-02-01T00:00:00.000Z"),
      }),
    ]);

    const res = await request(app)
      .post("/api/v1/users/friends/requests")
      .set(auth())
      .send({ addresseeId: OTHER });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("ACCEPTED");
    expect(accepted).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when adding yourself", async () => {
    const res = await request(app)
      .post("/api/v1/users/friends/requests")
      .set(auth())
      .send({ addresseeId: ME });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(fRepo.create).not.toHaveBeenCalled();
  });

  it("returns 404 when the addressee profile does not exist", async () => {
    pRepo.findByUserId.mockImplementation(async (id: string) =>
      id === ME ? liveProfile(ME) : null
    );

    const res = await request(app)
      .post("/api/v1/users/friends/requests")
      .set(auth())
      .send({ addresseeId: OTHER });

    expect(res.status).toBe(404);
  });

  it("returns 400 when either party has blocked the other", async () => {
    fRepo.findAllBlocks.mockResolvedValue([
      { blockerId: OTHER, blockedId: ME },
    ]);

    const res = await request(app)
      .post("/api/v1/users/friends/requests")
      .set(auth())
      .send({ addresseeId: OTHER });

    expect(res.status).toBe(400);
    expect(fRepo.create).not.toHaveBeenCalled();
  });

  it("returns 409 when already friends", async () => {
    fRepo.findByPair.mockResolvedValue(friendshipRow({ status: "ACCEPTED" }));

    const res = await request(app)
      .post("/api/v1/users/friends/requests")
      .set(auth())
      .send({ addresseeId: OTHER });

    expect(res.status).toBe(409);
  });

  it("returns 409 when a request was already sent by me", async () => {
    fRepo.findByPair.mockResolvedValue(
      friendshipRow({ requesterId: ME, addresseeId: OTHER, status: "PENDING" })
    );

    const res = await request(app)
      .post("/api/v1/users/friends/requests")
      .set(auth())
      .send({ addresseeId: OTHER });

    expect(res.status).toBe(409);
  });

  it("recycles a previously REJECTED row back to PENDING", async () => {
    fRepo.findByPair.mockResolvedValue(friendshipRow({ status: "REJECTED" }));
    fRepo.resetToPending.mockResolvedValue(
      friendshipRow({ status: "PENDING" })
    );

    const res = await request(app)
      .post("/api/v1/users/friends/requests")
      .set(auth())
      .send({ addresseeId: OTHER });

    expect(res.status).toBe(201);
    expect(fRepo.resetToPending).toHaveBeenCalledWith(FRIENDSHIP_ID, ME, OTHER);
    expect(requested).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing addresseeId", {}],
    ["non-uuid addresseeId", { addresseeId: "not-a-uuid" }],
    ["numeric addresseeId", { addresseeId: 123 }],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app)
      .post("/api/v1/users/friends/requests")
      .set(auth())
      .send(body);

    expect(res.status).toBe(400);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app)
      .post("/api/v1/users/friends/requests")
      .send({ addresseeId: OTHER });

    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/users/friends/requests/:id/accept", () => {
  it("accepts an incoming pending request → 200", async () => {
    fRepo.findById.mockResolvedValue(
      friendshipRow({ requesterId: OTHER, addresseeId: ME, status: "PENDING" })
    );
    fRepo.acceptWithCounters.mockResolvedValue([
      friendshipRow({
        requesterId: OTHER,
        addresseeId: ME,
        status: "ACCEPTED",
        acceptedAt: new Date("2026-02-01T00:00:00.000Z"),
      }),
    ]);

    const res = await request(app)
      .post(`/api/v1/users/friends/requests/${FRIENDSHIP_ID}/accept`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ACCEPTED");
    expect(accepted).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when the request is not addressed to me (IDOR guard)", async () => {
    // I am neither requester nor addressee — addressed to someone else.
    fRepo.findById.mockResolvedValue(
      friendshipRow({
        requesterId: OTHER,
        addresseeId: "99999999-9999-4999-8999-999999999999",
        status: "PENDING",
      })
    );

    const res = await request(app)
      .post(`/api/v1/users/friends/requests/${FRIENDSHIP_ID}/accept`)
      .set(auth());

    expect(res.status).toBe(404);
    expect(fRepo.acceptWithCounters).not.toHaveBeenCalled();
  });

  it("returns 404 when the friendship does not exist", async () => {
    fRepo.findById.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/v1/users/friends/requests/${FRIENDSHIP_ID}/accept`)
      .set(auth());

    expect(res.status).toBe(404);
  });

  it("returns 400 on a non-uuid id param", async () => {
    const res = await request(app)
      .post(`/api/v1/users/friends/requests/not-a-uuid/accept`)
      .set(auth());

    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/users/friends/requests/:id/reject", () => {
  it("rejects an incoming pending request → 200", async () => {
    fRepo.findById.mockResolvedValue(
      friendshipRow({ requesterId: OTHER, addresseeId: ME, status: "PENDING" })
    );
    fRepo.reject.mockResolvedValue(friendshipRow({ status: "REJECTED" }));

    const res = await request(app)
      .post(`/api/v1/users/friends/requests/${FRIENDSHIP_ID}/reject`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(fRepo.reject).toHaveBeenCalledWith(FRIENDSHIP_ID);
  });

  it("returns 404 when I am the requester, not the addressee", async () => {
    fRepo.findById.mockResolvedValue(
      friendshipRow({ requesterId: ME, addresseeId: OTHER, status: "PENDING" })
    );

    const res = await request(app)
      .post(`/api/v1/users/friends/requests/${FRIENDSHIP_ID}/reject`)
      .set(auth());

    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/v1/users/friends/requests/:id (cancel)", () => {
  it("cancels my own outgoing pending request → 200", async () => {
    fRepo.findById.mockResolvedValue(
      friendshipRow({ requesterId: ME, addresseeId: OTHER, status: "PENDING" })
    );
    fRepo.cancel.mockResolvedValue(friendshipRow({ status: "CANCELLED" }));

    const res = await request(app)
      .delete(`/api/v1/users/friends/requests/${FRIENDSHIP_ID}`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(fRepo.cancel).toHaveBeenCalledWith(FRIENDSHIP_ID);
  });

  it("returns 404 when cancelling a request I did not send (IDOR guard)", async () => {
    fRepo.findById.mockResolvedValue(
      friendshipRow({ requesterId: OTHER, addresseeId: ME, status: "PENDING" })
    );

    const res = await request(app)
      .delete(`/api/v1/users/friends/requests/${FRIENDSHIP_ID}`)
      .set(auth());

    expect(res.status).toBe(404);
    expect(fRepo.cancel).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/v1/users/friends/:userId (unfriend)", () => {
  it("unfriends an active friend → 200 and publishes friend.unfriended", async () => {
    fRepo.findActivePair.mockResolvedValue(
      friendshipRow({ status: "ACCEPTED" })
    );
    fRepo.unfriendWithCounters.mockResolvedValue([]);

    const res = await request(app)
      .delete(`/api/v1/users/friends/${OTHER}`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(unfriended).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when trying to unfriend yourself", async () => {
    const res = await request(app)
      .delete(`/api/v1/users/friends/${ME}`)
      .set(auth());

    expect(res.status).toBe(400);
  });

  it("returns 404 when no active friendship exists", async () => {
    fRepo.findActivePair.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/v1/users/friends/${OTHER}`)
      .set(auth());

    expect(res.status).toBe(404);
  });

  it("returns 400 on a non-uuid userId param", async () => {
    const res = await request(app)
      .delete(`/api/v1/users/friends/not-a-uuid`)
      .set(auth());

    expect(res.status).toBe(400);
  });

  it("returns 401 with a forged token", async () => {
    const res = await request(app)
      .delete(`/api/v1/users/friends/${OTHER}`)
      .set(bearer(makeForgedAccessToken()));

    expect(res.status).toBe(401);
  });
});
