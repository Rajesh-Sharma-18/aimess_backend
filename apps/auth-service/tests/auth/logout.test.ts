/**
 * POST /api/auth/logout — an authenticated route. Proves the JWT auth seam:
 * a valid minted token passes, while missing / malformed / expired / forged
 * tokens are all rejected with 401 (real jsonwebtoken verification).
 */
jest.mock("../../src/services/session.service.js", () => ({
  sessionService: {
    logout: jest.fn(async () => undefined),
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

const svc = sessionService as unknown as { logout: jest.Mock };

describe("POST /api/auth/logout (auth required)", () => {
  it("returns 200 and revokes the session with a valid token", async () => {
    const res = await request(app)
      .post("/api/auth/logout")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(svc.logout).toHaveBeenCalledTimes(1);
  });

  it("returns 401 with no Authorization header", async () => {
    const res = await request(app).post("/api/auth/logout");
    expect(res.status).toBe(401);
    expect(svc.logout).not.toHaveBeenCalled();
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
