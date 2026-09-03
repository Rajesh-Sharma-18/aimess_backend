/**
 * AIM-66 — rotation on `/auth/token`, and telling a benign replay from theft.
 *
 * `/auth/token` used to mint an access token and leave the refresh token
 * untouched, so a stolen refresh token could be replayed indefinitely and never
 * tripped the reuse detection that protects `/auth/refresh` — a thief simply
 * used the endpoint that does not rotate. It now rotates like `/auth/refresh`.
 *
 * Rotation introduces an unavoidable race: the server has replaced the token
 * before the client has stored the replacement. A dropped response, two tabs
 * refreshing at once, or an app killed mid-flight all resend the OLD token
 * through no fault of the holder. Treating that as theft signs the user out
 * everywhere, so a short grace window distinguishes the two — and these cases
 * pin both sides of that line, because getting it wrong in either direction is
 * bad: too strict logs honest users out, too loose defeats the tripwire.
 */
jest.mock("../../src/repositories/refresh-token.repository.js", () => ({
  refreshTokenRepository: {
    findByTokenHash: jest.fn(),
    rotate: jest.fn(async () => ({ id: "new-token-id" })),
    findSuccessor: jest.fn(),
  },
}));
jest.mock("../../src/repositories/session.repository.js", () => ({
  sessionRepository: {
    listActiveSessionIds: jest.fn(async () => [{ id: "session-1" }]),
    revokeAllForUser: jest.fn(async () => undefined),
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
    session: { id: "session-1", revokedAt: null },
    user: {
      id: "user-1",
      status: "ACTIVE",
      deletedAt: null,
      role: "USER",
    },
  };
}

/** The successor row, rotated `secondsAgo` ago and still current. */
function successor(
  secondsAgo: number,
  overrides: Record<string, unknown> = {}
) {
  return {
    id: "new-token-id",
    tokenHash: "hash",
    expiresAt: new Date(Date.now() + 86_400_000),
    revokedAt: null,
    rotatedToId: null,
    createdAt: new Date(Date.now() - secondsAgo * 1000),
    ...overrides,
  };
}

beforeEach(() => {
  repo.findByTokenHash.mockResolvedValue(rotatedToken());
  sessions.listActiveSessionIds.mockResolvedValue([{ id: "session-1" }]);
});

describe("replay inside the grace window", () => {
  it.each(["/api/auth/token", "/api/auth/refresh"])(
    "%s succeeds and does NOT revoke the account's sessions",
    async (path) => {
      // The client had not yet stored the replacement when it retried.
      repo.findSuccessor.mockResolvedValue(successor(5));

      const res = await request(app)
        .post(path)
        .send({ refreshToken: "just-rotated-token" });

      expect(res.status).toBe(200);
      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
      expect(publishAllRevoked).not.toHaveBeenCalled();
    }
  );
});

describe("replay outside the grace window", () => {
  it.each(["/api/auth/token", "/api/auth/refresh"])(
    "%s is treated as theft: 401 and every session revoked",
    async (path) => {
      // Long after the legitimate holder rotated — this is a stolen token.
      repo.findSuccessor.mockResolvedValue(successor(3600));

      const res = await request(app)
        .post(path)
        .send({ refreshToken: "stolen-token" });

      expect(res.status).toBe(401);
      expect(sessions.revokeAllForUser).toHaveBeenCalledWith(
        "user-1",
        "TOKEN_REUSE_DETECTED"
      );
      // Sessions are gone, so the push tokens must go with them.
      expect(publishAllRevoked).toHaveBeenCalledWith({ userId: "user-1" });
    }
  );

  it("revokes when the successor itself has already moved on", async () => {
    // The chain advanced past the successor, so this is not the immediate
    // race — the grace must not apply however recent the timestamp looks.
    repo.findSuccessor.mockResolvedValue(
      successor(1, { rotatedToId: "third-token-id" })
    );

    const res = await request(app)
      .post("/api/auth/token")
      .send({ refreshToken: "stolen-token" });

    expect(res.status).toBe(401);
    expect(sessions.revokeAllForUser).toHaveBeenCalled();
  });

  it("revokes when the successor was revoked", async () => {
    repo.findSuccessor.mockResolvedValue(
      successor(1, { revokedAt: new Date() })
    );

    const res = await request(app)
      .post("/api/auth/token")
      .send({ refreshToken: "stolen-token" });

    expect(res.status).toBe(401);
  });

  it("revokes when the successor row is missing entirely", async () => {
    // Nothing to prove the rotation was recent, so fail closed.
    repo.findSuccessor.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/auth/token")
      .send({ refreshToken: "stolen-token" });

    expect(res.status).toBe(401);
    expect(sessions.revokeAllForUser).toHaveBeenCalled();
  });
});
