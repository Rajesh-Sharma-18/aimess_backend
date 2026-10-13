/**
 * Group invite-link reset: POST /api/chat/invite-links/room/:roomId/reset.
 * One shared ACTIVE link per group; reset revokes all and mints one; a join
 * racing a reset is decided by the atomic use claim on the ACTIVE row.
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "grp_room_1";
const OLD = "old-token-1234567890";
const reset = () =>
  request(app)
    .post(`/api/chat/invite-links/room/${ROOM}/reset`)
    .set(bearer(makeAccessToken()));

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
  mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
    roomId: ROOM,
    status: "ACTIVE",
    settings: {},
  });
  mocks.groupInviteLinkRepo.findActiveByRoom.mockResolvedValue([
    { token: OLD, roomId: ROOM, shareName: "" },
  ]);
  mocks.groupInviteLinkRepo.create.mockImplementation(async (d: object) => d);
});

describe("reset", () => {
  it("admin: revokes every active link, mints ONE shared link, announces without the token", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({ role: "ADMIN" });
    mocks.groupMemberRepo.findActiveMembers.mockResolvedValue([
      { userId: TEST_USER_ID },
      { userId: "member-2" },
    ]);

    const res = await reset();

    expect(res.status).toBe(200);
    expect(mocks.groupInviteLinkRepo.revokeAllForRoom).toHaveBeenCalledWith(ROOM, TEST_USER_ID);
    expect(res.body.data.revoked.token).toBe(OLD);
    expect(res.body.data.link.token).not.toBe(OLD);
    expect(res.body.data.link.token).toHaveLength(24);
    expect(mocks.groupInviteLinkRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ activeKey: ROOM, expiresAt: null })
    );
    await new Promise((r) => setImmediate(r));
    const published = mocks.redis.publish.mock.calls.filter(([, body]: [string, string]) =>
      body.includes("group:invite_link:reset")
    );
    expect(published.map(([ch]: [string]) => ch).sort()).toEqual(
      [`self:${TEST_USER_ID}`, "self:member-2"].sort()
    );
    for (const [, body] of published) expect(body).not.toContain(res.body.data.link.token);
  });

  it.each(["MODERATOR", "MEMBER"])("%s is refused and nothing is revoked", async (role) => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({ role });
    const res = await reset();
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe("CHAT_INSUFFICIENT_PERMISSIONS");
    expect(mocks.groupInviteLinkRepo.revokeAllForRoom).not.toHaveBeenCalled();
  });

  it("a non-member (removed/banned/other group) is refused", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);
    expect((await reset()).status).toBe(400);
    expect(mocks.groupInviteLinkRepo.revokeAllForRoom).not.toHaveBeenCalled();
  });

  it("unauthenticated is 401", async () => {
    const res = await request(app).post(`/api/chat/invite-links/room/${ROOM}/reset`);
    expect(res.status).toBe(401);
  });

  it("a closed group is refused BEFORE anything is revoked", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({ role: "ADMIN" });
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: ROOM,
      status: "CLOSED",
      settings: {},
    });
    const res = await reset();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mocks.groupInviteLinkRepo.revokeAllForRoom).not.toHaveBeenCalled();
  });

  it("concurrent reset: the loser of the unique insert returns the winner's link (one active link)", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({ role: "ADMIN" });
    mocks.groupInviteLinkRepo.findActiveByRoom
      .mockResolvedValueOnce([{ token: OLD, roomId: ROOM }])
      .mockResolvedValueOnce([{ token: "winner-token-123456789012", roomId: ROOM }]);
    mocks.groupInviteLinkRepo.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));

    const res = await reset();

    expect(res.status).toBe(200);
    expect(res.body.data.link.token).toBe("winner-token-123456789012");
  });
});

describe("create reuses the shared link", () => {
  it("returns the current active link instead of minting", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({ role: "ADMIN" });
    const res = await request(app)
      .post("/api/chat/invite-links")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM });
    expect(res.status).toBe(201);
    expect(res.body.data.token).toBe(OLD);
    expect(mocks.groupInviteLinkRepo.create).not.toHaveBeenCalled();
  });
});

describe("join after / racing a reset", () => {
  const joinWith = () =>
    request(app)
      .post("/api/chat/invite-links/join")
      .set(bearer(makeAccessToken()))
      .send({ token: OLD });

  beforeEach(() => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: ROOM,
      status: "ACTIVE",
      memberCount: 2,
      memberLimit: 50,
      settings: {},
    });
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue(null);
  });

  it("the old token is refused once revoked, and no membership is written", async () => {
    mocks.groupInviteLinkRepo.findByToken.mockResolvedValue({
      token: OLD,
      roomId: ROOM,
      status: "REVOKED",
    });
    const res = await joinWith();
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("CHAT_INVITE_LINK_REVOKED");
    expect(mocks.groupMemberRepo.upsert).not.toHaveBeenCalled();
  });

  it("a join that read ACTIVE but lost the claim to a reset is refused", async () => {
    mocks.groupInviteLinkRepo.findByToken
      .mockResolvedValueOnce({ token: OLD, roomId: ROOM, status: "ACTIVE", createdBy: "o" })
      .mockResolvedValue({ token: OLD, roomId: ROOM, status: "REVOKED", createdBy: "o" });
    mocks.groupInviteLinkRepo.claimUse.mockResolvedValue(false);
    const res = await joinWith();
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("CHAT_INVITE_LINK_REVOKED");
    expect(mocks.groupMemberRepo.upsert).not.toHaveBeenCalled();
  });

  it("a claimed use is handed back when the membership write fails", async () => {
    mocks.groupInviteLinkRepo.findByToken.mockResolvedValue({
      token: OLD,
      roomId: ROOM,
      status: "ACTIVE",
      createdBy: "o",
    });
    mocks.groupMemberRepo.upsert.mockRejectedValue(new Error("db down"));
    const res = await joinWith();
    expect(res.status).toBe(500);
    expect(mocks.groupInviteLinkRepo.releaseUse).toHaveBeenCalledWith(OLD);
  });
});
