/**
 * POST /api/auth/logout — an authenticated route. Proves the JWT auth seam:
 * a valid minted token passes, while missing / malformed / expired / forged
 * tokens are all rejected with 401 (real jsonwebtoken verification). Since
 * AIM-02 a request with NO Authorization header is allowed through instead:
 * the refresh cookie is httpOnly, so an expired access token must not leave the
 * user unable to sign out.
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

describe("POST /api/auth/logout (auth required)", () => {
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

  it("returns 401 for a malformed Authorization header", async () => {
    const res = await request(app)
      .post("/api/auth/logout")
      .set({ Authorization: "Token abc.def" });
    expect(res.status).toBe(401);
  });

  it("returns 401 for an expired token", async () => {
    const res = await request(app)
      .post("/api/auth/logout")
      .set(bearer(makeExpiredAccessToken()));
    expect(res.status).toBe(401);
    expect(svc.logout).not.toHaveBeenCalled();
  });

  it("returns 401 for a forged (wrong-secret) token", async () => {
    const res = await request(app)
      .post("/api/auth/logout")
      .set(bearer(makeForgedAccessToken()));
    expect(res.status).toBe(401);
    expect(svc.logout).not.toHaveBeenCalled();
  });
});
