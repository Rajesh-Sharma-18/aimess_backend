/**
 * POST /api/auth/logout — optionally authenticated. A valid minted token
 * revokes the session it names (real jsonwebtoken verification). A token the
 * service cannot use — missing, malformed, expired or forged — never fails the
 * request: the refresh cookie is httpOnly and the browser cannot clear it, so
 * sign-out must not require a live access token. The request falls through
 * unauthenticated and the refresh token (cookie or body) names the session to
 * revoke; with neither credential it is a 200 no-op.
 *
 * The expired case is the one that mattered: it used to 401, so every sign-out
 * from a tab that had sat idle past the access-token TTL revoked nothing and
 * left the session listed under Connected Devices.
 */
jest.mock("../../src/services/session.service.js", () => ({
  sessionService: {
    logout: jest.fn(async () => undefined),
    logoutByRefreshToken: jest.fn(async () => undefined),
  },
}));

import request from "supertest";

import app from "../../src/app.js";
import { sessionService } from "../../src/services/session.service.js";
import {
  bearer,
  makeAccessToken,
  makeExpiredAccessToken,
  makeForgedAccessToken,
} from "../helpers/auth.js";

const svc = sessionService as unknown as {
  logout: jest.Mock;
  logoutByRefreshToken: jest.Mock;
};

describe("POST /api/auth/logout (auth optional)", () => {
  beforeEach(() => {
    svc.logout.mockClear();
    svc.logoutByRefreshToken.mockClear();
  });

  it("returns 200 and revokes the session with a valid token", async () => {
    const res = await request(app)
      .post("/api/auth/logout")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(svc.logout).toHaveBeenCalledTimes(1);
  });

  // AIM-02: the refresh token is an httpOnly cookie the browser cannot delete,
  // so logout can no longer require a live access token - a user whose token
  // expired would otherwise be unable to end the session at all. With neither
  // credential there is nothing to revoke, and the response is a 200 no-op that
  // still sends the cookie-clearing header.
  it("with no Authorization header and no cookie → 200 no-op", async () => {
    const res = await request(app).post("/api/auth/logout");
    expect(res.status).toBe(200);
    expect(svc.logout).not.toHaveBeenCalled();
    expect(String(res.headers["set-cookie"])).toMatch(/aimess_rt=;/);
  });

  it("falls back to the refresh cookie when the access token is gone", async () => {
    const res = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", "aimess_rt=some-refresh-token");

    expect(res.status).toBe(200);
    expect(svc.logoutByRefreshToken).toHaveBeenCalledWith("some-refresh-token");
  });

  it("falls back to the refresh token in the body when there is no cookie", async () => {
    const res = await request(app)
      .post("/api/auth/logout")
      .send({ refreshToken: "body-refresh-token" });

    expect(res.status).toBe(200);
    expect(svc.logoutByRefreshToken).toHaveBeenCalledWith("body-refresh-token");
  });

  // The regression this guard exists for: an idle tab still sends its expired
  // token, and rejecting it here skipped the refresh-token fallback entirely —
  // the session survived its own sign-out.
  it("revokes via the refresh token when the access token has EXPIRED", async () => {
    const res = await request(app)
      .post("/api/auth/logout")
      .set(bearer(makeExpiredAccessToken()))
      .send({ refreshToken: "body-refresh-token" });

    expect(res.status).toBe(200);
    expect(svc.logout).not.toHaveBeenCalled();
    expect(svc.logoutByRefreshToken).toHaveBeenCalledWith("body-refresh-token");
  });

  it("revokes via the refresh cookie when the access token has EXPIRED", async () => {
    const res = await request(app)
      .post("/api/auth/logout")
      .set(bearer(makeExpiredAccessToken()))
      .set("Cookie", "aimess_rt=cookie-refresh-token");

    expect(res.status).toBe(200);
    expect(svc.logoutByRefreshToken).toHaveBeenCalledWith(
      "cookie-refresh-token"
    );
  });

  it("a malformed Authorization header is a 200 no-op, not a 401", async () => {
    const res = await request(app)
      .post("/api/auth/logout")
      .set({ Authorization: "Token abc.def" });

    expect(res.status).toBe(200);
    expect(svc.logout).not.toHaveBeenCalled();
  });

  // Unusable token + no refresh token = nothing is proven, so nothing is
  // revoked. Falling through must never revoke a session on the token's word.
  it("a forged (wrong-secret) token revokes nothing", async () => {
    const res = await request(app)
      .post("/api/auth/logout")
      .set(bearer(makeForgedAccessToken()));

    expect(res.status).toBe(200);
    expect(svc.logout).not.toHaveBeenCalled();
    expect(svc.logoutByRefreshToken).not.toHaveBeenCalled();
  });
});
