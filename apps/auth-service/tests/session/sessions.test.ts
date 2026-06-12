/**
 * GET /api/auth/sessions, DELETE /api/auth/sessions/:sessionId and
 * POST /api/auth/sessions/revoke-all — all auth-required. Covers happy paths,
 * the JWT auth gate, the :sessionId UUID validation, not-found, and an IDOR
 * attempt (target a session that does not belong to the caller → 404).
 */
jest.mock("../../src/repositories/session.repository.js", () => ({
  sessionRepository: {
    listActiveByUserId: jest.fn(),
    listActiveSessionIds: jest.fn(),
    findActiveForUser: jest.fn(),
    revokeForUser: jest.fn(),
    revokeOthersForUser: jest.fn(),
  },
}));

import request from "supertest";

import app from "../../src/app.js";
import { sessionRepository } from "../../src/repositories/session.repository.js";
import {
  bearer,
  makeAccessToken,
  makeForgedAccessToken,
  TEST_SESSION_ID,
  TEST_USER_ID,
} from "../helpers/auth.js";

const repo = sessionRepository as unknown as Record<string, jest.Mock>;

const OTHER_SESSION_ID = "33333333-3333-4333-8333-333333333333";

function sessionRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    deviceId: "dev-1",
    deviceName: "Pixel",
    deviceType: "ANDROID",
    osVersion: "14",
    appVersion: "1.0.0",
    ipAddress: "1.2.3.4",
    countryCode: "US",
    lastActiveAt: new Date("2026-01-02T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("GET /api/auth/sessions", () => {
  beforeEach(() => {
    repo.listActiveByUserId.mockResolvedValue([
      sessionRow(TEST_SESSION_ID),
      sessionRow(OTHER_SESSION_ID),
    ]);
  });

  it("lists active sessions and flags the current one → 200", async () => {
    const res = await request(app)
      .get("/api/auth/sessions")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.sessions).toHaveLength(2);
    const current = res.body.data.sessions.find(
      (s: { sessionId: string }) => s.sessionId === TEST_SESSION_ID
    );
    expect(current.isCurrent).toBe(true);
  });

  it("returns an empty list when there are no active sessions", async () => {
    repo.listActiveByUserId.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/auth/sessions")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.sessions).toEqual([]);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/auth/sessions");
    expect(res.status).toBe(401);
    expect(repo.listActiveByUserId).not.toHaveBeenCalled();
  });

  it("returns 401 for a forged token", async () => {
    const res = await request(app)
      .get("/api/auth/sessions")
      .set(bearer(makeForgedAccessToken()));
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/auth/sessions/:sessionId", () => {
  beforeEach(() => {
    repo.findActiveForUser.mockResolvedValue(sessionRow(OTHER_SESSION_ID));
    repo.revokeForUser.mockResolvedValue({ revoked: true });
  });

  it("revokes a specific session → 200", async () => {
    const res = await request(app)
      .delete(`/api/auth/sessions/${OTHER_SESSION_ID}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(repo.revokeForUser).toHaveBeenCalledWith(
      TEST_USER_ID,
      OTHER_SESSION_ID,
      expect.anything()
    );
  });

  it("returns 404 when the target session does not exist for the caller (IDOR-safe)", async () => {
    repo.findActiveForUser.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/auth/sessions/${OTHER_SESSION_ID}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
    expect(repo.revokeForUser).not.toHaveBeenCalled();
  });

  it("returns 404 when the revoke races to no-op (already gone)", async () => {
    repo.revokeForUser.mockResolvedValue({ revoked: false });

    const res = await request(app)
      .delete(`/api/auth/sessions/${OTHER_SESSION_ID}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
  });

  it("returns 400 for a non-UUID sessionId param", async () => {
    const res = await request(app)
      .delete("/api/auth/sessions/not-a-uuid")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(400);
    expect(repo.findActiveForUser).not.toHaveBeenCalled();
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).delete(
      `/api/auth/sessions/${OTHER_SESSION_ID}`
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /api/auth/sessions/revoke-all", () => {
  beforeEach(() => {
    repo.listActiveSessionIds.mockResolvedValue([
      { id: TEST_SESSION_ID },
      { id: OTHER_SESSION_ID },
    ]);
    repo.revokeOthersForUser.mockResolvedValue({ revokedCount: 1 });
  });

  it("revokes every other session, keeping the current one → 200", async () => {
    const res = await request(app)
      .post("/api/auth/sessions/revoke-all")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(repo.revokeOthersForUser).toHaveBeenCalledWith(
      TEST_USER_ID,
      TEST_SESSION_ID,
      expect.anything()
    );
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).post("/api/auth/sessions/revoke-all");
    expect(res.status).toBe(401);
    expect(repo.revokeOthersForUser).not.toHaveBeenCalled();
  });
});
