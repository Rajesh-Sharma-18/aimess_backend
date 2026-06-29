/**
 * Integration tests — community rooms (general rooms).
 * Routes (apps/chat-service/src/api/routes/community.routes.ts, mounted at /api/chat/community):
 *   GET  /rooms              (PUBLIC — no auth; reads req.auth?.userId defensively)
 *   GET  /rooms/search       (PUBLIC)
 *   POST /rooms/:roomId/join (authenticate)
 *   POST /rooms/:roomId/leave (authenticate)
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import {
  bearer,
  makeAccessToken,
  makeForgedAccessToken,
} from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const BASE = "/api/chat/community";

beforeEach(() => {
  ({ app, mocks } = buildApp());
});

describe("GET /community/rooms (public list)", () => {
  it("POSITIVE (anonymous): returns active rooms without a token", async () => {
    mocks.generalRoomRepo.findActiveRooms.mockResolvedValue([
      { id: "room-1", name: "General", lastMessageAt: new Date(1) },
    ]);
    mocks.generalRoomRepo.countActiveRooms.mockResolvedValue(1);

    const res = await request(app).get(`${BASE}/rooms`);

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
  });

  it("EDGE: the list route is PUBLIC — a bearer token is ignored (no auth middleware), so the anonymous path runs and no hasUnread is attached", async () => {
    // The route has no `authenticate`, so req.auth is never populated even with a
    // valid token → controller calls getRooms(null) → no read-timestamp lookup.
    mocks.generalRoomRepo.findActiveRooms.mockResolvedValue([
      { id: "room-1", name: "General", lastMessageAt: new Date(5000) },
    ]);
    mocks.generalRoomRepo.countActiveRooms.mockResolvedValue(1);

    const res = await request(app)
      .get(`${BASE}/rooms`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data[0].hasUnread).toBeUndefined();
    expect(mocks.cacheRepo.getGeneralRoomReadTimestamps).not.toHaveBeenCalled();
  });

  it("EDGE: empty room list → 200 with empty data", async () => {
    mocks.generalRoomRepo.findActiveRooms.mockResolvedValue([]);
    mocks.generalRoomRepo.countActiveRooms.mockResolvedValue(0);

    const res = await request(app).get(`${BASE}/rooms`);

    expect(res.status).toBe(200);
    expect(res.body.data.data).toEqual([]);
  });
});

describe("GET /community/rooms — livestream enrichment", () => {
  it("attaches hasActiveLivestream + activeLivestreamCount per room", async () => {
    mocks.generalRoomRepo.findActiveRooms.mockResolvedValue([
      { id: "room-1", name: "Live One", lastMessageAt: new Date(1) },
      { id: "room-2", name: "Quiet", lastMessageAt: new Date(1) },
    ]);
    mocks.generalRoomRepo.countActiveRooms.mockResolvedValue(2);
    mocks.streamCountsClient.getActiveStreamCounts.mockResolvedValue(
      new Map([["room-1", 3]])
    );

    const res = await request(app).get(`${BASE}/rooms`);

    expect(res.status).toBe(200);
    const rooms = res.body.data.data as Array<Record<string, unknown>>;
    const r1 = rooms.find((r) => r.id === "room-1");
    const r2 = rooms.find((r) => r.id === "room-2");
    expect(r1).toMatchObject({
      hasActiveLivestream: true,
      activeLivestreamCount: 3,
    });
    expect(r2).toMatchObject({
      hasActiveLivestream: false,
      activeLivestreamCount: 0,
    });
    // One batched gRPC call for the whole page — no N+1.
    expect(
      mocks.streamCountsClient.getActiveStreamCounts
    ).toHaveBeenCalledTimes(1);
  });

  it("clamps the count to the 5-stream cap", async () => {
    mocks.generalRoomRepo.findActiveRooms.mockResolvedValue([
      { id: "room-1", name: "Live One", lastMessageAt: new Date(1) },
    ]);
    mocks.generalRoomRepo.countActiveRooms.mockResolvedValue(1);
    mocks.streamCountsClient.getActiveStreamCounts.mockResolvedValue(
      new Map([["room-1", 99]])
    );

    const res = await request(app).get(`${BASE}/rooms`);
    expect(res.body.data.data[0].activeLivestreamCount).toBe(5);
  });

  it("degrades to 0 when stream-service is unavailable (fail-open)", async () => {
    mocks.generalRoomRepo.findActiveRooms.mockResolvedValue([
      { id: "room-1", name: "Live One", lastMessageAt: new Date(1) },
    ]);
    mocks.generalRoomRepo.countActiveRooms.mockResolvedValue(1);
    mocks.streamCountsClient.getActiveStreamCounts.mockRejectedValue(
      new Error("stream-service down")
    );

    const res = await request(app).get(`${BASE}/rooms`);
    expect(res.status).toBe(200);
    expect(res.body.data.data[0]).toMatchObject({
      hasActiveLivestream: false,
      activeLivestreamCount: 0,
    });
  });
});

describe("GET /community/rooms/search (public)", () => {
  it("POSITIVE: returns search hits", async () => {
    mocks.generalRoomRepo.searchRooms.mockResolvedValue([
      { id: "room-1", name: "Gamers" },
    ]);
    mocks.generalRoomRepo.countSearchResults.mockResolvedValue(1);

    const res = await request(app).get(`${BASE}/rooms/search?query=game`);

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
  });
});

describe("POST /community/rooms/:roomId/join", () => {
  it("POSITIVE: joins a room the caller isn't banned from", async () => {
    mocks.generalRoomRepo.findRoomById.mockResolvedValue({ id: "room-1" });
    mocks.roomMemberRepo.isBanned.mockResolvedValue(false);

    const res = await request(app)
      .post(`${BASE}/rooms/room-1/join`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(mocks.roomMemberRepo.upsert).toHaveBeenCalled();
    expect(mocks.generalRoomRepo.incMemberNumber).toHaveBeenCalledWith(
      "room-1",
      1
    );
  });

  it("NEGATIVE: 404 when the room does not exist", async () => {
    mocks.generalRoomRepo.findRoomById.mockResolvedValue(null);

    const res = await request(app)
      .post(`${BASE}/rooms/ghost/join`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
  });

  it("SECURITY: 400 when the caller is banned from the room", async () => {
    mocks.generalRoomRepo.findRoomById.mockResolvedValue({ id: "room-1" });
    mocks.roomMemberRepo.isBanned.mockResolvedValue(true);

    const res = await request(app)
      .post(`${BASE}/rooms/room-1/join`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(400);
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
