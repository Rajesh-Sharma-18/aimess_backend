/**
 * Integration tests — group members.
 * Routes (apps/chat-service/src/api/routes/group-member.routes.ts):
 *   POST /api/chat/group-members/add          (Zod body)
 *   POST /api/chat/group-members/:roomId/leave
 *   POST /api/chat/group-members/kick          (Zod body)
 *   POST /api/chat/group-members/role          (Zod body)
 *   GET  /api/chat/group-members/:roomId
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "grp_room_1";

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
});

describe("POST /api/chat/group-members/add", () => {
  it("POSITIVE: an OWNER/ADMIN adds a member to a non-full group", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: ROOM,
      memberCount: 2,
      memberLimit: 50,
    });
    // Actor (the authenticated caller) is an active OWNER.
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "OWNER",
    });
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue(null);
    mocks.groupMemberRepo.upsert.mockResolvedValue({
      roomId: ROOM,
      userId: "new-user-1",
      role: "MEMBER",
    });

    const res = await request(app)
      .post("/api/chat/group-members/add")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: "new-user-1" });

    expect(res.status).toBe(201);
    expect(mocks.groupMemberRepo.upsert).toHaveBeenCalled();
  });

  // AUDIT H3 — addMember must authorize the actor (require OWNER/ADMIN).
  it("SECURITY: 403 when a plain MEMBER tries to add someone", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: ROOM,
      memberCount: 2,
      memberLimit: 50,
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });

    const res = await request(app)
      .post("/api/chat/group-members/add")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: "new-user-1" });

    expect(res.status).toBe(403);
    expect(mocks.groupMemberRepo.upsert).not.toHaveBeenCalled();
  });

  it("SECURITY: 403 when the actor isn't a member of the group at all", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: ROOM,
      memberCount: 2,
      memberLimit: 50,
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/chat/group-members/add")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: "new-user-1" });

    expect(res.status).toBe(403);
    expect(mocks.groupMemberRepo.upsert).not.toHaveBeenCalled();
  });

  it("NEGATIVE: 404 when the group does not exist", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/chat/group-members/add")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: "new-user-1" });

    expect(res.status).toBe(404);
  });

  it("EDGE: 400 when the group is at member limit", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: ROOM,
      memberCount: 50,
      memberLimit: 50,
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "OWNER",
    });

    const res = await request(app)
      .post("/api/chat/group-members/add")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: "new-user-1" });

    expect(res.status).toBe(400);
  });

  it("NEGATIVE: 409 when the user is already an active member", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: ROOM,
      memberCount: 2,
      memberLimit: 50,
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "OWNER",
    });
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "ACTIVE",
    });

    const res = await request(app)
      .post("/api/chat/group-members/add")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: "dupe-user" });

    expect(res.status).toBe(409);
  });

  it("NEGATIVE: 400 when userId is missing from body", async () => {
    const res = await request(app)
      .post("/api/chat/group-members/add")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/chat/group-members/:roomId/leave", () => {
  it("POSITIVE: a non-owner member can leave", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });
    mocks.groupMemberRepo.updateStatus.mockResolvedValue({ status: "LEFT" });

    const res = await request(app)
      .post(`/api/chat/group-members/${ROOM}/leave`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(mocks.groupMemberRepo.updateStatus).toHaveBeenCalled();
  });

  it("NEGATIVE: 400 when the OWNER tries to leave", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "OWNER",
    });

    const res = await request(app)
      .post(`/api/chat/group-members/${ROOM}/leave`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(400);
  });

  it("NEGATIVE: 404 when the caller is not a member", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/chat/group-members/${ROOM}/leave`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
  });
});

describe("POST /api/chat/group-members/kick", () => {
  it("POSITIVE: an ADMIN kicks a MEMBER", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser
      .mockResolvedValueOnce({ role: "ADMIN" }) // actor
      .mockResolvedValueOnce({ role: "MEMBER" }); // target
    mocks.groupMemberRepo.updateStatus.mockResolvedValue({ status: "KICKED" });

    const res = await request(app)
      .post("/api/chat/group-members/kick")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: "target-user" });

    expect(res.status).toBe(200);
    expect(mocks.groupMemberRepo.updateStatus).toHaveBeenCalled();
  });

  it("SECURITY: 400 when a MEMBER lacks permission to kick", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValueOnce({
      role: "MEMBER",
    });

    const res = await request(app)
      .post("/api/chat/group-members/kick")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: "target-user" });

    expect(res.status).toBe(400);
  });

  it("SECURITY: 400 when trying to kick an equal-or-higher role", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser
      .mockResolvedValueOnce({ role: "ADMIN" }) // actor
      .mockResolvedValueOnce({ role: "OWNER" }); // target (higher)

    const res = await request(app)
      .post("/api/chat/group-members/kick")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: "owner-user" });

    expect(res.status).toBe(400);
    expect(mocks.groupMemberRepo.updateStatus).not.toHaveBeenCalled();
  });
});

describe("POST /api/chat/group-members/role", () => {
  it("POSITIVE: OWNER promotes a member to ADMIN", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "OWNER",
    });
    mocks.groupMemberRepo.updateRole.mockResolvedValue({ role: "ADMIN" });

    const res = await request(app)
      .post("/api/chat/group-members/role")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: "target-user", role: "ADMIN" });

    expect(res.status).toBe(200);
    expect(mocks.groupMemberRepo.updateRole).toHaveBeenCalled();
  });

  it("SECURITY: 400 when an ADMIN tries to grant OWNER/ADMIN", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
    });

    const res = await request(app)
      .post("/api/chat/group-members/role")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: "target-user", role: "ADMIN" });

    expect(res.status).toBe(400);
    expect(mocks.groupMemberRepo.updateRole).not.toHaveBeenCalled();
  });

  it("NEGATIVE: 400 for an invalid role enum value", async () => {
    const res = await request(app)
      .post("/api/chat/group-members/role")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: "target-user", role: "SUPERADMIN" });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/chat/group-members/:roomId", () => {
  it("POSITIVE: lists active members, paginated", async () => {
    mocks.groupMemberRepo.findActiveMembers.mockResolvedValue([
      { userId: TEST_USER_ID, role: "OWNER", joinedAt: new Date(1) },
    ]);
    mocks.groupMemberRepo.countActiveMembers.mockResolvedValue(1);

    const res = await request(app)
      .get(`/api/chat/group-members/${ROOM}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
  });

  it("SECURITY: 401 without a token", async () => {
    const res = await request(app).get(`/api/chat/group-members/${ROOM}`);
    expect(res.status).toBe(401);
  });
});

// Parity with Private's /private/rooms/:roomId/mute — Group had the storage
// field (notificationSettings) but no route to ever write it.
describe("POST /api/chat/group-members/:roomId/mute", () => {
  it("POSITIVE: an active member mutes the group", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      roomId: ROOM,
      userId: TEST_USER_ID,
      role: "MEMBER",
    });
    mocks.groupMemberRepo.setMuted.mockResolvedValue({
      roomId: ROOM,
      userId: TEST_USER_ID,
      notificationSettings: { mute: true, muteUntil: null },
    });

    const res = await request(app)
      .post(`/api/chat/group-members/${ROOM}/mute`)
      .set(bearer(makeAccessToken()))
      .send({});

    expect(res.status).toBe(200);
    expect(mocks.groupMemberRepo.setMuted).toHaveBeenCalledWith(
      ROOM,
      TEST_USER_ID,
      null
    );
  });

  it("NEGATIVE: 404 when the caller is not a member", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/chat/group-members/${ROOM}/mute`)
      .set(bearer(makeAccessToken()))
      .send({});

    expect(res.status).toBe(404);
    expect(mocks.groupMemberRepo.setMuted).not.toHaveBeenCalled();
  });
});

describe("POST /api/chat/group-members/:roomId/unmute", () => {
  it("POSITIVE: an active member unmutes the group", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      roomId: ROOM,
      userId: TEST_USER_ID,
      role: "MEMBER",
    });
    mocks.groupMemberRepo.setUnmuted.mockResolvedValue({
      roomId: ROOM,
      userId: TEST_USER_ID,
      notificationSettings: { mute: false, muteUntil: null },
    });

    const res = await request(app)
      .post(`/api/chat/group-members/${ROOM}/unmute`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(mocks.groupMemberRepo.setUnmuted).toHaveBeenCalledWith(
      ROOM,
      TEST_USER_ID
    );
  });
});
