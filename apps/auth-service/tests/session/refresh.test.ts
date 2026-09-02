/**
 * POST /api/auth/refresh and POST /api/auth/token — unauthenticated rotation
 * endpoints. The session.service is the unit under test through the real
 * controller; the refresh-token + session repositories are mocked so each guard
 * branch (missing, reused, revoked, expired, session-revoked, account-inactive)
 * is driven from data.
 */
jest.mock("../../src/repositories/refresh-token.repository.js", () => ({
  refreshTokenRepository: {
    findByTokenHash: jest.fn(),
    rotate: jest.fn(),
    // Reuse detection now distinguishes a benign replay (the client had not yet
    // stored the rotated token) from a stolen one, by asking how long ago the
    // rotation happened. Default: no successor row, so any reuse is treated as
    // theft — the strict path these cases assert.
    findSuccessor: jest.fn(async () => null),
  },
}));
jest.mock("../../src/repositories/session.repository.js", () => ({
  sessionRepository: {
    listActiveSessionIds: jest.fn(async () => []),
    revokeAllForUser: jest.fn(async () => undefined),
  },
}));

import request from "supertest";

import app from "../../src/app.js";
import { refreshTokenRepository } from "../../src/repositories/refresh-token.repository.js";

const repo = refreshTokenRepository as unknown as Record<string, jest.Mock>;

function storedToken(overrides: Record<string, unknown> = {}) {
  return {
    id: "rt-1",
    userId: "user-1",
    sessionId: "22222222-2222-4222-8222-222222222222",
    rotatedToId: null,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    session: { revokedAt: null },
    user: { deletedAt: null, status: "ACTIVE" },
    ...overrides,
  };
}

describe("POST /api/auth/refresh", () => {
  beforeEach(() => {
    repo.findByTokenHash.mockResolvedValue(storedToken());
    repo.rotate.mockResolvedValue(undefined);
  });

  it("rotates a valid refresh token → 200 with new token pair", async () => {
    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: "valid-refresh-token" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.tokens.accessToken).toBeDefined();
    expect(res.body.data.tokens.refreshToken).toBeDefined();
    expect(repo.rotate).toHaveBeenCalledTimes(1);
  });

  it("returns 401 for an unknown refresh token", async () => {
    repo.findByTokenHash.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: "ghost-token" });

    expect(res.status).toBe(401);
    expect(repo.rotate).not.toHaveBeenCalled();
  });

  it("returns 401 + revokes all sessions on a reused (rotated) token", async () => {
    repo.findByTokenHash.mockResolvedValue(
      storedToken({ rotatedToId: "rt-2" })
    );

    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: "reused-token" });

    expect(res.status).toBe(401);
    expect(repo.rotate).not.toHaveBeenCalled();
  });

  it("returns 401 for a revoked refresh token", async () => {
    repo.findByTokenHash.mockResolvedValue(
      storedToken({ revokedAt: new Date() })
    );

    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: "revoked-token" });

    expect(res.status).toBe(401);
  });

  it("returns 401 for an expired refresh token", async () => {
    repo.findByTokenHash.mockResolvedValue(
      storedToken({ expiresAt: new Date(Date.now() - 1000) })
    );

    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: "expired-token" });

    expect(res.status).toBe(401);
  });

  it("returns 401 when the owning session was revoked", async () => {
    repo.findByTokenHash.mockResolvedValue(
      storedToken({ session: { revokedAt: new Date() } })
    );

    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: "session-revoked-token" });

    expect(res.status).toBe(401);
  });

  it("returns 401 when the account is deleted", async () => {
    repo.findByTokenHash.mockResolvedValue(
      storedToken({ user: { deletedAt: new Date(), status: "ACTIVE" } })
    );

    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: "deleted-account-token" });

    expect(res.status).toBe(401);
  });

  it("returns 401 when the account is suspended", async () => {
    repo.findByTokenHash.mockResolvedValue(
      storedToken({ user: { deletedAt: null, status: "SUSPENDED" } })
    );

    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: "suspended-account-token" });

    expect(res.status).toBe(401);
  });

  // Refresh is the bypass a permanent ban has to close: a still-valid refresh
  // token would otherwise mint a fresh access token every 15 minutes forever.
  // 403 + ACCOUNT_BANNED (not 401) so the client stops retrying instead of
  // reading it as "sign in again".
  it("returns 403 ACCOUNT_BANNED when the account is permanently banned", async () => {
    repo.findByTokenHash.mockResolvedValue(
      storedToken({ user: { deletedAt: null, status: "BANNED" } })
    );

    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: "banned-account-token" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_BANNED");
  });

  it.each([
    ["missing refreshToken", {}],
    ["empty refreshToken", { refreshToken: "" }],
    ["whitespace-only refreshToken", { refreshToken: "   " }],
    ["wrong type", { refreshToken: 123 }],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app).post("/api/auth/refresh").send(body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(repo.findByTokenHash).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/token", () => {
  beforeEach(() => {
    repo.findByTokenHash.mockResolvedValue(storedToken());
    repo.rotate.mockResolvedValue(undefined);
  });

  /**
   * AIM-66. This case previously asserted that `/auth/token` must NOT rotate.
   * That was the defect: a stolen refresh token could be replayed here forever
   * and never tripped the reuse detection protecting `/auth/refresh` — a thief
   * simply avoided the endpoint that rotates. It now rotates and RETURNS the
   * replacement, which the caller must store.
   */
  it("issues a fresh access token AND rotates the refresh token → 200", async () => {
    const res = await request(app)
      .post("/api/auth/token")
      .send({ refreshToken: "valid-refresh-token" });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.accessTokenExpiresIn).toBeDefined();
    expect(repo.rotate).toHaveBeenCalledTimes(1);
    // The replacement has to reach the caller, or the next call presents a
    // spent token and the tripwire revokes every session it has.
    expect(res.body.data.refreshToken).toBeDefined();
    expect(res.body.data.refreshTokenExpiresIn).toBeDefined();
  });

  it("returns 401 for an expired refresh token", async () => {
    repo.findByTokenHash.mockResolvedValue(
      storedToken({ expiresAt: new Date(Date.now() - 1000) })
    );

    const res = await request(app)
      .post("/api/auth/token")
      .send({ refreshToken: "expired-token" });

    expect(res.status).toBe(401);
  });

  it("returns 400 when refreshToken is missing", async () => {
    const res = await request(app).post("/api/auth/token").send({});
    expect(res.status).toBe(400);
  });
});
