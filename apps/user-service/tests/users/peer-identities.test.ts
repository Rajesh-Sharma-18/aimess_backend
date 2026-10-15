/** POST /api/v1/users/identities — batch identity of the caller's private-chat peers. */

jest.mock("../../src/grpc/messaging.client.js", () => ({
  messagingGrpcClient: { resolvePrivateRooms: jest.fn() },
}));
jest.mock("../../src/repositories/user-profile.repository.js", () => ({
  userProfileRepository: { findManyByUserIds: jest.fn() },
}));
jest.mock("../../src/repositories/friendship.repository.js", () => ({
  friendshipRepository: { findRelationshipsForUser: jest.fn() },
}));
jest.mock("../../src/services/avatar.service.js", () => ({
  avatarService: {
    resolveViewUrlForClient: jest.fn(async (key: string | null) =>
      key ? { url: `https://cdn/${key}?sig`, expiresIn: 60 } : null
    ),
  },
}));

import request from "supertest";

import { app } from "../../src/app.js";
import { messagingGrpcClient } from "../../src/grpc/messaging.client.js";
import { userProfileRepository } from "../../src/repositories/user-profile.repository.js";
import { friendshipRepository } from "../../src/repositories/friendship.repository.js";
import { TEST_USER_ID, bearer, makeAccessToken } from "../helpers/auth.js";

const PEER = "55555555-5555-4555-8555-555555555555";
const BLOCKER = "22222222-2222-4222-8222-222222222222";
const DELETED = "33333333-3333-4333-8333-333333333333";
const STRANGER = "44444444-4444-4444-8444-444444444444";

const profile = (userId: string, extra: object = {}) => ({
  userId,
  username: `u_${userId.slice(0, 4)}`,
  firstName: "First",
  lastName: "Last",
  avatarUrl: `avatars/${userId}.jpg`,
  deletedAt: null,
  status: "ACTIVE",
  ...extra,
});

beforeEach(() => {
  (messagingGrpcClient.resolvePrivateRooms as jest.Mock).mockResolvedValue(
    [PEER, BLOCKER, DELETED].map((peerUserId) => ({ peerUserId, roomId: `prv_${peerUserId}` }))
  );
  (userProfileRepository.findManyByUserIds as jest.Mock).mockImplementation(async (ids: string[]) =>
    [profile(PEER), profile(BLOCKER), profile(DELETED, { deletedAt: new Date() })].filter((p) =>
      ids.includes(p.userId)
    )
  );
  (friendshipRepository.findRelationshipsForUser as jest.Mock).mockResolvedValue({
    rows: [],
    blockedIds: new Set(),
    blockedByIds: new Set([BLOCKER]),
  });
});

it("returns only room peers, anonymizes deleted, hides a blocker's photo", async () => {
  const res = await request(app)
    .post("/api/v1/users/identities")
    .set(bearer(makeAccessToken(TEST_USER_ID)))
    .send({ userIds: [PEER, BLOCKER, DELETED, STRANGER] });

  expect(res.status).toBe(200);
  const byId = Object.fromEntries(
    (res.body.data.users as Array<{ userId: string }>).map((u) => [u.userId, u])
  );
  expect(Object.keys(byId).sort()).toEqual([PEER, BLOCKER, DELETED].sort());
  expect(byId[PEER]).toMatchObject({ username: "u_5555", displayName: "First Last", isDeleted: false });
  expect(byId[PEER].avatarUrl).toContain(PEER);
  expect(byId[BLOCKER]).toMatchObject({ username: "u_2222", avatarUrl: null });
  expect(byId[DELETED]).toMatchObject({ username: "", avatarUrl: null, isDeleted: true });
});

it("fails closed when the messaging lookup returns nothing", async () => {
  (messagingGrpcClient.resolvePrivateRooms as jest.Mock).mockResolvedValue([]);
  const res = await request(app)
    .post("/api/v1/users/identities")
    .set(bearer(makeAccessToken(TEST_USER_ID)))
    .send({ userIds: [PEER] });

  expect(res.status).toBe(200);
  expect(res.body.data.users).toEqual([]);
});

it("rejects more than 200 ids", async () => {
  const res = await request(app)
    .post("/api/v1/users/identities")
    .set(bearer(makeAccessToken(TEST_USER_ID)))
    .send({ userIds: Array.from({ length: 201 }, () => PEER) });

  expect(res.status).toBe(400);
});
