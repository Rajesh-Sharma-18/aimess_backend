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
    getDeviceId: jest.fn(async () => "dev-1"),
  },
}));
jest.mock("../../src/services/audit.service.js", () => ({
  recordAuditEventSafe: jest.fn(),
}));
jest.mock("@aimess/redis", () => ({
  ...jest.requireActual("@aimess/redis"),
  publishSessionRevokedEvent: jest.fn(async () => 0),
}));

import request from "supertest";

import app from "../../src/app.js";
import { sessionRepository } from "../../src/repositories/session.repository.js";
import { recordAuditEventSafe } from "../../src/services/audit.service.js";
import { publishSessionRevokedEvent } from "@aimess/redis";
import {
  bearer,
  makeAccessToken,
  makeForgedAccessToken,
  TEST_SESSION_ID,
  TEST_USER_ID,
} from "../helpers/auth.js";

const repo = sessionRepository as unknown as Record<string, jest.Mock>;
const audit = recordAuditEventSafe as unknown as jest.Mock;
const publishRevoked = publishSessionRevokedEvent as unknown as jest.Mock;

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
    // Phase 12 (Logout Device) must audit "LINKED_DEVICE_REVOKED".
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "LINKED_DEVICE_REVOKED",
        targetType: "linked_device",
        targetId: OTHER_SESSION_ID,
        userId: TEST_USER_ID,
      })
    );
    // Spec #7: a live socket for this session must be force-disconnected, not
    // just left to expire naturally.
    expect(publishRevoked).toHaveBeenCalledWith(
      expect.anything(),
      TEST_USER_ID,
      OTHER_SESSION_ID
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
    // Same realtime signal as single-session terminate: each revoked device
    // must be force-disconnected + trigger session:list_updated on the caller.
    expect(publishRevoked).toHaveBeenCalledWith(
      expect.anything(),
      TEST_USER_ID,
      OTHER_SESSION_ID
    );
    expect(publishRevoked).not.toHaveBeenCalledWith(
      expect.anything(),
      TEST_USER_ID,
      TEST_SESSION_ID
    );
  });

  it("does not publish any realtime revoke event when nothing was revoked", async () => {
    repo.revokeOthersForUser.mockResolvedValue({ revokedCount: 0 });
    publishRevoked.mockClear();

    const res = await request(app)
      .post("/api/auth/sessions/revoke-all")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(publishRevoked).not.toHaveBeenCalled();
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).post("/api/auth/sessions/revoke-all");
    expect(res.status).toBe(401);
    expect(repo.revokeOthersForUser).not.toHaveBeenCalled();
  });
});

// POST /api/auth/logout — logout must trigger the SAME realtime signal as
// DELETE /sessions/:id (force-disconnect any live socket for this session +
// session:list_updated on the caller's other devices), reusing
// publishSessionRevokedEvent/session-revoke:<userId> rather than a new event.
describe("POST /api/auth/logout", () => {
  beforeEach(() => {
    repo.revokeForUser.mockResolvedValue({ revoked: true });
    publishRevoked.mockClear();
  });

  it("revokes the current session and publishes the realtime revoke signal → 200", async () => {
    const res = await request(app)
      .post("/api/auth/logout")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(repo.revokeForUser).toHaveBeenCalledWith(
      TEST_USER_ID,
      TEST_SESSION_ID,
      expect.anything()
    );
    // Other devices must get session:list_updated + this device's live
    // socket(s) must be force-disconnected, same as DELETE /sessions/:id.
    // ...but tagged "logout" so the gateway does NOT tell this device its
    // session was terminated — it is the one that asked to sign out.
    expect(publishRevoked).toHaveBeenCalledWith(
      expect.anything(),
      TEST_USER_ID,
      TEST_SESSION_ID,
      "logout"
    );
  });

  it("does not publish the realtime revoke signal when the revoke races to a no-op", async () => {
    repo.revokeForUser.mockResolvedValue({ revoked: false });

    const res = await request(app)
      .post("/api/auth/logout")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(publishRevoked).not.toHaveBeenCalled();
  });

  // AIM-02: no longer 401 - see tests/auth/logout.test.ts. With neither a
  // bearer nor a refresh cookie there is no session to identify, so nothing is
  // revoked and no realtime signal fires.
  it("without a token or cookie it is a 200 no-op, touching neither revoke nor the realtime signal", async () => {
    const res = await request(app).post("/api/auth/logout");
    expect(res.status).toBe(200);
    expect(repo.revokeForUser).not.toHaveBeenCalled();
    expect(publishRevoked).not.toHaveBeenCalled();
  });
});
