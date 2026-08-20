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
// Globally mocked in tests/setup/global-mocks.ts — imported here to override the
// invite-recipient gate's two lookups per test.
import { userGrpcClient } from "../../src/grpc/user-snapshot.client.js";

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
      role: "ADMIN",
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
  it("POSITIVE: the admin revokes a link", async () => {
    mocks.groupInviteLinkRepo.findActiveByToken.mockResolvedValue({
      token: TOKEN,
      roomId: ROOM,
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
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
      avatar: "group-avatars/grp_room_1/logo.png",
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
    // Resolve-on-read: the stored group logo object key must surface as a full
    // download URL (mediaUrlStrategy mock → https://media.test/<bucket>/<key>),
    // never the raw MinIO key.
    expect(res.body.data.groupAvatar).toBe(
      "https://media.test/aimess-avatars/group-avatars/grp_room_1/logo.png"
    );
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
  it("POSITIVE: the ADMIN lists active links for a room", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
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

describe("POST /api/chat/invite-links/room/:roomId/bulk-send", () => {
  const RECIPIENT = "user-recipient-1";

  function mockGroupAndCaller() {
    // Caller is an active member; every OTHER user checked (the recipients)
    // is not — the per-recipient "already a member?" check must see `null`.
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockImplementation(
      async (_roomId: string, userId: string) =>
        userId === TEST_USER_ID ? { role: "MEMBER" } : null
    );
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: ROOM,
      name: "Devs",
      avatar: "",
      memberCount: 3,
    });
    mocks.groupInviteLinkRepo.findActiveByRoom.mockResolvedValue([
      { token: TOKEN, roomId: ROOM },
    ]);
  }

  it("POSITIVE: sends an invitation DM to a non-member recipient", async () => {
    mockGroupAndCaller();
    mocks.privateRoomRepo.findByParticipantsKey.mockResolvedValue(null);
    mocks.privateRoomRepo.create.mockResolvedValue({ roomId: "prv_1" });
    mocks.privateRoomRepo.allocateSequence.mockResolvedValue(1);
    mocks.privateMessageRepo.findByClientMessageId.mockResolvedValue(null);
    mocks.privateMessageRepo.createMessage.mockResolvedValue({
      id: "msg-1",
      createdAt: new Date(),
      countInUnread: true,
    });

    const res = await request(app)
      .post(`/api/chat/invite-links/room/${ROOM}/bulk-send`)
      .set(bearer(makeAccessToken()))
      .send({ userIds: [RECIPIENT] });

    expect(res.status).toBe(200);
    expect(res.body.data.token).toBe(TOKEN);
    expect(res.body.data.results).toEqual([
      { userId: RECIPIENT, status: "SENT" },
    ]);
    expect(mocks.privateMessageRepo.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        systemEvent: "GROUP_INVITE",
        receiverId: RECIPIENT,
      })
    );
  });

  // Recipient-account gate: a DM invite must never be written to an account
  // that cannot act on it, nor across a block in either direction.
  it.each([
    ["deleted", { isDeleted: true }, "INVITE_RECIPIENT_DELETED"],
    ["suspended", { isSuspended: true }, "INVITE_RECIPIENT_SUSPENDED"],
  ])(
    "EDGE: refuses a %s recipient (no DM written)",
    async (_label, snapshotOverride, code) => {
      mockGroupAndCaller();
      (userGrpcClient.bulkGetUserSnapshots as jest.Mock).mockResolvedValueOnce([
        {
          userId: RECIPIENT,
          username: "u",
          displayName: "U",
          avatarObjectKey: "",
          avatarUrl: "",
          isDeleted: false,
          isSuspended: false,
          ...snapshotOverride,
        },
      ]);

      const res = await request(app)
        .post(`/api/chat/invite-links/room/${ROOM}/bulk-send`)
        .set(bearer(makeAccessToken()))
        .send({ userIds: [RECIPIENT] });

      expect(res.status).toBe(200);
      expect(res.body.data.results[0]).toMatchObject({
        userId: RECIPIENT,
        status: "FAILED",
        code,
      });
      expect(mocks.privateMessageRepo.createMessage).not.toHaveBeenCalled();
    }
  );

  it("EDGE: refuses a blocked recipient (block in either direction)", async () => {
    mockGroupAndCaller();
    (userGrpcClient.checkFriendships as jest.Mock).mockResolvedValueOnce(
      new Map([[RECIPIENT, { status: "NONE", blockedEitherWay: true }]])
    );

    const res = await request(app)
      .post(`/api/chat/invite-links/room/${ROOM}/bulk-send`)
      .set(bearer(makeAccessToken()))
      .send({ userIds: [RECIPIENT] });

    expect(res.body.data.results[0]).toMatchObject({
      status: "FAILED",
      code: "INVITE_RECIPIENT_BLOCKED",
    });
    expect(mocks.privateMessageRepo.createMessage).not.toHaveBeenCalled();
  });

  it("EDGE: skips a recipient who is already an active member", async () => {
    mockGroupAndCaller();
    // Both the caller AND the recipient are active members this time.
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });

    const res = await request(app)
      .post(`/api/chat/invite-links/room/${ROOM}/bulk-send`)
      .set(bearer(makeAccessToken()))
      .send({ userIds: [RECIPIENT] });

    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([
      { userId: RECIPIENT, status: "SKIPPED_ALREADY_MEMBER" },
    ]);
    expect(mocks.privateMessageRepo.createMessage).not.toHaveBeenCalled();
  });

  it("SECURITY: 403 when the caller is not a group member", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/chat/invite-links/room/${ROOM}/bulk-send`)
      .set(bearer(makeAccessToken()))
      .send({ userIds: [RECIPIENT] });

    expect(res.status).toBe(403);
    expect(mocks.privateMessageRepo.createMessage).not.toHaveBeenCalled();
  });

  it("NEGATIVE: 400 when userIds is empty", async () => {
    const res = await request(app)
      .post(`/api/chat/invite-links/room/${ROOM}/bulk-send`)
      .set(bearer(makeAccessToken()))
      .send({ userIds: [] });

    expect(res.status).toBe(400);
  });

  it("SECURITY: 401 without a token", async () => {
    const res = await request(app)
      .post(`/api/chat/invite-links/room/${ROOM}/bulk-send`)
      .send({ userIds: [RECIPIENT] });

    expect(res.status).toBe(401);
  });
});
