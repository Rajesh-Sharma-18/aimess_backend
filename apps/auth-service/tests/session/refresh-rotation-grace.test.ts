/**
 * AIM-66 — rotation on `/auth/token`, and telling a benign replay from theft.
 *
 * Rotation introduces an unavoidable race: the server has replaced the token
 * before the client has stored the replacement. A dropped response, two tabs
 * refreshing at once, or an app killed or frozen mid-flight all resend the OLD
 * token through no fault of the holder — sometimes hours later. These cases pin
 * both sides of the line: too strict logs honest users out, too loose lets two
 * holders share one chain undetected.
 */
jest.mock("../../src/repositories/refresh-token.repository.js", () => ({
  refreshTokenRepository: {
    findByTokenHash: jest.fn(),
    rotate: jest.fn(async () => ({ id: "next-token-id" })),
    findSuccessor: jest.fn(),
  },
}));
jest.mock("../../src/repositories/session.repository.js", () => ({
  sessionRepository: {
    listActiveSessionIds: jest.fn(async () => [{ id: "session-1" }]),
    revokeAllForUser: jest.fn(async () => undefined),
    getDeviceId: jest.fn(async () => "device-1"),
    revokeForUser: jest.fn(async () => ({ revoked: true })),
  },
}));
jest.mock("../../src/lib/session-active-cache.js", () => ({
  markSessionActive: jest.fn(async () => undefined),
  markSessionRevoked: jest.fn(async () => undefined),
  markSessionsRevoked: jest.fn(async () => undefined),
}));
jest.mock("../../src/messaging/publish-session-revoked.js", () => ({
  publishSessionDeviceRevokedSafe: jest.fn(),
  publishAllSessionsRevokedSafe: jest.fn(),
}));
jest.mock("@aimess/redis", () => ({
  ...jest.requireActual("@aimess/redis"),
  publishSessionRevokedEvent: jest.fn(async () => 0),
}));

import request from "supertest";

import app from "../../src/app.js";
import { refreshTokenRepository } from "../../src/repositories/refresh-token.repository.js";
import { sessionRepository } from "../../src/repositories/session.repository.js";
import { publishAllSessionsRevokedSafe } from "../../src/messaging/publish-session-revoked.js";

const repo = refreshTokenRepository as unknown as Record<string, jest.Mock>;
const sessions = sessionRepository as unknown as Record<string, jest.Mock>;
const publishAllRevoked = publishAllSessionsRevokedSafe as unknown as jest.Mock;

/** A refresh token row that has ALREADY been rotated once. */
function rotatedToken() {
  return {
    id: "old-token-id",
    userId: "user-1",
    sessionId: "session-1",
    expiresAt: new Date(Date.now() + 86_400_000),
    revokedAt: new Date(),
    rotatedToId: "new-token-id",
    createdAt: new Date(Date.now() - 7 * 86_400_000),
    session: { id: "session-1", revokedAt: null },
    user: {
      id: "user-1",
      status: "ACTIVE",
      deletedAt: null,
      role: "USER",
    },
  };
}

/** A chain link minted `secondsAgo` ago, still current unless overridden. */
function link(
  id: string,
  secondsAgo: number,
  overrides: Record<string, unknown> = {}
) {
  return {
    id,
    tokenHash: "hash",
    expiresAt: new Date(Date.now() + 86_400_000),
    revokedAt: null,
    rotatedToId: null,
    replayOfId: null,
    createdAt: new Date(Date.now() - secondsAgo * 1000),
    ...overrides,
  };
}

const PATHS = ["/api/auth/token", "/api/auth/refresh"];

function expectSessionRevoked() {
  expect(sessions.revokeForUser).toHaveBeenCalledWith(
    "user-1",
    "session-1",
    "TOKEN_REUSE_DETECTED"
  );
  // Only the replayed session — the account's other devices stay signed in.
  expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  expect(publishAllRevoked).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  repo.findByTokenHash.mockResolvedValue(rotatedToken());
});

describe("benign replays", () => {
  it.each(PATHS)("%s: concurrent race inside the grace window", async (path) => {
    repo.findSuccessor.mockResolvedValue(link("new-token-id", 5));

    const res = await request(app).post(path).send({ refreshToken: "t0" });

    expect(res.status).toBe(200);
    expect(sessions.revokeForUser).not.toHaveBeenCalled();
    expect(repo.rotate).toHaveBeenCalledWith(
      expect.objectContaining({
        oldTokenId: "new-token-id",
        replayOfId: "old-token-id",
      })
    );
  });

  it.each(PATHS)(
    "%s: lost response replayed hours later, successor never used",
    async (path) => {
      repo.findSuccessor.mockResolvedValue(link("new-token-id", 3600));

      const res = await request(app).post(path).send({ refreshToken: "t0" });

      expect(res.status).toBe(200);
      expect(sessions.revokeForUser).not.toHaveBeenCalled();
    }
  );

  it("the replay's own response was lost too: walks to the head", async () => {
    repo.findSuccessor
      .mockResolvedValueOnce(
        link("new-token-id", 7200, {
          rotatedToId: "replay-1",
          revokedAt: new Date(),
        })
      )
      .mockResolvedValueOnce(
        link("replay-1", 3600, { replayOfId: "old-token-id" })
      );

    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: "t0" });

    expect(res.status).toBe(200);
    expect(repo.rotate).toHaveBeenCalledWith(
      expect.objectContaining({
        oldTokenId: "replay-1",
        replayOfId: "old-token-id",
      })
    );
  });

  it("a normal refresh is not marked as a replay", async () => {
    repo.findByTokenHash.mockResolvedValue({
      ...rotatedToken(),
      revokedAt: null,
      rotatedToId: null,
    });

    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: "t0" });

    expect(res.status).toBe(200);
    expect(repo.rotate).toHaveBeenCalledWith(
      expect.objectContaining({ oldTokenId: "old-token-id", replayOfId: undefined })
    );
  });
});

describe("theft", () => {
  it.each(PATHS)(
    "%s: the successor holder already moved the chain on",
    async (path) => {
      repo.findSuccessor
        .mockResolvedValueOnce(
          link("new-token-id", 3600, {
            rotatedToId: "third-token-id",
            revokedAt: new Date(),
          })
        )
        // Minted by the successor's own refresh, not by a replay of t0.
        .mockResolvedValueOnce(link("third-token-id", 60));

      const res = await request(app).post(path).send({ refreshToken: "t0" });

      expect(res.status).toBe(401);
      expectSessionRevoked();
    }
  );

  it("two holders alternating: successor minted for the OTHER holder's replay", async () => {
    repo.findSuccessor.mockResolvedValue(
      link("new-token-id", 3600, { replayOfId: "someone-elses-token" })
    );

    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: "t1" });

    expect(res.status).toBe(401);
    expectSessionRevoked();
  });

  it("the successor was revoked without being rotated", async () => {
    repo.findSuccessor.mockResolvedValue(
      link("new-token-id", 1, { revokedAt: new Date() })
    );

    const res = await request(app)
      .post("/api/auth/token")
      .send({ refreshToken: "t0" });

    expect(res.status).toBe(401);
  });

  it("the successor row is missing entirely", async () => {
    repo.findSuccessor.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/auth/token")
      .send({ refreshToken: "t0" });

    expect(res.status).toBe(401);
    expectSessionRevoked();
  });
});

describe("/auth/token keeps the session's lifetime", () => {
  it("a 30-day remember-me session is not collapsed to 7 days", async () => {
    const now = Date.now();
    repo.findByTokenHash.mockResolvedValue({
      ...rotatedToken(),
      revokedAt: null,
      rotatedToId: null,
      createdAt: new Date(now - 86_400_000),
      expiresAt: new Date(now + 29 * 86_400_000),
    });

    const res = await request(app)
      .post("/api/auth/token")
      .send({ refreshToken: "t0" });

    expect(res.status).toBe(200);
    expect(res.body.data.refreshTokenExpiresIn).toBe(30 * 86_400);
  });
});
