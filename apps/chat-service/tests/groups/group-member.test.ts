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

import { GroupNotSoleMemberError } from "../../src/repositories/group-room.repository.js";
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

  it("NEGATIVE: 409 when the leader leaves without a successor while others remain", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
    });
    mocks.groupMemberRepo.countActiveMembers.mockResolvedValue(3);
    mocks.groupMemberRepo.findSuccessionCandidates.mockResolvedValue(["m1", "m2"]);

    const res = await request(app)
      .post(`/api/chat/group-members/${ROOM}/leave`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CHAT_LEADER_SUCCESSOR_REQUIRED");
    expect(mocks.groupRoomRepo.disband).not.toHaveBeenCalled();
    expect(mocks.groupMemberRepo.transferLeadership).not.toHaveBeenCalled();
  });

  it("POSITIVE: leader leaves with a successor — atomic handover, LEADER_CHANGED then MEMBER_LEFT", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
    });
    mocks.groupMemberRepo.countActiveMembers.mockResolvedValue(3);
    mocks.groupMemberRepo.findSuccessionCandidates.mockResolvedValue(["m1", "successor-1"]);
    mocks.groupMemberRepo.transferLeadership.mockResolvedValue(true);
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "LEFT",
      role: "MEMBER",
    });

    const res = await request(app)
      .post(`/api/chat/group-members/${ROOM}/leave`)
      .set(bearer(makeAccessToken()))
      .send({ successorId: "successor-1" });

    expect(res.status).toBe(200);
    expect(mocks.groupMemberRepo.transferLeadership).toHaveBeenCalledWith(
      ROOM,
      TEST_USER_ID,
      "successor-1",
      expect.any(Date)
    );
    expect(mocks.groupMemberRepo.leaveIfActive).not.toHaveBeenCalled();
    expect(mocks.groupRoomRepo.incMemberCount).toHaveBeenCalledWith(ROOM, -1);
    const lines = mocks.groupMessageRepo.create.mock.calls.map(
      (c: [{ systemEvent: string; systemData: Record<string, unknown> }]) => c[0]
    );
    expect(lines.map((l: { systemEvent: string }) => l.systemEvent)).toEqual([
      "LEADER_CHANGED",
      "MEMBER_LEFT",
    ]);
    expect(lines[0].systemData).toEqual(
      expect.objectContaining({
        actorId: TEST_USER_ID,
        targetUserId: "successor-1",
      })
    );
  });

  it("NEGATIVE: 409 when the successor is not an active member (never joined or LEFT) — nothing written", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
    });
    mocks.groupMemberRepo.countActiveMembers.mockResolvedValue(3);
    mocks.groupMemberRepo.findSuccessionCandidates.mockResolvedValue(["m1", "m2"]);

    const res = await request(app)
      .post(`/api/chat/group-members/${ROOM}/leave`)
      .set(bearer(makeAccessToken()))
      .send({ successorId: "ghost-user" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CHAT_LEADER_SUCCESSOR_REQUIRED");
    expect(mocks.groupMemberRepo.transferLeadership).not.toHaveBeenCalled();
    expect(mocks.groupRoomRepo.incMemberCount).not.toHaveBeenCalled();
    expect(mocks.groupMessageRepo.create).not.toHaveBeenCalled();
  });

  it("NEGATIVE: 409 when the successor lost eligibility mid-handover (left meanwhile)", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
    });
    mocks.groupMemberRepo.findSuccessionCandidates.mockResolvedValue(["member-1"]);
    mocks.groupMemberRepo.transferLeadership.mockResolvedValue(false);

    const res = await request(app)
      .post(`/api/chat/group-members/${ROOM}/leave`)
      .set(bearer(makeAccessToken()))
      .send({ successorId: "member-1" });

    expect(res.status).toBe(409);
    expect(mocks.groupRoomRepo.incMemberCount).not.toHaveBeenCalled();
  });

  it.each([
    ["banned", "aimess:user:banned:bad-1", "1"],
    ["suspended", "aimess:user:suspended:bad-1", String(Date.now() + 60_000)],
  ])("NEGATIVE: 409 when the successor is a %s account", async (_kind, key, value) => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
    });
    mocks.groupMemberRepo.findSuccessionCandidates.mockResolvedValue(["bad-1", "ok-1"]);
    mocks.redis.get.mockImplementation(async (k: string) => (k === key ? value : null));

    const res = await request(app)
      .post(`/api/chat/group-members/${ROOM}/leave`)
      .set(bearer(makeAccessToken()))
      .send({ successorId: "bad-1" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CHAT_LEADER_SUCCESSOR_REQUIRED");
    expect(mocks.groupMemberRepo.transferLeadership).not.toHaveBeenCalled();
  });

  it("POSITIVE: everyone else is banned/suspended → no successor needed, leaving closes the group", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
    });
    mocks.groupMemberRepo.countActiveMembers.mockResolvedValue(4);
    // Deleted accounts: GroupMemberService eligibility unit tests (group-leader-succession).
    mocks.groupMemberRepo.findSuccessionCandidates.mockResolvedValue([
      "banned-1",
      "susp-1",
    ]);
    mocks.redis.get.mockImplementation(async (k: string) =>
      k === "aimess:user:banned:banned-1"
        ? "1"
        : k === "aimess:user:suspended:susp-1"
          ? String(Date.now() + 60_000)
          : null
    );
    mocks.groupMemberRepo.findActiveMembers.mockResolvedValue([
      { userId: TEST_USER_ID },
    ]);
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({ status: "LEFT" });
    mocks.groupRoomRepo.disband.mockResolvedValue({
      roomId: ROOM,
      status: "DISBANDED",
      disbandedAt: new Date(),
    });

    const res = await request(app)
      .post(`/api/chat/group-members/${ROOM}/leave`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(mocks.groupRoomRepo.disband).toHaveBeenCalledWith(
      ROOM,
      TEST_USER_ID,
      expect.any(Map),
      { asLastMember: false }
    );
    expect(mocks.groupMemberRepo.transferLeadership).not.toHaveBeenCalled();
  });

  it("NEGATIVE: 409 when the leader names themselves as successor", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
    });
    mocks.groupMemberRepo.countActiveMembers.mockResolvedValue(2);

    const res = await request(app)
      .post(`/api/chat/group-members/${ROOM}/leave`)
      .set(bearer(makeAccessToken()))
      .send({ successorId: TEST_USER_ID });

    expect(res.status).toBe(409);
    expect(mocks.groupMemberRepo.transferLeadership).not.toHaveBeenCalled();
  });

  it("POSITIVE: the ADMIN as last member leaves and the group is disbanded", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
    });
    mocks.groupMemberRepo.countActiveMembers.mockResolvedValue(1);
    mocks.groupMemberRepo.findActiveMembers.mockResolvedValue([
      { userId: TEST_USER_ID },
    ]);
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "LEFT",
    });
    mocks.groupRoomRepo.disband.mockResolvedValue({
      roomId: ROOM,
      status: "DISBANDED",
      disbandedAt: new Date(),
    });

    const res = await request(app)
      .post(`/api/chat/group-members/${ROOM}/leave`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    // Last-member disband: ACTIVE rooms only, roster re-checked in the TX.
    expect(mocks.groupRoomRepo.disband).toHaveBeenCalledWith(
      ROOM,
      TEST_USER_ID,
      expect.any(Map),
      { asLastMember: true }
    );
    expect(mocks.groupMemberRepo.updateStatus).not.toHaveBeenCalled();
    expect(mocks.redis.publish).toHaveBeenCalledWith(
      `user:${TEST_USER_ID}`,
      expect.stringContaining('"event":"group:removed"')
    );
  });

  it("NEGATIVE: someone joined before the disband transaction → 400, nothing torn down", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
    });
    mocks.groupMemberRepo.countActiveMembers.mockResolvedValue(1);
    mocks.groupMemberRepo.findActiveMembers.mockResolvedValue([
      { userId: TEST_USER_ID },
    ]);
    mocks.groupRoomRepo.disband.mockRejectedValue(new GroupNotSoleMemberError());

    const res = await request(app)
      .post(`/api/chat/group-members/${ROOM}/leave`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CHAT_OWNER_CANNOT_LEAVE");
    expect(mocks.groupInviteLinkRepo.revokeAllForRoom).not.toHaveBeenCalled();
    expect(mocks.redis.publish).not.toHaveBeenCalledWith(
      `user:${TEST_USER_ID}`,
      expect.stringContaining('"event":"group:removed"')
    );
  });

  it("POSITIVE: last ADMIN of a Super-Admin-CLOSED group just leaves — no second close", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
    });
    mocks.groupMemberRepo.countActiveMembers.mockResolvedValue(1);
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: ROOM,
      status: "CLOSED",
      memberCount: 1,
    });
    mocks.groupMemberRepo.updateStatus.mockResolvedValue({ status: "LEFT" });

    const res = await request(app)
      .post(`/api/chat/group-members/${ROOM}/leave`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(mocks.groupRoomRepo.disband).not.toHaveBeenCalled();
    expect(mocks.groupInviteLinkRepo.revokeAllForRoom).not.toHaveBeenCalled();
    expect(mocks.groupMemberRepo.leaveIfActive).toHaveBeenCalledWith(
      ROOM,
      TEST_USER_ID,
      expect.any(Date),
      "ADMIN"
    );
    expect(mocks.redis.publish).toHaveBeenCalledWith(
      `user:${TEST_USER_ID}`,
      expect.stringContaining('"event":"group:removed"')
    );
    expect(mocks.redis.publish).not.toHaveBeenCalledWith(
      `user:${TEST_USER_ID}`,
      expect.stringContaining('"event":"group:disbanded"')
    );
  });

  it("NEGATIVE: ADMIN of a CLOSED group with others remaining → 409 (successor rule unchanged)", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
    });
    mocks.groupMemberRepo.countActiveMembers.mockResolvedValue(3);
    mocks.groupMemberRepo.findSuccessionCandidates.mockResolvedValue(["m1"]);
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: ROOM,
      status: "CLOSED",
    });

    const res = await request(app)
      .post(`/api/chat/group-members/${ROOM}/leave`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(409);
    expect(mocks.groupMemberRepo.leaveIfActive).not.toHaveBeenCalled();
  });

  it("NEGATIVE: a double-submitted leave that lost the race → 404, count untouched", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });
    mocks.groupMemberRepo.leaveIfActive.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/chat/group-members/${ROOM}/leave`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
    expect(mocks.groupRoomRepo.incMemberCount).not.toHaveBeenCalled();
    expect(mocks.redis.publish).not.toHaveBeenCalledWith(
      `user:${TEST_USER_ID}`,
      expect.stringContaining('"event":"group:removed"')
    );
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

  it("SECURITY: 400 when a legacy MODERATOR tries to kick — leader only", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser
      .mockResolvedValueOnce({ role: "MODERATOR" }) // actor
      .mockResolvedValueOnce({ role: "MEMBER" }); // target

    const res = await request(app)
      .post("/api/chat/group-members/kick")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: "admin-user" });

    expect(res.status).toBe(400);
    expect(mocks.groupMemberRepo.updateStatus).not.toHaveBeenCalled();
  });
});

describe("POST /api/chat/group-members/role", () => {
  it.each(["MODERATOR", "MEMBER", "OWNER", "admin", ""])(
    "NEGATIVE: 400 for role %p — only ADMIN (leader handover)",
    async (role) => {
      mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
        role: "ADMIN",
      });
      const res = await request(app)
        .post("/api/chat/group-members/role")
        .set(bearer(makeAccessToken()))
        .send({ roomId: ROOM, userId: "target-user", role });

      expect(res.status).toBe(400);
      expect(mocks.groupMemberRepo.transferLeadership).not.toHaveBeenCalled();
    }
  );

  it("POSITIVE: leader hands over — atomic transfer + LEADER_CHANGED line", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser
      .mockResolvedValueOnce({ role: "ADMIN" }) // actor
      .mockResolvedValueOnce({ role: "MEMBER" }); // target
    mocks.groupMemberRepo.transferLeadership.mockResolvedValue(true);
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({ role: "ADMIN" });

    const res = await request(app)
      .post("/api/chat/group-members/role")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: "target-user", role: "ADMIN" });

    expect(res.status).toBe(200);
    expect(mocks.groupMemberRepo.transferLeadership).toHaveBeenCalledWith(
      ROOM,
      TEST_USER_ID,
      "target-user"
    );
    expect(mocks.groupMessageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ systemEvent: "LEADER_CHANGED" })
    );
  });

  it("SECURITY: 400 when a non-leader tries to hand over", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });

    const res = await request(app)
      .post("/api/chat/group-members/role")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: "target-user", role: "ADMIN" });

    expect(res.status).toBe(400);
    expect(mocks.groupMemberRepo.transferLeadership).not.toHaveBeenCalled();
  });

  it("SECURITY: 400 when the caller targets themselves", async () => {
    const res = await request(app)
      .post("/api/chat/group-members/role")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: TEST_USER_ID, role: "ADMIN" });

    expect(res.status).toBe(400);
    expect(mocks.groupMemberRepo.transferLeadership).not.toHaveBeenCalled();
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
