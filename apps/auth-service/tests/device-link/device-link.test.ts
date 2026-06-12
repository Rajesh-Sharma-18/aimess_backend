/**
 * Device-link (QR) flow:
 *   POST /api/auth/devices/link/initiate  (no auth) → creates a link session
 *   GET  /api/auth/devices/link/status    (no auth) → polls state + collects tokens
 *   POST /api/auth/devices/link/approve   (auth)    → approver authorizes the device
 * The Redis-backed device-link store + token issuance are mocked; real Zod
 * validation (body + query) runs at the route boundary.
 */
jest.mock("../../src/lib/device-link-store.js", () => ({
  createLinkSession: jest.fn(),
  getLinkSession: jest.fn(),
  consumeTokensAtomic: jest.fn(),
  approveLinkSessionAtomic: jest.fn(),
}));
jest.mock("../../src/lib/token.js", () => ({
  issueAuthTokens: jest.fn(),
  hashToken: jest.fn((v: string) => `hash:${v}`),
}));
// approveDeviceLink looks up the approver's platform role to stamp the new
// device's token; the repo reads Postgres (globally stubbed to `{}`), so mock it.
jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: {
    findRoleByUserId: jest.fn(async () => ({ role: "USER" })),
  },
}));

import request from "supertest";

import app from "../../src/app.js";
import {
  approveLinkSessionAtomic,
  consumeTokensAtomic,
  createLinkSession,
  getLinkSession,
} from "../../src/lib/device-link-store.js";
import { issueAuthTokens } from "../../src/lib/token.js";
import { bearer, makeAccessToken } from "../helpers/auth.js";

const create = createLinkSession as unknown as jest.Mock;
const getSession = getLinkSession as unknown as jest.Mock;
const consume = consumeTokensAtomic as unknown as jest.Mock;
const approve = approveLinkSessionAtomic as unknown as jest.Mock;
const issue = issueAuthTokens as unknown as jest.Mock;

const TOKENS = {
  accessToken: "access.jwt.token",
  refreshToken: "refresh-token-value",
  accessTokenExpiresIn: 3600,
  refreshTokenExpiresIn: 604800,
};

describe("POST /api/auth/devices/link/initiate", () => {
  beforeEach(() => {
    create.mockResolvedValue({
      linkToken: "link-token-123",
      pollSecret: "poll-secret-123",
      expiresAt: new Date("2026-01-01T00:05:00.000Z").toISOString(),
    });
  });

  it("creates a link session → 201 with linkToken + pollSecret", async () => {
    const res = await request(app)
      .post("/api/auth/devices/link/initiate")
      .send({ deviceName: "iPad", deviceType: "IOS" });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.linkToken).toBe("link-token-123");
    expect(res.body.data.pollSecret).toBe("poll-secret-123");
  });

  it("accepts an empty body (all device fields optional) → 201", async () => {
    const res = await request(app)
      .post("/api/auth/devices/link/initiate")
      .send({});

    expect(res.status).toBe(201);
  });

  it("returns 400 when a device field exceeds 100 chars", async () => {
    const res = await request(app)
      .post("/api/auth/devices/link/initiate")
      .send({ deviceName: "a".repeat(101) });

    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("GET /api/auth/devices/link/status", () => {
  it("returns PENDING while waiting for approval", async () => {
    getSession.mockResolvedValue({
      pollSecretHash: "hash:poll-secret-123",
      state: "PENDING",
    });

    const res = await request(app)
      .get("/api/auth/devices/link/status")
      .query({ linkToken: "link-token-123", pollSecret: "poll-secret-123" });

    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe("PENDING");
    expect(res.body.data.tokens).toBeNull();
  });

  it("hands back tokens exactly once when APPROVED", async () => {
    getSession.mockResolvedValue({
      pollSecretHash: "hash:poll-secret-123",
      state: "APPROVED",
    });
    consume.mockResolvedValue({
      state: "APPROVED",
      approvedDeviceLabel: "My iPad",
      tokens: TOKENS,
    });

    const res = await request(app)
      .get("/api/auth/devices/link/status")
      .query({ linkToken: "link-token-123", pollSecret: "poll-secret-123" });

    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe("APPROVED");
    expect(res.body.data.tokens.accessToken).toBe(TOKENS.accessToken);
  });

  it("returns EXPIRED for an unknown session (no enumeration leak)", async () => {
    getSession.mockResolvedValue(null);

    const res = await request(app)
      .get("/api/auth/devices/link/status")
      .query({ linkToken: "ghost", pollSecret: "whatever" });

    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe("EXPIRED");
  });

  it("returns EXPIRED on a wrong pollSecret (looks identical to missing)", async () => {
    getSession.mockResolvedValue({
      pollSecretHash: "hash:correct-secret",
      state: "PENDING",
    });

    const res = await request(app)
      .get("/api/auth/devices/link/status")
      .query({ linkToken: "link-token-123", pollSecret: "guessed-secret" });

    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe("EXPIRED");
    expect(res.body.data.tokens).toBeNull();
  });

  it.each([
    ["missing pollSecret", { linkToken: "link-token-123" }],
    ["missing linkToken", { pollSecret: "poll-secret-123" }],
    ["empty linkToken", { linkToken: "", pollSecret: "poll-secret-123" }],
  ])("returns 400 on query validation failure: %s", async (_label, query) => {
    const res = await request(app)
      .get("/api/auth/devices/link/status")
      .query(query);

    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/devices/link/approve", () => {
  beforeEach(() => {
    getSession.mockResolvedValue({
      device: {
        deviceType: "IOS",
        deviceName: "iPad",
        os: "17",
        appVersion: "1.0.0",
      },
    });
    issue.mockResolvedValue({ tokens: TOKENS, sessionId: "new-sess-1" });
    approve.mockResolvedValue("OK");
  });

  it("approves a pending link → 200 with the new device's sessionId", async () => {
    const res = await request(app)
      .post("/api/auth/devices/link/approve")
      .set(bearer(makeAccessToken()))
      .send({ linkToken: "link-token-123", deviceLabel: "Office iPad" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.sessionId).toBe("new-sess-1");
  });

  it("returns 404 when the link session is unknown", async () => {
    getSession.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/auth/devices/link/approve")
      .set(bearer(makeAccessToken()))
      .send({ linkToken: "ghost-token" });

    expect(res.status).toBe(404);
    expect(issue).not.toHaveBeenCalled();
  });

  it("returns 409 when the link was already approved", async () => {
    approve.mockResolvedValue("ALREADY");

    const res = await request(app)
      .post("/api/auth/devices/link/approve")
      .set(bearer(makeAccessToken()))
      .send({ linkToken: "link-token-123" });

    expect(res.status).toBe(409);
  });

  it("returns 404 when the link vanished during approval", async () => {
    approve.mockResolvedValue("NOT_FOUND");

    const res = await request(app)
      .post("/api/auth/devices/link/approve")
      .set(bearer(makeAccessToken()))
      .send({ linkToken: "link-token-123" });

    expect(res.status).toBe(404);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app)
      .post("/api/auth/devices/link/approve")
      .send({ linkToken: "link-token-123" });

    expect(res.status).toBe(401);
    expect(getSession).not.toHaveBeenCalled();
  });

  it.each([
    ["missing linkToken", {}],
    ["empty linkToken", { linkToken: "" }],
    [
      "deviceLabel too long (>100)",
      { linkToken: "link-token-123", deviceLabel: "a".repeat(101) },
    ],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app)
      .post("/api/auth/devices/link/approve")
      .set(bearer(makeAccessToken()))
      .send(body);

    expect(res.status).toBe(400);
  });
});
