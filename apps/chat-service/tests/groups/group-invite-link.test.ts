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
  it("POSITIVE: the admin revokes a link and gets a FRESH one back", async () => {
    mocks.groupInviteLinkRepo.findActiveByToken.mockResolvedValue({
      token: TOKEN,
      roomId: ROOM,
      shareName: "",
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
    });
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: ROOM,
      settings: {},
    });
    mocks.groupInviteLinkRepo.revoke.mockResolvedValue({
      token: TOKEN,
      status: "REVOKED",
    });
    mocks.groupInviteLinkRepo.create.mockImplementation(
      async (data: { token: string }) => data
    );

    const res = await request(app)
      .post("/api/chat/invite-links/revoke")
      .set(bearer(makeAccessToken()))
      .send({ token: TOKEN });

    expect(res.status).toBe(200);
    expect(res.body.data.revoked.token).toBe(TOKEN);
    // A brand-new code is in effect immediately, and it is never the old one.
    expect(res.body.data.link.token).toEqual(expect.any(String));
    expect(res.body.data.link.token).not.toBe(TOKEN);
    // Every sibling token for the room dies too, or "revoke" is a no-op for
    // anyone holding one of them.
    expect(mocks.groupInviteLinkRepo.revokeAllForRoom).toHaveBeenCalledWith(
      ROOM,
      TEST_USER_ID
    );
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

  // The preview answers 200 for EVERY outcome now. It used to throw, which left
  // the client with an error and no state — so the only thing it could do with a
  // revoked link, a dead group or a full group was show the expired-link screen.
  it("NEGATIVE: an unknown token is a STATE, not an error", async () => {
    mocks.groupInviteLinkRepo.findByToken.mockResolvedValue(null);
    mocks.groupRoomRepo.findByRoomId.mockResolvedValue(null);

    const res = await request(app).get(
      `/api/chat/invite-links/preview/${TOKEN}`
    );

    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe("LINK_NOT_FOUND");
  });

  it("EDGE: an expired link is reported as LINK_EXPIRED on a 200", async () => {
    mocks.groupInviteLinkRepo.findByToken.mockResolvedValue({
      token: TOKEN,
      roomId: ROOM,
      status: "ACTIVE",
      expiresAt: new Date(Date.now() - 60_000),
      maxUses: null,
      usedCount: 0,
    });
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: ROOM,
      name: "Devs",
      status: "ACTIVE",
      memberCount: 3,
      memberLimit: 50,
    });

    const res = await request(app).get(
      `/api/chat/invite-links/preview/${TOKEN}`
    );

    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe("LINK_EXPIRED");
    // Group identity still comes back, so the screen can name the group it is
    // talking about instead of showing a bare error.
    expect(res.body.data.groupName).toBe("Devs");
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

  it("EDGE: still invites a recipient who is already an active member", async () => {
    mockGroupAndCaller();
    // Both the caller AND the recipient are active members this time.
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });
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
    expect(res.body.data.results).toEqual([
      { userId: RECIPIENT, status: "SENT" },
    ]);
    expect(mocks.privateMessageRepo.createMessage).toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// 1-hour expiry + membership-driven CTA ("Join Group" vs "View Group")
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;

describe("invite-link lifetime — every link dies 1 hour after creation", () => {
  beforeEach(() => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: ROOM,
      settings: {},
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
    });
    mocks.groupInviteLinkRepo.create.mockImplementation(
      async (data: Record<string, unknown>) => data
    );
  });

  it("a bare create stamps expiresAt exactly 1 hour out", async () => {
    const before = Date.now();
    const res = await request(app)
      .post("/api/chat/invite-links")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM });
    const after = Date.now();

    expect(res.status).toBe(201);
    const written = mocks.groupInviteLinkRepo.create.mock.calls[0][0];
    expect(written.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + HOUR_MS
    );
    expect(written.expiresAt.getTime()).toBeLessThanOrEqual(after + HOUR_MS);
  });

  it("a caller-supplied expiry LONGER than an hour is clamped", async () => {
    const before = Date.now();
    await request(app)
      .post("/api/chat/invite-links")
      .set(bearer(makeAccessToken()))
      .send({
        roomId: ROOM,
        expiresAt: new Date(Date.now() + 7 * 24 * HOUR_MS).toISOString(),
      });

    const written = mocks.groupInviteLinkRepo.create.mock.calls[0][0];
    expect(written.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + HOUR_MS
    );
    expect(written.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + HOUR_MS - 1000
    );
  });

  it("a caller-supplied SHORTER expiry is honoured", async () => {
    const shortExpiry = new Date(Date.now() + 5 * 60_000);
    await request(app)
      .post("/api/chat/invite-links")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, expiresAt: shortExpiry.toISOString() });

    const written = mocks.groupInviteLinkRepo.create.mock.calls[0][0];
    expect(written.expiresAt.getTime()).toBe(shortExpiry.getTime());
  });

  it("an expired link cannot be joined through the API (400, no membership write)", async () => {
    mocks.groupInviteLinkRepo.findActiveByToken.mockResolvedValue({
      token: TOKEN,
      roomId: ROOM,
      createdBy: "u_inviter",
      expiresAt: new Date(Date.now() - 1000),
      maxUses: null,
      usedCount: 0,
    });

    const res = await request(app)
      .post("/api/chat/invite-links/join")
      .set(bearer(makeAccessToken()))
      .send({ token: TOKEN });

    expect(res.status).toBe(400);
    expect(mocks.groupInviteLinkRepo.incrementUsedCount).not.toHaveBeenCalled();
  });
});

describe("GET preview — isJoined drives Join Group vs View Group", () => {
  const liveLink = {
    token: TOKEN,
    roomId: ROOM,
    createdBy: "u_inviter",
    expiresAt: new Date(Date.now() + HOUR_MS),
    maxUses: null,
    usedCount: 0,
  };
  const room = {
    roomId: ROOM,
    name: "Devs",
    avatar: "",
    description: "",
    memberCount: 3,
    memberLimit: 50,
  };

  beforeEach(() => {
    mocks.groupInviteLinkRepo.findActiveByToken.mockResolvedValue(liveLink);
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(room);
  });

  it("isJoined=false for an authenticated NON-member", async () => {
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/chat/invite-links/preview/${TOKEN}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.isJoined).toBe(false);
    expect(res.body.data.expiresAt).toBe(liveLink.expiresAt.toISOString());
  });

  it("isJoined=true for an ACTIVE member of any role", async () => {
    for (const role of ["MEMBER", "MODERATOR", "ADMIN"]) {
      mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
        role,
        status: "ACTIVE",
      });

      const res = await request(app)
        .get(`/api/chat/invite-links/preview/${TOKEN}`)
        .set(bearer(makeAccessToken()));

      expect(res.body.data.isJoined).toBe(true);
    }
  });

  it("flips back to isJoined=false once the user has left — same link, no new token", async () => {
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
      status: "ACTIVE",
    });
    const joined = await request(app)
      .get(`/api/chat/invite-links/preview/${TOKEN}`)
      .set(bearer(makeAccessToken()));
    expect(joined.body.data.isJoined).toBe(true);

    // The user leaves: the membership row is no longer ACTIVE.
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "LEFT",
    });
    const left = await request(app)
      .get(`/api/chat/invite-links/preview/${TOKEN}`)
      .set(bearer(makeAccessToken()));

    expect(left.status).toBe(200);
    expect(left.body.data.isJoined).toBe(false);
  });

  it("isJoined=false for an anonymous preview (no membership to read)", async () => {
    const res = await request(app).get(
      `/api/chat/invite-links/preview/${TOKEN}`
    );

    expect(res.status).toBe(200);
    expect(res.body.data.isJoined).toBe(false);
  });
});
