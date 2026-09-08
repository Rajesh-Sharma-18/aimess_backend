/**
 * Rate limiting on the QR login endpoints (spec: 5/min/IP generation,
 * 10/min/user scan). A dedicated file so its own request budget never shares
 * state with device-link.test.ts's app instance (Jest gives each test file a
 * fresh module registry, so this app's rate limiters start unconsumed).
 */
jest.mock("../../src/lib/device-link-store.js", () => ({
  createLinkSession: jest.fn(async () => ({
    linkToken: "11111111-1111-4111-8111-111111111111",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    cancelledToken: null,
  })),
  getLinkSession: jest.fn(async () => ({
    device: {
      deviceType: "WEB",
      deviceName: "Chrome",
      os: null,
      appVersion: null,
    },
  })),
  claimLinkSessionAtomic: jest.fn(async () => "OK"),
  finalizeLoginAtomic: jest.fn(async () => "OK"),
}));
jest.mock("../../src/lib/token.js", () => ({
  issueAuthTokens: jest.fn(async () => ({
    tokens: {
      accessToken: "access.jwt.token",
      refreshToken: "refresh-token-value",
      accessTokenExpiresIn: 3600,
      refreshTokenExpiresIn: 604800,
    },
    sessionId: "new-sess-1",
  })),
}));
jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: {
    findRoleByUserId: jest.fn(async () => ({ role: "USER" })),
  },
}));
jest.mock("../../src/services/audit.service.js", () => ({
  recordAuditEventSafe: jest.fn(),
}));

import request from "supertest";

import app from "../../src/app.js";
import { bearer, makeAccessToken } from "../helpers/auth.js";

describe("QR login rate limiting", () => {
  it("does not rate limit QR generation requests (allows repeated generation)", async () => {
    let lastStatus = 0;
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post("/api/auth/devices/link/initiate")
        .send({});
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(201);
  });

  /**
   * The bug this pins: `/devices/link/result` is POLLED — every 2s for the
   * 60-second life of a QR, which is 30 requests for one QR alone — and it was
   * mounted on the 5/minute limiter named for QR GENERATION. The QR started
   * answering 429 about ten seconds after it appeared.
   */
  it("lets the browser poll a QR's result far past the generation budget", async () => {
    let lastStatus = 0;
    // Comfortably more than `QR_GENERATION_RATE_LIMIT_MAX` (5) — this is the
    // shape of one ordinary QR being waited on, not abuse.
    for (let i = 0; i < 30; i++) {
      const res = await request(app)
        .post("/api/auth/devices/link/result")
        .send({ linkToken: "11111111-1111-4111-8111-111111111111" });
      lastStatus = res.status;
    }
    expect(lastStatus).not.toBe(429);
  });

  it("caps QR scan at 10 requests/minute/user → 429 on the 11th", async () => {
    const token = bearer(makeAccessToken());
    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const res = await request(app)
        .post("/api/auth/devices/link/scan")
        .set(token)
        .send({ linkToken: "11111111-1111-4111-8111-111111111111" });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
