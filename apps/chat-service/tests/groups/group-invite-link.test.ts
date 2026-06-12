/**
 * Integration tests — group invite links.
 * Routes (apps/chat-service/src/api/routes/group-invite-link.routes.ts):
 *   POST /api/chat/invite-links            (create; Zod body)
 *   POST /api/chat/invite-links/revoke     (Zod body)
 *   GET  /api/chat/invite-links/preview/:token   (PUBLIC — no auth)
 *   POST /api/chat/invite-links/join       (Zod body)
 *   GET  /api/chat/invite-links/room/:roomId
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "grp_room_1";
const TOKEN = "tok-1234567890"; // >= 10 chars

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
});

describe("POST /api/chat/invite-links (create)", () => {
  it("POSITIVE: an admin/owner creates a link", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: ROOM,
      settings: {},
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "OWNER",
    });
    mocks.groupInviteLinkRepo.create.mockResolvedValue({
      token: "newtoken",
      roomId: ROOM,
    });

    const res = await request(app)
      .post("/api/chat/invite-links")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM });

    expect(res.status).toBe(201);
    expect(res.body.data.token).toBe("newtoken");
  });

  it("SECURITY: 400 when a plain MEMBER tries to create and the group forbids it", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: ROOM,
      settings: { allowMemberInviteLink: false },
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });

    const res = await request(app)
      .post("/api/chat/invite-links")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM });

    expect(res.status).toBe(400);
    expect(mocks.groupInviteLinkRepo.create).not.toHaveBeenCalled();
  });

  it("NEGATIVE: 404 when the group does not exist", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/chat/invite-links")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM });

    expect(res.status).toBe(404);
  });

  it("NEGATIVE: 400 when roomId is missing", async () => {
    const res = await request(app)
      .post("/api/chat/invite-links")
      .set(bearer(makeAccessToken()))
      .send({});

    expect(res.status).toBe(400);
  });
});

describe("POST /api/chat/invite-links/revoke", () => {
  it("POSITIVE: an owner revokes a link", async () => {
    mocks.groupInviteLinkRepo.findActiveByToken.mockResolvedValue({
      token: TOKEN,
      roomId: ROOM,
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "OWNER",
    });
    mocks.groupInviteLinkRepo.revoke.mockResolvedValue({ token: TOKEN });

    const res = await request(app)
      .post("/api/chat/invite-links/revoke")
      .set(bearer(makeAccessToken()))
      .send({ token: TOKEN });

    expect(res.status).toBe(200);
  });

  it("NEGATIVE: 404 for an unknown token", async () => {
    mocks.groupInviteLinkRepo.findActiveByToken.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/chat/invite-links/revoke")
      .set(bearer(makeAccessToken()))
      .send({ token: TOKEN });

    expect(res.status).toBe(404);
  });

  it("SECURITY: 400 when a non-admin attempts revoke", async () => {
    mocks.groupInviteLinkRepo.findActiveByToken.mockResolvedValue({
      token: TOKEN,
      roomId: ROOM,
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });

    const res = await request(app)
      .post("/api/chat/invite-links/revoke")
      .set(bearer(makeAccessToken()))
      .send({ token: TOKEN });

    expect(res.status).toBe(400);
  });

  it("NEGATIVE: 400 for a too-short token", async () => {
    const res = await request(app)
      .post("/api/chat/invite-links/revoke")
      .set(bearer(makeAccessToken()))
      .send({ token: "short" });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/chat/invite-links/preview/:token (public)", () => {
  it("POSITIVE: returns group preview WITHOUT requiring auth", async () => {
    mocks.groupInviteLinkRepo.findActiveByToken.mockResolvedValue({
      token: TOKEN,
      roomId: ROOM,
      expiresAt: null,
      maxUses: null,
      usedCount: 0,
    });
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: ROOM,
      name: "Devs",
      avatar: "",
      description: "",
      memberCount: 3,
      memberLimit: 50,
    });

    // NOTE: no Authorization header — preview is intentionally public.
    const res = await request(app).get(
      `/api/chat/invite-links/preview/${TOKEN}`
    );

    expect(res.status).toBe(200);
    expect(res.body.data.groupName).toBe("Devs");
  });

  it("NEGATIVE: 404 for an unknown/revoked token", async () => {
    mocks.groupInviteLinkRepo.findActiveByToken.mockResolvedValue(null);

    const res = await request(app).get(
      `/api/chat/invite-links/preview/${TOKEN}`
    );

    expect(res.status).toBe(404);
  });

  it("EDGE: 400 for an expired link", async () => {
    mocks.groupInviteLinkRepo.findActiveByToken.mockResolvedValue({
      token: TOKEN,
      roomId: ROOM,
      expiresAt: new Date(Date.now() - 60_000),
      maxUses: null,
      usedCount: 0,
    });

    const res = await request(app).get(
      `/api/chat/invite-links/preview/${TOKEN}`
    );

    expect(res.status).toBe(400);
  });
});

describe("POST /api/chat/invite-links/join", () => {
  it("POSITIVE: joins via a valid link", async () => {
    mocks.groupInviteLinkRepo.findActiveByToken.mockResolvedValue({
      token: TOKEN,
      roomId: ROOM,
      createdBy: "owner-1",
      expiresAt: null,
      maxUses: null,
      usedCount: 0,
    });
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: ROOM,
      name: "Devs",
      memberCount: 2,
      memberLimit: 50,
    });
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue(null);
    mocks.groupMemberRepo.upsert.mockResolvedValue({
      roomId: ROOM,
      userId: TEST_USER_ID,
    });

    const res = await request(app)
      .post("/api/chat/invite-links/join")
      .set(bearer(makeAccessToken()))
      .send({ token: TOKEN });

    expect(res.status).toBe(200);
    expect(mocks.groupInviteLinkRepo.incrementUsedCount).toHaveBeenCalledWith(
      TOKEN
    );
  });

  it("EDGE: 400 when the link reached its usage limit", async () => {
    mocks.groupInviteLinkRepo.findActiveByToken.mockResolvedValue({
      token: TOKEN,
      roomId: ROOM,
      expiresAt: null,
      maxUses: 5,
      usedCount: 5,
    });

    const res = await request(app)
      .post("/api/chat/invite-links/join")
      .set(bearer(makeAccessToken()))
      .send({ token: TOKEN });

    expect(res.status).toBe(400);
  });

  it("NEGATIVE: 404 for an unknown token", async () => {
    mocks.groupInviteLinkRepo.findActiveByToken.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/chat/invite-links/join")
      .set(bearer(makeAccessToken()))
      .send({ token: TOKEN });

    expect(res.status).toBe(404);
  });

  it("SECURITY: 401 without a token (join is auth-gated)", async () => {
    const res = await request(app)
      .post("/api/chat/invite-links/join")
      .send({ token: TOKEN });

    expect(res.status).toBe(401);
  });
});

describe("GET /api/chat/invite-links/room/:roomId", () => {
  it("POSITIVE: an OWNER/ADMIN lists active links for a room", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "OWNER",
    });
    mocks.groupInviteLinkRepo.findActiveByRoom.mockResolvedValue([
      { token: TOKEN, roomId: ROOM },
    ]);
    mocks.groupInviteLinkRepo.countActiveByRoom.mockResolvedValue(1);

    const res = await request(app)
      .get(`/api/chat/invite-links/room/${ROOM}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
  });

  // AUDIT H4 — live join tokens must not be listable by any authed user.
  it("SECURITY: 403 when a plain MEMBER lists invite links", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });

    const res = await request(app)
      .get(`/api/chat/invite-links/room/${ROOM}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
    expect(mocks.groupInviteLinkRepo.findActiveByRoom).not.toHaveBeenCalled();
  });

  it("SECURITY: 403 when a non-member lists invite links", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/chat/invite-links/room/${ROOM}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
    expect(mocks.groupInviteLinkRepo.findActiveByRoom).not.toHaveBeenCalled();
  });

  it("SECURITY: 401 without a token", async () => {
    const res = await request(app).get(`/api/chat/invite-links/room/${ROOM}`);
    expect(res.status).toBe(401);
  });
});
