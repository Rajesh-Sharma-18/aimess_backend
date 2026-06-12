/**
 * Integration tests — group rooms.
 * Routes (apps/chat-service/src/api/routes/group-room.routes.ts):
 *   POST  /api/chat/groups                 (create; create rate-limit + Zod body)
 *   GET   /api/chat/groups/my-groups
 *   GET   /api/chat/groups/:roomId
 *   PATCH /api/chat/groups/:roomId         (update; Zod body)
 *   POST  /api/chat/groups/:roomId/disband
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import {
  bearer,
  makeAccessToken,
  makeForgedAccessToken,
  TEST_USER_ID,
} from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
});

describe("POST /api/chat/groups (create)", () => {
  it("POSITIVE: creates a group and returns 201 with room + member", async () => {
    mocks.groupRoomRepo.create.mockResolvedValue({
      roomId: "grp_new",
      name: "Devs",
    });
    mocks.groupMemberRepo.create.mockResolvedValue({
      roomId: "grp_new",
      userId: TEST_USER_ID,
      role: "OWNER",
    });
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: "grp_new",
      name: "Devs",
    });

    const res = await request(app)
      .post("/api/chat/groups")
      .set(bearer(makeAccessToken()))
      .send({ name: "Devs" });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.room.roomId).toBe("grp_new");
    expect(res.body.data.member.role).toBe("OWNER");
  });

  it("NEGATIVE: 400 when name is empty", async () => {
    const res = await request(app)
      .post("/api/chat/groups")
      .set(bearer(makeAccessToken()))
      .send({ name: "" });
    expect(res.status).toBe(400);
  });

  it("EDGE: 400 when name exceeds 100 chars", async () => {
    const res = await request(app)
      .post("/api/chat/groups")
      .set(bearer(makeAccessToken()))
      .send({ name: "a".repeat(101) });
    expect(res.status).toBe(400);
  });

  it("EDGE: 400 when memberLimit is below the min (2)", async () => {
    const res = await request(app)
      .post("/api/chat/groups")
      .set(bearer(makeAccessToken()))
      .send({ name: "ok", memberLimit: 1 });
    expect(res.status).toBe(400);
  });

  it("SECURITY: mass-assignment — extra body fields are stripped by Zod, not persisted", async () => {
    mocks.groupRoomRepo.create.mockResolvedValue({ roomId: "grp_new" });
    mocks.groupMemberRepo.create.mockResolvedValue({ role: "OWNER" });
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: "grp_new",
    });

    await request(app)
      .post("/api/chat/groups")
      .set(bearer(makeAccessToken()))
      .send({ name: "ok", createdBy: "attacker", memberCount: 9999 });

    // createGroup forces createdBy = the authed userId; the body's createdBy is ignored.
    expect(mocks.groupRoomRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: TEST_USER_ID })
    );
  });

  it("SECURITY: 401 without a token", async () => {
    const res = await request(app)
      .post("/api/chat/groups")
      .send({ name: "Devs" });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/chat/groups/my-groups", () => {
  it("POSITIVE: returns the caller's active groups", async () => {
    mocks.groupMemberRepo.getActiveRoomIds.mockResolvedValue(["grp_1"]);
    mocks.groupRoomRepo.getUserGroups.mockResolvedValue([
      { roomId: "grp_1", name: "Devs", lastMessageAt: new Date(1) },
    ]);
    mocks.groupRoomRepo.countUserGroups.mockResolvedValue(1);

    const res = await request(app)
      .get("/api/chat/groups/my-groups")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
    expect(res.body.data.data[0].isJoined).toBe(true);
  });

  it("EDGE: no memberships → 200 with empty data", async () => {
    mocks.groupMemberRepo.getActiveRoomIds.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/chat/groups/my-groups")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toEqual([]);
  });

  // Resolve-on-read: the stored group logo object key must surface as a full
  // download URL (mediaUrlStrategy mock → https://media.test/<bucket>/<key>).
  it("MEDIA: resolves the group logo object key to a download URL", async () => {
    mocks.groupMemberRepo.getActiveRoomIds.mockResolvedValue(["grp_1"]);
    mocks.groupRoomRepo.getUserGroups.mockResolvedValue([
      {
        roomId: "grp_1",
        name: "Devs",
        avatar: "group-avatars/grp_1/logo.png",
        lastMessageAt: new Date(1),
      },
    ]);
    mocks.groupRoomRepo.countUserGroups.mockResolvedValue(1);

    const res = await request(app)
      .get("/api/chat/groups/my-groups")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data[0].avatar).toBe(
      "https://media.test/aimess-avatars/group-avatars/grp_1/logo.png"
    );
  });
});

describe("GET /api/chat/groups/:roomId", () => {
  it("POSITIVE: returns the group with isJoined=true for an active member", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: "grp_1",
      name: "Devs",
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      roomId: "grp_1",
      userId: TEST_USER_ID,
    });

    const res = await request(app)
      .get("/api/chat/groups/grp_1")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.isJoined).toBe(true);
  });

  it("POSITIVE: isJoined=false for a non-member viewer", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: "grp_1",
      name: "Devs",
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .get("/api/chat/groups/grp_1")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.isJoined).toBe(false);
  });

  it("NEGATIVE: 404 when the group does not exist", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(null);

    const res = await request(app)
      .get("/api/chat/groups/ghost")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
  });

  // Resolve-on-read on the single room-detail boundary.
  it("MEDIA: resolves the room logo object key on the detail read", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: "grp_1",
      name: "Devs",
      avatar: "group-avatars/grp_1/logo.png",
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .get("/api/chat/groups/grp_1")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.avatar).toBe(
      "https://media.test/aimess-avatars/group-avatars/grp_1/logo.png"
    );
  });
});

describe("PATCH /api/chat/groups/:roomId (update)", () => {
  it("POSITIVE: owner updates the group name", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "OWNER",
    });
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: "grp_1",
      name: "Old",
    });
    mocks.groupRoomRepo.updateRoom.mockResolvedValue({
      roomId: "grp_1",
      name: "New",
    });

    const res = await request(app)
      .patch("/api/chat/groups/grp_1")
      .set(bearer(makeAccessToken()))
      .send({ name: "New" });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("New");
  });

  it("SECURITY: 400 when a plain MEMBER tries to update", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });

    const res = await request(app)
      .patch("/api/chat/groups/grp_1")
      .set(bearer(makeAccessToken()))
      .send({ name: "New" });

    expect(res.status).toBe(400);
    expect(mocks.groupRoomRepo.updateRoom).not.toHaveBeenCalled();
  });

  it("NEGATIVE: 404 when the caller is not a member", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .patch("/api/chat/groups/grp_1")
      .set(bearer(makeAccessToken()))
      .send({ name: "New" });

    expect(res.status).toBe(404);
  });

  it("NEGATIVE: 400 for an invalid memberLimit type", async () => {
    const res = await request(app)
      .patch("/api/chat/groups/grp_1")
      .set(bearer(makeAccessToken()))
      .send({ memberLimit: "lots" });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/chat/groups/:roomId/disband", () => {
  it("POSITIVE: owner disbands the group", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "OWNER",
    });
    mocks.groupRoomRepo.disband.mockResolvedValue({
      roomId: "grp_1",
      isDisbanded: true,
    });

    const res = await request(app)
      .post("/api/chat/groups/grp_1/disband")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(mocks.groupInviteLinkRepo.revokeAllForRoom).toHaveBeenCalled();
  });

  it("SECURITY: 400 when a non-owner (ADMIN) tries to disband", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
    });

    const res = await request(app)
      .post("/api/chat/groups/grp_1/disband")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(400);
    expect(mocks.groupRoomRepo.disband).not.toHaveBeenCalled();
  });

  it("SECURITY: 401 with a forged token", async () => {
    const res = await request(app)
      .post("/api/chat/groups/grp_1/disband")
      .set(bearer(makeForgedAccessToken()));
    expect(res.status).toBe(401);
  });
});
