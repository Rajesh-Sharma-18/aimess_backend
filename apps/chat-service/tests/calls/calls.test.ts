/**
 * Integration tests — call history (REST read side).
 * Routes (apps/chat-service/src/api/routes/call.routes.ts):
 *   GET /api/chat/calls            (history, cursor paginated, Zod query)
 *   GET /api/chat/calls/:callId    (single call by id)
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

describe("GET /api/chat/calls (history)", () => {
  it("POSITIVE: returns the caller's calls with hasMore/nextCursor", async () => {
    // limit defaults to 20; service over-fetches (limit+1) to compute hasMore.
    const calls = [
      {
        callId: "c1",
        callerId: "u",
        calleeId: "p",
        initiatedAt: new Date(2000),
      },
      {
        callId: "c2",
        callerId: "u",
        calleeId: "p",
        initiatedAt: new Date(1000),
      },
    ];
    mocks.callRepo.findByParticipant.mockResolvedValue(calls);

    const res = await request(app)
      .get("/api/chat/calls")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.calls).toHaveLength(2);
    expect(res.body.data.hasMore).toBe(false);
    expect(res.body.data.nextCursor).toBeNull();
  });

  it("EDGE: more rows than limit → hasMore true and a nextCursor", async () => {
    // Ask for limit=1; return 2 rows so the service slices and sets hasMore.
    mocks.callRepo.findByParticipant.mockResolvedValue([
      {
        callId: "c1",
        callerId: "u",
        calleeId: "p",
        initiatedAt: new Date(3000),
      },
      {
        callId: "c2",
        callerId: "u",
        calleeId: "p",
        initiatedAt: new Date(2000),
      },
    ]);

    const res = await request(app)
      .get("/api/chat/calls?limit=1")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.calls).toHaveLength(1);
    expect(res.body.data.hasMore).toBe(true);
    expect(res.body.data.nextCursor).not.toBeNull();
  });

  it("NEGATIVE: 400 when limit exceeds the max (50)", async () => {
    const res = await request(app)
      .get("/api/chat/calls?limit=100")
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(400);
  });

  it("SECURITY: 401 without a token", async () => {
    const res = await request(app).get("/api/chat/calls");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/chat/calls/:callId", () => {
  it("POSITIVE: returns the call when the caller is a participant", async () => {
    mocks.callRepo.findByCallId.mockResolvedValue({
      callId: "c1",
      callerId: TEST_USER_ID,
      calleeId: "peer",
      status: "ENDED",
      initiatedAt: new Date(1000),
    });

    const res = await request(app)
      .get("/api/chat/calls/c1")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.callId).toBe("c1");
    expect(mocks.callRepo.findByCallId).toHaveBeenCalledWith("c1");
  });

  // AUDIT H8 — a call must not be readable by a non-participant.
  it("SECURITY: IDOR — 403 when the caller is neither caller nor callee", async () => {
    mocks.callRepo.findByCallId.mockResolvedValue({
      callId: "c1",
      callerId: "other-1",
      calleeId: "other-2",
      status: "ENDED",
      initiatedAt: new Date(1000),
    });

    const res = await request(app)
      .get("/api/chat/calls/c1")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
  });

  it("NEGATIVE: 404 when the call does not exist", async () => {
    mocks.callRepo.findByCallId.mockResolvedValue(null);

    const res = await request(app)
      .get("/api/chat/calls/does-not-exist")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("SECURITY: 401 for a forged token", async () => {
    const res = await request(app)
      .get("/api/chat/calls/c1")
      .set(bearer(makeForgedAccessToken()));
    expect(res.status).toBe(401);
  });
});
