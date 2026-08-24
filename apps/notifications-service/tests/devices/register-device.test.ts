/**
 * POST /v1/devices — register (upsert) the caller's FCM device token.
 *
 * The route runs for real: shared `createAuthenticateAccessToken` JWT middleware
 * → `registerDevice` controller → Zod body validation → `deviceTokenService` →
 * `deviceTokenRepository`. Only the repository (the Prisma I/O boundary) is
 * mocked, so routing, auth, validation and the service layer all execute.
 *
 * Controller contract (verified in src/api/controllers/device.controller.ts):
 *   - success → 200 { success: true }
 *   - zod failure → 400 { success: false, message }
 *   - repo throw → 500 { success: false, message: "Failed to register device" }
 *   - auth failure → 401 { success: false, message } (UnauthorizedError → 401)
 *
 * Body schema (src/api/validators/device.validator.ts):
 *   token: string min 1 max 4096; platform: enum ANDROID|IOS|WEB;
 *   deviceId?: string min 1 max 256.
 */
jest.mock("../../src/repositories/device-token.repository.js", () => ({
  deviceTokenRepository: {
    upsert: jest.fn(),
    findTokensByUserId: jest.fn(),
    deleteByToken: jest.fn(),
    deleteByUserAndToken: jest.fn(),
  },
}));

import request from "supertest";

import { app } from "../../src/app.js";
import { deviceTokenRepository } from "../../src/repositories/device-token.repository.js";
import {
  makeAccessToken,
  makeExpiredAccessToken,
  makeForgedAccessToken,
  bearer,
  TEST_USER_ID,
  TEST_SESSION_ID,
} from "../helpers/auth.js";

const repo = deviceTokenRepository as unknown as Record<string, jest.Mock>;

const validBody = {
  token: "fcm-token-abc123",
  platform: "ANDROID" as const,
  deviceId: "device-001",
};

describe("POST /v1/devices", () => {
  beforeEach(() => {
    repo.upsert.mockResolvedValue(undefined);
  });

  // --- POSITIVE -------------------------------------------------------------
  it("registers a device → 200 and upserts scoped to the caller", async () => {
    const res = await request(app)
      .post("/v1/devices")
      .set(bearer(makeAccessToken()))
      .send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: "Device registered",
      data: null,
    });
    expect(repo.upsert).toHaveBeenCalledTimes(1);
    expect(repo.upsert).toHaveBeenCalledWith({
      userId: TEST_USER_ID,
      token: validBody.token,
      platform: "ANDROID",
      tokenType: "FCM",
      deviceId: "device-001",
      sessionId: TEST_SESSION_ID,
      locale: null,
    });
  });

  // --- POSITIVE: per-device push language -----------------------------------
  //
  // `locale` is what lets one account signed in on five devices receive five
  // pushes in three languages. It is device-scoped precisely because
  // AppSettings.language is a single account-wide column.
  it.each([
    ["th", "th"],
    ["th-TH", "th"],
    ["EN_us", "en"],
    ["  vi  ", "vi"],
  ])("stores lang %s as %s", async (lang, expected) => {
    const res = await request(app)
      .post("/v1/devices")
      .set(bearer(makeAccessToken()))
      .send({ ...validBody, lang });

    expect(res.status).toBe(200);
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ locale: expected })
    );
  });

  // An unsupported tag must NOT fail the registration (that would leave the
  // device with no push at all) and must NOT be normalized to DEFAULT_LOCALE,
  // which is "vi" in production — answering a French request in Vietnamese is
  // the exact failure this rule exists to prevent. Null = "no opinion", and the
  // send path falls back to the account language.
  it.each(["fr", "hi", "zz-ZZ", "!!"])(
    "ignores unsupported lang %s without failing the registration",
    async (lang) => {
      const res = await request(app)
        .post("/v1/devices")
        .set(bearer(makeAccessToken()))
        .send({ ...validBody, lang });

      expect(res.status).toBe(200);
      expect(repo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ locale: null })
      );
    }
  );

  // The column means "what the client that currently owns this token last
  // said". An older build re-registering must clear it rather than leave a
  // stale value behind — `token` is @unique, so re-registration is also how a
  // token moves between ACCOUNTS, and a sticky locale would leak the previous
  // owner's language.
  it("clears the stored locale when a client re-registers without lang", async () => {
    const res = await request(app)
      .post("/v1/devices")
      .set(bearer(makeAccessToken()))
      .send(validBody);

    expect(res.status).toBe(200);
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ locale: null })
    );
  });

  it("stamps the JWT's sessionId, ignoring any sessionId in the body", async () => {
    const res = await request(app)
      .post("/v1/devices")
      .set(bearer(makeAccessToken({ sessionId: "session-from-jwt" })))
      .send({ ...validBody, sessionId: "attacker-session" });

    expect(res.status).toBe(200);
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-from-jwt" })
    );
  });

  it("defaults deviceId to null when omitted", async () => {
    const res = await request(app)
      .post("/v1/devices")
      .set(bearer(makeAccessToken()))
      .send({ token: "fcm-token-xyz", platform: "IOS" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: null, platform: "IOS" })
    );
  });

  it.each(["ANDROID", "IOS", "WEB"])(
    "accepts platform enum value %s",
    async (platform) => {
      const res = await request(app)
        .post("/v1/devices")
        .set(bearer(makeAccessToken()))
        .send({ token: "tok", platform });

      expect(res.status).toBe(200);
      expect(repo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ platform })
      );
    }
  );

  // --- NEGATIVE: validation (400) -------------------------------------------
  it.each([
    ["empty body", {}],
    ["missing token", { platform: "ANDROID" }],
    ["missing platform", { token: "tok" }],
    ["empty token string", { token: "", platform: "ANDROID" }],
    ["token wrong type (number)", { token: 12345, platform: "ANDROID" }],
    ["token wrong type (null)", { token: null, platform: "ANDROID" }],
    ["platform not in enum", { token: "tok", platform: "DESKTOP" }],
    ["platform wrong case", { token: "tok", platform: "android" }],
    ["platform wrong type", { token: "tok", platform: 1 }],
    ["deviceId empty string", { token: "tok", platform: "WEB", deviceId: "" }],
    ["deviceId wrong type", { token: "tok", platform: "WEB", deviceId: 99 }],
    [
      "token exceeds max 4096",
      { token: "x".repeat(4097), platform: "ANDROID" },
    ],
    [
      "deviceId exceeds max 256",
      { token: "tok", platform: "ANDROID", deviceId: "d".repeat(257) },
    ],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app)
      .post("/v1/devices")
      .set(bearer(makeAccessToken()))
      .send(body as Record<string, unknown>);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.message).toBe("string");
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  // --- NEGATIVE: auth (401) -------------------------------------------------
  it("returns 401 when no Authorization header is sent", async () => {
    const res = await request(app).post("/v1/devices").send(validBody);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it("returns 401 for a malformed Authorization header (no Bearer)", async () => {
    const res = await request(app)
      .post("/v1/devices")
      .set({ Authorization: makeAccessToken() })
      .send(validBody);

    expect(res.status).toBe(401);
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it("returns 401 for an expired access token", async () => {
    const res = await request(app)
      .post("/v1/devices")
      .set(bearer(makeExpiredAccessToken()))
      .send(validBody);

    expect(res.status).toBe(401);
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it("returns 401 for a forged token (wrong signing secret)", async () => {
    const res = await request(app)
      .post("/v1/devices")
      .set(bearer(makeForgedAccessToken()))
      .send(validBody);

    expect(res.status).toBe(401);
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it("returns 401 for a structurally broken bearer token", async () => {
    const res = await request(app)
      .post("/v1/devices")
      .set(bearer("not-a-real-jwt"))
      .send(validBody);

    expect(res.status).toBe(401);
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  // --- NEGATIVE: downstream failure (500) -----------------------------------
  it("returns 500 when the repository throws", async () => {
    repo.upsert.mockRejectedValue(new Error("mongo down"));

    const res = await request(app)
      .post("/v1/devices")
      .set(bearer(makeAccessToken()))
      .send(validBody);

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    // The handler no longer writes its own body: an unhandled repository
    // failure now answers through the shared envelope, which never echoes the
    // caught error and always carries a machine-readable code.
    expect(res.body.code).toBe("INTERNAL_SERVER_ERROR");
    expect(res.body.error.retryable).toBe(true);
  });

  // --- EDGE -----------------------------------------------------------------
  it("accepts a token at the max length boundary (4096)", async () => {
    const res = await request(app)
      .post("/v1/devices")
      .set(bearer(makeAccessToken()))
      .send({ token: "t".repeat(4096), platform: "ANDROID" });

    expect(res.status).toBe(200);
    expect(repo.upsert).toHaveBeenCalledTimes(1);
  });

  it("accepts a deviceId at the max length boundary (256)", async () => {
    const res = await request(app)
      .post("/v1/devices")
      .set(bearer(makeAccessToken()))
      .send({ token: "tok", platform: "WEB", deviceId: "d".repeat(256) });

    expect(res.status).toBe(200);
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: "d".repeat(256) })
    );
  });

  it("accepts a unicode/emoji deviceId", async () => {
    const res = await request(app)
      .post("/v1/devices")
      .set(bearer(makeAccessToken()))
      .send({ token: "tok", platform: "IOS", deviceId: "iPhone-📱-Олег" });

    expect(res.status).toBe(200);
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: "iPhone-📱-Олег" })
    );
  });

  // --- SECURITY -------------------------------------------------------------
  it("derives userId from the JWT, ignoring any userId in the body (mass-assignment guard)", async () => {
    const res = await request(app)
      .post("/v1/devices")
      .set(bearer(makeAccessToken()))
      .send({
        ...validBody,
        userId: "victim-user-id",
        id: "forced-id",
        role: "ADMIN",
      });

    expect(res.status).toBe(200);
    // The persisted userId must be the token subject, never the body value.
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TEST_USER_ID })
    );
    const call = repo.upsert.mock.calls[0][0] as Record<string, unknown>;
    expect(call.userId).not.toBe("victim-user-id");
    // Unknown body keys are stripped by the schema and never forwarded.
    expect(call).not.toHaveProperty("role");
    expect(call).not.toHaveProperty("id");
  });

  it("scopes the upsert to the authenticated caller (a second user cannot impersonate)", async () => {
    const otherUserId = "99999999-9999-4999-8999-999999999999";
    const res = await request(app)
      .post("/v1/devices")
      .set(bearer(makeAccessToken({ userId: otherUserId })))
      .send(validBody);

    expect(res.status).toBe(200);
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ userId: otherUserId })
    );
  });

  it("safely handles an injection-shaped token string (treated as opaque data, not executed)", async () => {
    const evil = '{"$ne": null}';
    const res = await request(app)
      .post("/v1/devices")
      .set(bearer(makeAccessToken()))
      .send({ token: evil, platform: "ANDROID" });

    expect(res.status).toBe(200);
    // Passed through verbatim as a plain string — no operator interpretation.
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ token: evil })
    );
  });
});
