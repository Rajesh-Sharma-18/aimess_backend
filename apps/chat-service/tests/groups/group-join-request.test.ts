/**
 * Private groups (settings.joinApproval): invite-link join → admin-approved request.
 *   POST /api/chat/invite-links/join, GET /api/chat/invite-links/preview/:token
 *   /api/chat/group-join-requests/{room/:roomId,mine,:id/approve|reject|cancel}
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "grp_room_1";
const TOKEN = "tok-1234567890";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQ_ID = "req-1";

const link = {
  token: TOKEN,
  roomId: ROOM,
  createdBy: ADMIN,
  status: "ACTIVE",
  maxUses: null,
  usedCount: 0,
};
const room = (settings: Record<string, unknown>) => ({
  roomId: ROOM,
  name: "Devs",
  avatar: "",
  memberCount: 2,
  memberLimit: 50,
  settings,
});
const pendingRow = (over: Record<string, unknown> = {}) => ({
  id: REQ_ID,
  roomId: ROOM,
  userId: TEST_USER_ID,
  status: "PENDING",
  inviteToken: TOKEN,
  invitedBy: ADMIN,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
  ...over,
});

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
  mocks.groupInviteLinkRepo.findActiveByToken.mockResolvedValue(link);
  mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue(null);
  mocks.groupMemberRepo.findActiveMembers.mockResolvedValue([
    { userId: ADMIN, role: "ADMIN" },
  ]);
});

const join = () =>
  request(app)
    .post("/api/chat/invite-links/join")
    .set(bearer(makeAccessToken()))
    .send({ token: TOKEN });

/** Caller is an ACTIVE member with `role` (or the requester when role is null). */
function callerRole(role: string | null) {
  mocks.groupMemberRepo.findActiveByRoomAndUser.mockImplementation(
    async (_roomId: string, userId: string) =>
      userId === TEST_USER_ID && role ? { userId, role, status: "ACTIVE" } : null
  );
}

describe("invite-link join", () => {
  it("public group: joins instantly, unchanged (status JOINED)", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(room({}));
    mocks.groupMemberRepo.upsert.mockResolvedValue({ roomId: ROOM, userId: TEST_USER_ID });

    const res = await join();

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("JOINED");
    expect(res.body.data.room.roomId).toBe(ROOM);
    expect(mocks.groupMemberRepo.upsert).toHaveBeenCalled();
    expect(mocks.groupJoinRequestRepo.create).not.toHaveBeenCalled();
  });

  it("private group: creates a PENDING request and no membership", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(room({ joinApproval: true }));
    mocks.groupJoinRequestRepo.create.mockResolvedValue(pendingRow());

    const res = await join();

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("PENDING");
    expect(res.body.data.request).toMatchObject({
      id: REQ_ID,
      roomId: ROOM,
      userId: TEST_USER_ID,
      status: "PENDING",
      group: { roomId: ROOM, name: "Devs" },
    });
    expect(mocks.groupJoinRequestRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: ROOM, userId: TEST_USER_ID, inviteToken: TOKEN, invitedBy: ADMIN })
    );
    expect(mocks.groupMemberRepo.upsert).not.toHaveBeenCalled();
    expect(mocks.redis.publish).toHaveBeenCalledWith(
      `user:${ADMIN}`,
      expect.stringContaining("group:join_request:new")
    );
  });

  it("private group: a re-tap returns the existing PENDING row (idempotent)", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(room({ joinApproval: true }));
    mocks.groupJoinRequestRepo.findPending.mockResolvedValue(pendingRow());

    const res = await join();

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("PENDING");
    expect(res.body.data.request.id).toBe(REQ_ID);
    expect(mocks.groupJoinRequestRepo.create).not.toHaveBeenCalled();
  });
});

describe("invite-link preview", () => {
  it("private group with my pending request → REQUEST_PENDING + requiresApproval", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(room({ joinApproval: true }));
    mocks.groupJoinRequestRepo.findPending.mockResolvedValue(pendingRow());

    const res = await request(app)
      .get(`/api/chat/invite-links/preview/${TOKEN}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      state: "REQUEST_PENDING",
      requiresApproval: true,
      pendingRequestId: REQ_ID,
    });
  });

  it("public group → CAN_JOIN, requiresApproval false", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(room({}));

    const res = await request(app).get(`/api/chat/invite-links/preview/${TOKEN}`);

    expect(res.body.data).toMatchObject({
      state: "CAN_JOIN",
      requiresApproval: false,
      pendingRequestId: null,
    });
  });
});

describe("approve / reject / cancel", () => {
  beforeEach(() => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(room({ joinApproval: true }));
    mocks.groupJoinRequestRepo.findById.mockResolvedValue(
      pendingRow({ userId: "requester-1" })
    );
    mocks.groupJoinRequestRepo.settle.mockImplementation(
      async (_id: string, status: string, decidedBy: string | null) =>
        pendingRow({ userId: "requester-1", status, decidedBy })
    );
  });

  it("ADMIN approve adds the member via the link, marks APPROVED, counts the use", async () => {
    callerRole("ADMIN");
    mocks.groupMemberRepo.upsert.mockResolvedValue({ roomId: ROOM, userId: "requester-1", role: "MEMBER", joinedAt: new Date() });

    const res = await request(app)
      .post(`/api/chat/group-join-requests/${REQ_ID}/approve`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.request.status).toBe("APPROVED");
    expect(mocks.groupJoinRequestRepo.settle).toHaveBeenCalledWith(REQ_ID, "APPROVED", TEST_USER_ID);
    expect(mocks.groupMemberRepo.upsert).toHaveBeenCalledWith(
      ROOM,
      "requester-1",
      expect.objectContaining({ joinedViaToken: TOKEN, invitedBy: ADMIN })
    );
    expect(mocks.groupInviteLinkRepo.incrementUsedCount).toHaveBeenCalledWith(TOKEN);
  });

  it("approve when already an ACTIVE member → AUTO_RESOLVED no-op", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockImplementation(
      async (_r: string, userId: string) =>
        userId === TEST_USER_ID
          ? { userId, role: "ADMIN", status: "ACTIVE" }
          : { userId, role: "MEMBER", status: "ACTIVE" }
    );

    const res = await request(app)
      .post(`/api/chat/group-join-requests/${REQ_ID}/approve`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.request.status).toBe("AUTO_RESOLVED");
    expect(mocks.groupMemberRepo.upsert).not.toHaveBeenCalled();
  });

  it.each(["MODERATOR", "MEMBER"])("%s cannot approve or reject (403)", async (role) => {
    callerRole(role);
    for (const action of ["approve", "reject"]) {
      const res = await request(app)
        .post(`/api/chat/group-join-requests/${REQ_ID}/${action}`)
        .set(bearer(makeAccessToken()));
      expect(res.status).toBe(403);
    }
    expect(mocks.groupJoinRequestRepo.settle).not.toHaveBeenCalled();
  });

  it("ADMIN reject → REJECTED and the requester is told", async () => {
    callerRole("ADMIN");

    const res = await request(app)
      .post(`/api/chat/group-join-requests/${REQ_ID}/reject`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.request.status).toBe("REJECTED");
    expect(mocks.redis.publish).toHaveBeenCalledWith(
      "user:requester-1",
      expect.stringContaining("group:join_request:rejected")
    );
  });

  it("decision on a settled request → 400 NOT_PENDING", async () => {
    callerRole("ADMIN");
    mocks.groupJoinRequestRepo.findById.mockResolvedValue(pendingRow({ status: "REJECTED" }));

    const res = await request(app)
      .post(`/api/chat/group-join-requests/${REQ_ID}/approve`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("CHAT_GROUP_JOIN_REQUEST_NOT_PENDING");
  });

  it("unknown request → 404", async () => {
    mocks.groupJoinRequestRepo.findById.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/chat/group-join-requests/nope/approve`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
  });

  it("requester cancels own request → CANCELLED; someone else's → 404", async () => {
    mocks.groupJoinRequestRepo.findById.mockResolvedValue(pendingRow());
    const mine = await request(app)
      .post(`/api/chat/group-join-requests/${REQ_ID}/cancel`)
      .set(bearer(makeAccessToken()));
    expect(mine.status).toBe(200);
    expect(mine.body.data.request.status).toBe("CANCELLED");

    mocks.groupJoinRequestRepo.findById.mockResolvedValue(pendingRow({ userId: "other" }));
    const theirs = await request(app)
      .post(`/api/chat/group-join-requests/${REQ_ID}/cancel`)
      .set(bearer(makeAccessToken()));
    expect(theirs.status).toBe(404);
  });
});

describe("lists", () => {
  it("ADMIN lists PENDING requests with cursor + total", async () => {
    callerRole("ADMIN");
    mocks.groupJoinRequestRepo.listPendingByRoom.mockResolvedValue([
      pendingRow({ id: "r1", userId: "u1" }),
      pendingRow({ id: "r2", userId: "u2" }),
      pendingRow({ id: "r3", userId: "u3" }),
    ]);
    mocks.groupJoinRequestRepo.countPendingByRoom.mockResolvedValue(3);

    const res = await request(app)
      .get(`/api/chat/group-join-requests/room/${ROOM}?limit=2`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.items.map((r: { id: string }) => r.id)).toEqual(["r1", "r2"]);
    expect(res.body.data.nextCursor).toBe("r2");
    expect(res.body.data.total).toBe(3);
  });

  it("MODERATOR cannot list (403)", async () => {
    callerRole("MODERATOR");
    const res = await request(app)
      .get(`/api/chat/group-join-requests/room/${ROOM}`)
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(403);
  });

  it("mine returns my PENDING requests", async () => {
    mocks.groupJoinRequestRepo.listPendingByUser.mockResolvedValue([pendingRow()]);
    const res = await request(app)
      .get(`/api/chat/group-join-requests/mine`)
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(200);
    expect(res.body.data.items[0].id).toBe(REQ_ID);
  });
});

describe("auto-resolve", () => {
  it("a direct join resolves the user's PENDING request as AUTO_RESOLVED", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(room({}));
    mocks.groupMemberRepo.upsert.mockResolvedValue({ roomId: ROOM, userId: TEST_USER_ID });
    // Public link join while a request from the private era is still pending.
    mocks.groupJoinRequestRepo.findPending.mockResolvedValue(pendingRow());
    mocks.groupJoinRequestRepo.settle.mockResolvedValue(pendingRow({ status: "AUTO_RESOLVED" }));

    const res = await join();
    await new Promise((r) => setImmediate(r));

    expect(res.body.data.status).toBe("JOINED");
    expect(mocks.groupJoinRequestRepo.settle).toHaveBeenCalledWith(REQ_ID, "AUTO_RESOLVED", null);
  });
});
