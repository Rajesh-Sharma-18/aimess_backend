/**
 * AIM-02 — the refresh token as an httpOnly cookie. Covers the four things the
 * change has to get right: the cookie is set and unreadable from JS, a browser
 * can refresh with NO request body at all, rotation preserves a remember-me
 * lifetime instead of collapsing it to the 7-day default, and a dead token
 * clears the cookie so the browser is not stuck retrying it forever.
 */
jest.mock("../../src/repositories/refresh-token.repository.js", () => ({
  refreshTokenRepository: {
    findByTokenHash: jest.fn(),
    rotate: jest.fn(),
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

const DAY = 24 * 60 * 60 * 1000;

function storedToken(lifetimeMs: number, overrides: Record<string, unknown> = {}) {
  const createdAt = new Date(Date.now() - 60_000);
  return {
    id: "rt-1",
    userId: "user-1",
    sessionId: "22222222-2222-4222-8222-222222222222",
    rotatedToId: null,
    revokedAt: null,
    createdAt,
    expiresAt: new Date(createdAt.getTime() + lifetimeMs),
    session: { revokedAt: null },
    user: { deletedAt: null, status: "ACTIVE" },
    ...overrides,
  };
}

function refreshCookie(res: request.Response): string {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  return (raw ?? []).find((c) => c.startsWith("aimess_rt=")) ?? "";
}

describe("refresh-token cookie", () => {
  beforeEach(() => {
    repo.findByTokenHash.mockResolvedValue(storedToken(30 * DAY));
    repo.rotate.mockResolvedValue(undefined);
  });

  it("refreshes from the cookie alone, with no request body", async () => {
    const res = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", "aimess_rt=valid-refresh-token")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data.tokens.refreshToken).toBeDefined();
    expect(repo.rotate).toHaveBeenCalledTimes(1);
  });

  it("re-issues the rotated token as an httpOnly, path-scoped cookie", async () => {
    const res = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", "aimess_rt=valid-refresh-token")
      .send({});

    const cookie = refreshCookie(res);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/api/v1/auth");
    expect(cookie).toContain("SameSite=Lax");
    // The value in the cookie is the NEW token, not the one that was sent.
    expect(cookie).not.toContain("valid-refresh-token");
    expect(cookie).toContain(
      encodeURIComponent(res.body.data.tokens.refreshToken)
    );
  });

  it("keeps a 30-day remember-me lifetime across rotation", async () => {
    const res = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", "aimess_rt=valid-refresh-token")
      .send({});

    // 30 days, not the 7-day JWT_REFRESH_EXPIRES_IN default.
    expect(res.body.data.tokens.refreshTokenExpiresIn).toBe(30 * 86_400);
    // A remembered session survives the browser closing, so it is persistent.
    expect(refreshCookie(res)).toMatch(/Max-Age=\d+/);
  });

  it("gives a plain 7-day session a session cookie, not a persistent one", async () => {
    repo.findByTokenHash.mockResolvedValue(storedToken(7 * DAY));

    const res = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", "aimess_rt=valid-refresh-token")
      .send({});

    expect(res.body.data.tokens.refreshTokenExpiresIn).toBe(7 * 86_400);
    expect(refreshCookie(res)).not.toContain("Max-Age");
  });

  it("clears the cookie when the token is dead", async () => {
    repo.findByTokenHash.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", "aimess_rt=ghost-token")
      .send({});

    expect(res.status).toBe(401);
    expect(refreshCookie(res)).toMatch(/aimess_rt=;/);
  });

  it("still 400s when neither a body nor a cookie carries a token", async () => {
    const res = await request(app).post("/api/auth/refresh").send({});

    expect(res.status).toBe(400);
    expect(repo.rotate).not.toHaveBeenCalled();
  });

  it("prefers an explicit body token over the cookie", async () => {
    await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", "aimess_rt=cookie-token")
      .send({ refreshToken: "body-token" });

    // Hashed, so assert on the call count and that the cookie did not win by
    // checking the two produce different hashes.
    const { createHash } = await import("node:crypto");
    const bodyHash = createHash("sha256").update("body-token").digest("hex");
    expect(repo.findByTokenHash).toHaveBeenCalledWith(bodyHash);
  });
});
