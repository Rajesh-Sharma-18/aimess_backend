/**
 * Integration tests — community rooms (general rooms).
 * Routes (apps/chat-service/src/api/routes/community.routes.ts, mounted at /api/chat/community):
 *   GET  /rooms               (authenticate — viewer-scoped, AUDIT-102)
 *   GET  /rooms/search        (authenticate — viewer-scoped, AUDIT-102)
 *   POST /rooms/:roomId/join  (authenticate — mirror sync, not a grant, AUDIT-101)
 *   POST /rooms/:roomId/leave (authenticate)
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import {
  bearer,
  makeAccessToken,
  makeForgedAccessToken,
} from "../helpers/auth.js";
import { getCommunityReconcileClient } from "../../src/grpc/community.client.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const BASE = "/api/chat/community";

/**
 * Override the authoritative community-service membership answer for one test.
 * `assertCommunityMember` fails CLOSED on anything but an ACTIVE membership.
 */
function communitySays(live: {
  isMember: boolean;
  isBanned?: boolean;
  status?: string;
  role?: string;
}) {
  (getCommunityReconcileClient as jest.Mock).mockReturnValue({
    checkCommunityMembership: jest.fn(async () => ({
      isBanned: false,
      status: live.isMember ? "ACTIVE" : "",
      role: live.isMember ? "MEMBER" : "",
      ...live,
    })),
  });
}

beforeEach(() => {
  ({ app, mocks } = buildApp());
});

describe("GET /community/rooms (viewer-scoped list)", () => {
  it("POSITIVE: returns the rooms this viewer may see", async () => {
    mocks.roomMemberRepo.findVisibleRoomIdsByUser.mockResolvedValue([]);
    mocks.generalRoomRepo.findVisibleRooms.mockResolvedValue([
      { id: "room-1", name: "General", lastMessageAt: new Date(1) },
    ]);
    mocks.generalRoomRepo.countVisibleRooms.mockResolvedValue(1);

    const res = await request(app)
      .get(`${BASE}/rooms`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
  });

  // AUDIT-102 — the route carried no `authenticate`, so anonymous callers got
  // every active room INCLUDING private communities, with lastMessage previews.
  it("SECURITY: 401 without a token", async () => {
    const res = await request(app).get(`${BASE}/rooms`);
    expect(res.status).toBe(401);
    expect(mocks.generalRoomRepo.findVisibleRooms).not.toHaveBeenCalled();
  });

  // AUDIT-102 — the viewer's own membership ids are what widen the query past
  // PUBLIC; the repository is what applies the visibility filter, so assert the
  // ids actually reach it rather than re-testing Prisma.
  it("SECURITY: scopes the query to PUBLIC + the caller's own memberships", async () => {
    mocks.roomMemberRepo.findVisibleRoomIdsByUser.mockResolvedValue(["room-9"]);
    mocks.generalRoomRepo.findVisibleRooms.mockResolvedValue([]);
    mocks.generalRoomRepo.countVisibleRooms.mockResolvedValue(0);

    await request(app).get(`${BASE}/rooms`).set(bearer(makeAccessToken()));

    expect(mocks.generalRoomRepo.findVisibleRooms).toHaveBeenCalledWith(
      expect.objectContaining({ memberRoomIds: ["room-9"] })
    );
  });

  // AUDIT-102 — limit/page were read by the response builder and never reached
  // the query, so every call returned the entire table.
  it("pushes limit/page into the query instead of slicing after the fact", async () => {
    mocks.roomMemberRepo.findVisibleRoomIdsByUser.mockResolvedValue([]);
    mocks.generalRoomRepo.findVisibleRooms.mockResolvedValue([]);
    mocks.generalRoomRepo.countVisibleRooms.mockResolvedValue(0);

    await request(app)
      .get(`${BASE}/rooms?page=3&limit=10`)
      .set(bearer(makeAccessToken()));

    expect(mocks.generalRoomRepo.findVisibleRooms).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 10 })
    );
  });

  it("attaches hasUnread from the caller's read timestamps", async () => {
    mocks.roomMemberRepo.findVisibleRoomIdsByUser.mockResolvedValue([]);
    mocks.generalRoomRepo.findVisibleRooms.mockResolvedValue([
      { id: "room-1", name: "General", lastMessageAt: new Date(5000) },
    ]);
    mocks.generalRoomRepo.countVisibleRooms.mockResolvedValue(1);
    mocks.cacheRepo.getGeneralRoomReadTimestamps.mockResolvedValue({
      "room-1": "1000",
    });

    const res = await request(app)
      .get(`${BASE}/rooms`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data[0].hasUnread).toBe(true);
  });

  it("EDGE: empty room list → 200 with empty data", async () => {
    mocks.roomMemberRepo.findVisibleRoomIdsByUser.mockResolvedValue([]);
    mocks.generalRoomRepo.findVisibleRooms.mockResolvedValue([]);
    mocks.generalRoomRepo.countVisibleRooms.mockResolvedValue(0);

    const res = await request(app)
      .get(`${BASE}/rooms`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toEqual([]);
  });
});

describe("GET /community/rooms — livestream enrichment", () => {
  beforeEach(() => {
    mocks.roomMemberRepo.findVisibleRoomIdsByUser.mockResolvedValue([]);
  });

  it("attaches hasActiveLivestream + liveStreamCount per room", async () => {
    mocks.generalRoomRepo.findVisibleRooms.mockResolvedValue([
      { id: "room-1", name: "Live One", lastMessageAt: new Date(1) },
      { id: "room-2", name: "Quiet", lastMessageAt: new Date(1) },
    ]);
    mocks.generalRoomRepo.countVisibleRooms.mockResolvedValue(2);
    mocks.streamCountsClient.getActiveStreamCounts.mockResolvedValue(
      new Map([["room-1", 3]])
    );

    const res = await request(app)
      .get(`${BASE}/rooms`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    const rooms = res.body.data.data as Array<Record<string, unknown>>;
    const r1 = rooms.find((r) => r.id === "room-1");
    const r2 = rooms.find((r) => r.id === "room-2");
    expect(r1).toMatchObject({
      hasActiveLivestream: true,
      liveStreamCount: 3,
    });
    expect(r2).toMatchObject({
      hasActiveLivestream: false,
      liveStreamCount: 0,
    });
    // One batched gRPC call for the whole page — no N+1.
    expect(
      mocks.streamCountsClient.getActiveStreamCounts
    ).toHaveBeenCalledTimes(1);
  });

  it("clamps the count to the 5-stream cap", async () => {
    mocks.generalRoomRepo.findVisibleRooms.mockResolvedValue([
      { id: "room-1", name: "Live One", lastMessageAt: new Date(1) },
    ]);
    mocks.generalRoomRepo.countVisibleRooms.mockResolvedValue(1);
    mocks.streamCountsClient.getActiveStreamCounts.mockResolvedValue(
      new Map([["room-1", 99]])
    );

    const res = await request(app)
      .get(`${BASE}/rooms`)
      .set(bearer(makeAccessToken()));
    expect(res.body.data.data[0].liveStreamCount).toBe(5);
  });

  it("degrades to 0 when stream-service is unavailable (fail-open)", async () => {
    mocks.generalRoomRepo.findVisibleRooms.mockResolvedValue([
      { id: "room-1", name: "Live One", lastMessageAt: new Date(1) },
    ]);
    mocks.generalRoomRepo.countVisibleRooms.mockResolvedValue(1);
    mocks.streamCountsClient.getActiveStreamCounts.mockRejectedValue(
      new Error("stream-service down")
    );

    const res = await request(app)
      .get(`${BASE}/rooms`)
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(200);
    expect(res.body.data.data[0]).toMatchObject({
      hasActiveLivestream: false,
      liveStreamCount: 0,
    });
  });
});

describe("GET /community/rooms/search", () => {
  it("POSITIVE: returns search hits", async () => {
    mocks.roomMemberRepo.findVisibleRoomIdsByUser.mockResolvedValue([]);
    mocks.generalRoomRepo.searchRooms.mockResolvedValue([
      { id: "room-1", name: "Gamers" },
    ]);
    mocks.generalRoomRepo.countSearchResults.mockResolvedValue(1);

    const res = await request(app)
      .get(`${BASE}/rooms/search?query=game`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
  });

  // AUDIT-102 — search had the same missing `authenticate` as the list.
  it("SECURITY: 401 without a token", async () => {
    const res = await request(app).get(`${BASE}/rooms/search?query=game`);
    expect(res.status).toBe(401);
    expect(mocks.generalRoomRepo.searchRooms).not.toHaveBeenCalled();
  });

  it("SECURITY: scopes hits to PUBLIC + the caller's own memberships", async () => {
    mocks.roomMemberRepo.findVisibleRoomIdsByUser.mockResolvedValue(["room-9"]);
    mocks.generalRoomRepo.searchRooms.mockResolvedValue([]);
    mocks.generalRoomRepo.countSearchResults.mockResolvedValue(0);

    await request(app)
      .get(`${BASE}/rooms/search?query=game`)
      .set(bearer(makeAccessToken()));

    expect(mocks.generalRoomRepo.searchRooms).toHaveBeenCalledWith(
      expect.objectContaining({ memberRoomIds: ["room-9"], take: 20 })
    );
  });

  it("VALIDATION: rejects a limit above the 50 ceiling", async () => {
    const res = await request(app)
      .get(`${BASE}/rooms/search?query=game&limit=5000`)
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(400);
  });
});

describe("POST /community/rooms/:roomId/join", () => {
  it("POSITIVE: heals the mirror for a member community-service confirms", async () => {
    communitySays({ isMember: true, role: "MEMBER" });
    mocks.generalRoomRepo.findRoomById.mockResolvedValue({ id: "room-1" });
    // The mirror is stale/missing, so the guard reconciles it from the live answer.
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue(null);
    mocks.roomMemberRepo.upsert.mockResolvedValue({
      status: "active",
      role: "member",
    });

    const res = await request(app)
      .post(`${BASE}/rooms/room-1/join`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(mocks.roomMemberRepo.upsert).toHaveBeenCalledWith(
      "room-1",
      expect.any(String),
      expect.objectContaining({ status: "active" })
    );
    // AUDIT-101 — the count is owned by the community.member.synced consumer;
    // bumping it here double-counted every join and every repeat call.
    expect(mocks.generalRoomRepo.incMemberNumber).not.toHaveBeenCalled();
  });

  // AUDIT-101 — the route used to upsert an ACTIVE mirror row after only a ban
  // check, so ANY authenticated user could self-grant membership of ANY room,
  // private communities included, and every guard downstream trusted it.
  it("SECURITY: 403 and no mirror write when community-service says not-a-member", async () => {
    communitySays({ isMember: false });
    mocks.generalRoomRepo.findRoomById.mockResolvedValue({ id: "room-1" });
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .post(`${BASE}/rooms/room-1/join`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
    expect(mocks.roomMemberRepo.upsert).not.toHaveBeenCalled();
    expect(mocks.generalRoomRepo.incMemberNumber).not.toHaveBeenCalled();
  });

  it("NEGATIVE: 404 when the room does not exist", async () => {
    mocks.generalRoomRepo.findRoomById.mockResolvedValue(null);

    const res = await request(app)
      .post(`${BASE}/rooms/ghost/join`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
  });

  it("SECURITY: 403 USER_BANNED when the mirror says banned", async () => {
    communitySays({ isMember: false, isBanned: true, status: "BANNED" });
    mocks.generalRoomRepo.findRoomById.mockResolvedValue({ id: "room-1" });
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "banned",
    });

    const res = await request(app)
      .post(`${BASE}/rooms/room-1/join`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
    expect(mocks.roomMemberRepo.upsert).not.toHaveBeenCalled();
  });

  it("SECURITY: 401 joining without a token", async () => {
    const res = await request(app).post(`${BASE}/rooms/room-1/join`);
    expect(res.status).toBe(401);
  });
});

describe("POST /community/rooms/:roomId/leave", () => {
  it("POSITIVE: an active member leaves — status written as 'left'", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });

    const res = await request(app)
      .post(`${BASE}/rooms/room-1/leave`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    // AUDIT H5 — must persist "left" (was wrongly writing "active", a no-op leave).
    expect(mocks.roomMemberRepo.updateStatus).toHaveBeenCalledWith(
      "room-1",
      expect.any(String),
      "left",
      expect.objectContaining({ leftAt: expect.any(Date) })
    );
    expect(mocks.generalRoomRepo.incMemberNumber).toHaveBeenCalledWith(
      "room-1",
      -1
    );
  });

  // AUDIT H5 — leaving when not a member must NOT decrement memberNumber.
  it("BUG: 404 when the caller is not an active member (no phantom decrement)", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .post(`${BASE}/rooms/room-1/leave`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
    expect(mocks.roomMemberRepo.updateStatus).not.toHaveBeenCalled();
    expect(mocks.generalRoomRepo.incMemberNumber).not.toHaveBeenCalled();
  });

  it("SECURITY: 401 with a forged token", async () => {
    const res = await request(app)
      .post(`${BASE}/rooms/room-1/leave`)
      .set(bearer(makeForgedAccessToken()));
    expect(res.status).toBe(401);
  });
});
