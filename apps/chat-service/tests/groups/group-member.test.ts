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
  it("POSITIVE: an ADMIN adds a member to a non-full group", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: ROOM,
      memberCount: 2,
      memberLimit: 50,
    });
    // Actor (the authenticated caller) is the active ADMIN.
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
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

  // Rejoining is a FRESH membership, never a restore. A moderator who leaves
  // and is added back comes in as a plain MEMBER — the upsert always writes the
  // role, so the stale MODERATOR on the LEFT row cannot survive the re-add and
  // silently hand moderation rights back.
  it("REJOIN: a former MODERATOR is re-added as a plain MEMBER", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: ROOM,
      memberCount: 2,
      memberLimit: 50,
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
    });
    // The leftover row from before they left, still carrying MODERATOR.
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
      roomId: ROOM,
      userId: "returning-user",
      role: "MODERATOR",
      status: "LEFT",
    });
    mocks.groupMemberRepo.upsert.mockResolvedValue({
      roomId: ROOM,
      userId: "returning-user",
      role: "MEMBER",
    });

    const res = await request(app)
      .post("/api/chat/group-members/add")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: "returning-user" });

    expect(res.status).toBe(201);
    expect(mocks.groupMemberRepo.upsert).toHaveBeenCalledWith(
      ROOM,
      "returning-user",
      // …and the removal stamps are cleared, so the row is not read back as
      // still-left/still-kicked once it is ACTIVE again.
      expect.objectContaining({
        role: "MEMBER",
        status: "ACTIVE",
        leftAt: null,
        kickedAt: null,
      })
    );
  });

  // AUDIT H3 — addMember must authorize the actor (require ADMIN).
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
      role: "ADMIN",
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
      role: "ADMIN",
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
    // group:removed(reason:LEAVE) on the caller's own channel — the gateway
    // uses this to evict their live sockets from conv:<roomId> and to sync
    // the read-only state to their other devices (MessageThreadsContext's
    // handleGroupRemoved).
    expect(mocks.redis.publish).toHaveBeenCalledWith(
      `user:${TEST_USER_ID}`,
      expect.stringContaining('"event":"group:removed"')
    );
    expect(mocks.redis.publish).toHaveBeenCalledWith(
      `user:${TEST_USER_ID}`,
      expect.stringContaining('"reason":"LEAVE"')
    );
  });

  // A MODERATOR leaves exactly like a MEMBER: the ONLY role the leave gate
  // rejects is ADMIN, so moderation rights never trap someone in a group.
  it("POSITIVE: a MODERATOR can leave, same as a plain member", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MODERATOR",
    });
    mocks.groupMemberRepo.updateStatus.mockResolvedValue({ status: "LEFT" });

    const res = await request(app)
      .post(`/api/chat/group-members/${ROOM}/leave`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(mocks.groupMemberRepo.updateStatus).toHaveBeenCalledWith(
      ROOM,
      TEST_USER_ID,
      "LEFT",
      expect.objectContaining({ leftAt: expect.any(Date) })
    );
    expect(mocks.redis.publish).toHaveBeenCalledWith(
      `user:${TEST_USER_ID}`,
      expect.stringContaining('"reason":"LEAVE"')
    );
  });

  it("NEGATIVE: 400 when the sole ADMIN tries to leave", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
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
      .mockResolvedValueOnce({ role: "MODERATOR" }) // actor
      .mockResolvedValueOnce({ role: "ADMIN" }); // target (higher)

    const res = await request(app)
      .post("/api/chat/group-members/kick")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: "admin-user" });

    expect(res.status).toBe(400);
    expect(mocks.groupMemberRepo.updateStatus).not.toHaveBeenCalled();
  });
});

describe("POST /api/chat/group-members/role", () => {
  it("POSITIVE: ADMIN promotes a member to MODERATOR", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser
      .mockResolvedValueOnce({ role: "ADMIN" }) // actor
      .mockResolvedValueOnce({ role: "MEMBER" }); // target
    mocks.groupMemberRepo.updateRole.mockResolvedValue({ role: "MODERATOR" });

    const res = await request(app)
      .post("/api/chat/group-members/role")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: "target-user", role: "MODERATOR" });

    expect(res.status).toBe(200);
    expect(mocks.groupMemberRepo.updateRole).toHaveBeenCalledWith(
      ROOM,
      "target-user",
      "MODERATOR"
    );
  });

  // "Make Admin" is a full hand-off — there is exactly one ADMIN per group, so
  // promoting the target also demotes the caller to MEMBER in the same call.
  // This merges what used to be a separate "Transfer Ownership" action.
  it("POSITIVE: ADMIN makes a member the admin and steps down to MEMBER", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser
      .mockResolvedValueOnce({ role: "ADMIN" }) // actor
      .mockResolvedValueOnce({ role: "MODERATOR" }); // target
    mocks.groupMemberRepo.updateRole.mockResolvedValue({ role: "ADMIN" });

    const res = await request(app)
      .post("/api/chat/group-members/role")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: "target-user", role: "ADMIN" });

    expect(res.status).toBe(200);
    expect(mocks.groupMemberRepo.updateRole).toHaveBeenCalledWith(
      ROOM,
      TEST_USER_ID,
      "MEMBER"
    );
    expect(mocks.groupMemberRepo.updateRole).toHaveBeenCalledWith(
      ROOM,
      "target-user",
      "ADMIN"
    );
  });

  it("SECURITY: 400 when a MODERATOR tries to change any role", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MODERATOR",
    });

    const res = await request(app)
      .post("/api/chat/group-members/role")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: "target-user", role: "MODERATOR" });

    expect(res.status).toBe(400);
    expect(mocks.groupMemberRepo.updateRole).not.toHaveBeenCalled();
  });

  it("SECURITY: 400 when the caller tries to change their own role", async () => {
    const res = await request(app)
      .post("/api/chat/group-members/role")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: TEST_USER_ID, role: "MEMBER" });

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
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
      userId: TEST_USER_ID,
      status: "ACTIVE",
    });
    mocks.groupMemberRepo.findActiveMembers.mockResolvedValue([
      { userId: TEST_USER_ID, role: "ADMIN", joinedAt: new Date(1) },
    ]);
    mocks.groupMemberRepo.countActiveMembers.mockResolvedValue(1);

    const res = await request(app)
      .get(`/api/chat/group-members/${ROOM}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
  });

  // The roster is Group Info: a removed (kicked/banned) member must lose it the
  // same moment they lose the chat, and a stranger must never read it at all.
  it("SECURITY: 403 when the caller was removed from the group", async () => {
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
      userId: TEST_USER_ID,
      status: "KICKED",
    });

    const res = await request(app)
      .get(`/api/chat/group-members/${ROOM}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
    expect(mocks.groupMemberRepo.findActiveMembers).not.toHaveBeenCalled();
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
