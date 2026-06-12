/**
 * Integration tests — per-conversation incremental sync.
 * Route: GET /api/chat/sync?conv_id=&from_seq=&limit=&type=
 *   (authenticate + per-user rate-limit + Zod query)
 *
 * The service probes private first, then group; catchup() returns
 * authorized:false (not a throw) for non-participants → controller maps that to
 * a 403.
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
});

const BASE = "/api/chat/sync";

describe("GET /api/chat/sync", () => {
  it("POSITIVE: private room → returns events + next_seq + conversationType PRIVATE", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: "prv_1",
      participants: [TEST_USER_ID, "peer-1"],
    });
    mocks.privateMessageRepo.findAfterSeq.mockResolvedValue([
      { id: "m1", sequenceNumber: 5, createdAt: new Date(1000) },
      { id: "m2", sequenceNumber: 6, createdAt: new Date(1100) },
    ]);

    const res = await request(app)
      .get(`${BASE}?conv_id=prv_1&from_seq=0&limit=50`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.conversationType).toBe("PRIVATE");
    expect(res.body.data.events).toHaveLength(2);
    expect(res.body.data.next_seq).toBe(6);
    expect(res.body.data.has_more).toBe(false);
  });

  it("POSITIVE: type=group skips the private probe and queries the group path", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      roomId: "grp_1",
      userId: TEST_USER_ID,
      role: "MEMBER",
    });
    mocks.groupMessageRepo.findAfterSeq.mockResolvedValue([
      { id: "g1", sequenceNumber: 2, createdAt: new Date(2000) },
    ]);

    const res = await request(app)
      .get(`${BASE}?conv_id=grp_1&type=group`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.conversationType).toBe("GROUP");
    expect(res.body.data.next_seq).toBe(2);
    // Private side must NOT be probed when type=group.
    expect(mocks.privateRoomRepo.findByRoomId).not.toHaveBeenCalled();
  });

  it("SECURITY/NEGATIVE: 403 when the caller participates in neither room", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue(null);
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}?conv_id=ghost`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("SECURITY: IDOR — non-participant of a private room gets 403, never the data", async () => {
    // Room exists but caller is NOT in participants.
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: "prv_x",
      participants: ["someone-else", "another"],
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}?conv_id=prv_x&type=private`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
    expect(mocks.privateMessageRepo.findAfterSeq).not.toHaveBeenCalled();
  });

  it("NEGATIVE: 400 when conv_id is missing", async () => {
    const res = await request(app)
      .get(`${BASE}?from_seq=0`)
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(400);
  });

  it("NEGATIVE: 400 for an invalid type enum value", async () => {
    const res = await request(app)
      .get(`${BASE}?conv_id=prv_1&type=channel`)
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(400);
  });

  it("NEGATIVE: 400 for limit above the max (200)", async () => {
    const res = await request(app)
      .get(`${BASE}?conv_id=prv_1&limit=9999`)
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(400);
  });

  it("SECURITY: 401 without a token", async () => {
    const res = await request(app).get(`${BASE}?conv_id=prv_1`);
    expect(res.status).toBe(401);
  });

  it("SECURITY: 401 for a forged token", async () => {
    const res = await request(app)
      .get(`${BASE}?conv_id=prv_1`)
      .set(bearer(makeForgedAccessToken()));
    expect(res.status).toBe(401);
  });
});
