/**
 * Device-link (QR) flow — Telegram-style, scan IS login:
 *   POST /api/auth/devices/link/initiate  (no auth) → creates a link session
 *   POST /api/auth/devices/link/scan      (auth)    → validates the QR, mints a
 *                                                      brand-new web session/tokens,
 *                                                      and marks the QR USED — all
 *                                                      in one call, no approve/reject.
 * The Redis-backed device-link store + token issuance are mocked; real Zod
 * validation (body) runs at the route boundary.
 */
jest.mock("../../src/lib/device-link-store.js", () => ({
  createLinkSession: jest.fn(),
  getLinkSession: jest.fn(),
  claimLinkSessionAtomic: jest.fn(),
  finalizeLoginAtomic: jest.fn(),
}));
jest.mock("../../src/lib/token.js", () => ({
  issueAuthTokens: jest.fn(),
}));
// login() looks up the scanning user's platform role to stamp the new
// device's token; the repo reads Postgres (globally stubbed to `{}`), so mock it.
jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: {
    findRoleByUserId: jest.fn(async () => ({ role: "USER" })),
  },
}));
// Audit persistence is exercised separately (audit.service.test.ts); no-op it
// here so a Postgres-less test run never logs the internal try/catch warning.
jest.mock("../../src/services/audit.service.js", () => ({
  recordAuditEventSafe: jest.fn(),
}));

import request from "supertest";

import app from "../../src/app.js";
import {
  claimLinkSessionAtomic,
  createLinkSession,
  finalizeLoginAtomic,
  getLinkSession,
} from "../../src/lib/device-link-store.js";
import { issueAuthTokens } from "../../src/lib/token.js";
import { recordAuditEventSafe } from "../../src/services/audit.service.js";
import { bearer, makeAccessToken } from "../helpers/auth.js";

const create = createLinkSession as unknown as jest.Mock;
const getSession = getLinkSession as unknown as jest.Mock;
const claim = claimLinkSessionAtomic as unknown as jest.Mock;
const finalize = finalizeLoginAtomic as unknown as jest.Mock;
const issue = issueAuthTokens as unknown as jest.Mock;
const audit = recordAuditEventSafe as unknown as jest.Mock;

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
      expiresAt: new Date("2026-01-01T00:05:00.000Z").toISOString(),
    });
  });

  it("creates a link session → 201 with linkToken + expiresAt", async () => {
    const res = await request(app)
      .post("/api/auth/devices/link/initiate")
      .send({ deviceName: "iPad", deviceType: "IOS" });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.linkToken).toBe("link-token-123");
    expect(res.body.data.expiresAt).toBeTruthy();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "QR_CREATED",
        targetType: "qr_login_session",
        targetId: "link-token-123",
      })
    );
  });

  it("accepts an empty body (all device fields optional) → 201", async () => {
    const res = await request(app)
      .post("/api/auth/devices/link/initiate")
      .send({});

    expect(res.status).toBe(201);
  });

  it("carries the initiating browser's ip/userAgent/countryCode onto the link record", async () => {
    await request(app)
      .post("/api/auth/devices/link/initiate")
      .set("User-Agent", "test-browser-ua")
      .set("CF-IPCountry", "IN")
      .send({});

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        userAgent: "test-browser-ua",
        countryCode: "IN",
        ipAddress: expect.any(String),
      })
    );
  });

  it("ignores body-supplied device fields — buildSessionContext(req) is the only source", async () => {
    // A client bug (or a hostile client) putting its own raw User-Agent string
    // into the `deviceName` body field must never end up as the stored
    // deviceName — only the header-derived value from buildSessionContext may.
    await request(app)
      .post("/api/auth/devices/link/initiate")
      .set(
        "User-Agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0"
      )
      .send({
        deviceName: "Mozilla/5.0 (evil-injected-value)",
        deviceType: "SMART_FRIDGE",
        os: "not-a-real-os",
        appVersion: "9.9.9-body-value",
      });

    const call = create.mock.calls[0][0];
    expect(call.deviceName).not.toBe("Mozilla/5.0 (evil-injected-value)");
    expect(call.appVersion).not.toBe("9.9.9-body-value");
  });

  it("returns 400 when a device field exceeds 100 chars", async () => {
    const res = await request(app)
      .post("/api/auth/devices/link/initiate")
      .send({ deviceName: "a".repeat(101) });

    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/devices/link/scan (instant login)", () => {
  beforeEach(() => {
    getSession.mockResolvedValue({
      device: {
        deviceType: "IOS",
        deviceName: "iPad",
        os: "17",
        appVersion: "1.0.0",
        ipAddress: "203.0.113.9",
        userAgent: "browser-ua-at-initiate",
        countryCode: "IN",
      },
    });
    claim.mockResolvedValue("OK");
    issue.mockResolvedValue({ tokens: TOKENS, sessionId: "new-sess-1" });
    finalize.mockResolvedValue("OK");
  });

  it("logs in instantly on scan → 200 with tokens + the new device's sessionId", async () => {
    const res = await request(app)
      .post("/api/auth/devices/link/scan")
      .set(bearer(makeAccessToken()))
      .send({ linkToken: "link-token-123", deviceLabel: "Office iPad" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.sessionId).toBe("new-sess-1");
    expect(res.body.data.accessToken).toBe(TOKENS.accessToken);
    expect(res.body.data.refreshToken).toBe(TOKENS.refreshToken);
    expect(claim).toHaveBeenCalledWith("link-token-123", expect.any(String));
    expect(finalize).toHaveBeenCalledWith("link-token-123", expect.any(String));
    // The new session's network info comes from the QR record (captured at
    // initiate(), from the browser being linked) — never from this scan
    // request, which belongs to a different device (the phone scanning it).
    expect(issue).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        ipAddress: "203.0.113.9",
        userAgent: "browser-ua-at-initiate",
        countryCode: "IN",
      })
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "QR_LOGIN_ATTEMPT",
        targetId: "link-token-123",
      })
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "QR_LOGIN_SUCCESS",
        targetId: "link-token-123",
      })
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "BROWSER_LOGGED_IN",
        targetId: "link-token-123",
      })
    );
  });

  it("ignores the scanning device's own appVersion body field for the new session", async () => {
    // input.appVersion here belongs to the scanning PHONE, not the browser
    // being linked — the new session's appVersion must come only from
    // record.device.appVersion (captured from the browser at initiate()).
    await request(app)
      .post("/api/auth/devices/link/scan")
      .set(bearer(makeAccessToken()))
      .send({
        linkToken: "link-token-123",
        appVersion: "phone-app-version-9.9.9",
      });

    expect(issue).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ appVersion: "1.0.0" })
    );
  });

  it("returns 404 when the link session is unknown", async () => {
    getSession.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/auth/devices/link/scan")
      .set(bearer(makeAccessToken()))
      .send({ linkToken: "ghost-token" });

    expect(res.status).toBe(404);
    expect(claim).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it("returns 409 (already used/claimed) on a reused QR and logs QR_REUSED_ATTEMPT", async () => {
    claim.mockResolvedValue("ALREADY");

    const res = await request(app)
      .post("/api/auth/devices/link/scan")
      .set(bearer(makeAccessToken()))
      .send({ linkToken: "link-token-123" });

    expect(res.status).toBe(409);
    expect(issue).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "QR_REUSED_ATTEMPT",
        targetId: "link-token-123",
      })
    );
  });

  it("returns 404 when the QR expired before it could be claimed", async () => {
    claim.mockResolvedValue("EXPIRED");

    const res = await request(app)
      .post("/api/auth/devices/link/scan")
      .set(bearer(makeAccessToken()))
      .send({ linkToken: "link-token-123" });

    expect(res.status).toBe(404);
    expect(issue).not.toHaveBeenCalled();
  });

  it("returns 404 when the QR expires between claim and finalize", async () => {
    finalize.mockResolvedValue("EXPIRED");

    const res = await request(app)
      .post("/api/auth/devices/link/scan")
      .set(bearer(makeAccessToken()))
      .send({ linkToken: "link-token-123" });

    expect(res.status).toBe(404);
    expect(issue).toHaveBeenCalled();
  });

  it("returns 401 without a token", async () => {
    const res = await request(app)
      .post("/api/auth/devices/link/scan")
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
      .post("/api/auth/devices/link/scan")
      .set(bearer(makeAccessToken()))
      .send(body);

    expect(res.status).toBe(400);
  });
});
