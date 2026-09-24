/**
 * The full sign-out chain for the case that used to fail silently: a client
 * whose ACCESS token has already expired.
 *
 * HTTP -> optional-auth guard -> controller -> the real session.service, with
 * only the repositories mocked. What it proves is the end of the chain the bug
 * never reached: the session row is revoked as USER_SIGNED_OUT, which is what
 * drops it out of `listActiveByUserId` and off the Connected Devices list.
 *
 * Before the fix the expired Bearer was rejected by the guard with a 401, so
 * the refresh-token fallback never ran and the session outlived its own
 * sign-out - one stale row per login/logout cycle.
 */
jest.mock("../../src/repositories/refresh-token.repository.js", () => ({
  refreshTokenRepository: {
    findByTokenHash: jest.fn(),
  },
}));
jest.mock("../../src/repositories/session.repository.js", () => ({
  sessionRepository: {
    getDeviceId: jest.fn(async () => "device-1"),
    revokeForUser: jest.fn(async () => ({ revoked: true })),
  },
}));

import request from "supertest";

import app from "../../src/app.js";
import { refreshTokenRepository } from "../../src/repositories/refresh-token.repository.js";
import { sessionRepository } from "../../src/repositories/session.repository.js";
import { bearer, makeExpiredAccessToken, TEST_SESSION_ID } from "../helpers/auth.js";

const tokens = refreshTokenRepository as unknown as Record<string, jest.Mock>;
const sessions = sessionRepository as unknown as Record<string, jest.Mock>;

beforeEach(() => {
  jest.clearAllMocks();
  sessions.getDeviceId.mockResolvedValue("device-1");
  sessions.revokeForUser.mockResolvedValue({ revoked: true });
  tokens.findByTokenHash.mockResolvedValue({
    userId: "user-1",
    sessionId: TEST_SESSION_ID,
    session: { revokedAt: null },
  });
});

describe("POST /api/auth/logout with an expired access token", () => {
  it("revokes the session named by the refresh token in the body", async () => {
    const res = await request(app)
      .post("/api/auth/logout")
      .set(bearer(makeExpiredAccessToken()))
      .send({ refreshToken: "live-refresh-token" });

    expect(res.status).toBe(200);
    expect(sessions.revokeForUser).toHaveBeenCalledWith(
      "user-1",
      TEST_SESSION_ID,
      "USER_SIGNED_OUT"
    );
  });

  it("revokes the session named by the refresh cookie", async () => {
    const res = await request(app)
      .post("/api/auth/logout")
      .set(bearer(makeExpiredAccessToken()))
      .set("Cookie", "aimess_rt=live-refresh-token");

    expect(res.status).toBe(200);
    expect(sessions.revokeForUser).toHaveBeenCalledWith(
      "user-1",
      TEST_SESSION_ID,
      "USER_SIGNED_OUT"
    );
  });

  // Sign-out must end ONE session. Nothing here may touch the account's other
  // devices - that is what "Sign out from all other devices" is for.
  it("revokes nothing else", async () => {
    await request(app)
      .post("/api/auth/logout")
      .set(bearer(makeExpiredAccessToken()))
      .send({ refreshToken: "live-refresh-token" });

    expect(sessions.revokeForUser).toHaveBeenCalledTimes(1);
    expect(sessions.revokeForUser.mock.calls[0][1]).toBe(TEST_SESSION_ID);
  });

  // An already-revoked session is a no-op, not a second revoke: the same tab
  // can post logout twice (reconnect echo, double click).
  it("is idempotent for a session that is already revoked", async () => {
    tokens.findByTokenHash.mockResolvedValue({
      userId: "user-1",
      sessionId: TEST_SESSION_ID,
      session: { revokedAt: new Date() },
    });

    const res = await request(app)
      .post("/api/auth/logout")
      .set(bearer(makeExpiredAccessToken()))
      .send({ refreshToken: "live-refresh-token" });

    expect(res.status).toBe(200);
    expect(sessions.revokeForUser).not.toHaveBeenCalled();
  });
});
