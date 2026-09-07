/**
 * The `device` payload end to end over HTTP, on all three endpoints the mobile
 * contract names: login, register and Google.
 *
 * The failure this exists to prevent is the expensive one: a shipped client
 * that sends no `device` object — every Android, iOS and web build older than
 * this change — being rejected at validation and unable to sign in. Every
 * "without device" case below is that regression test.
 *
 * The rest assert that a payload actually reaches the session funnel with the
 * client's own device id, so the device row, the push token and the session all
 * key on one identity instead of the server's userAgent|ip fingerprint.
 */
jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: {
    findByAccount: jest.fn(),
    findByAccountForLogin: jest.fn(),
    findByEmailForLogin: jest.fn(),
    findByEmail: jest.fn(),
    createUser: jest.fn(),
    recordSuccessfulLogin: jest.fn(),
    recordFailedLogin: jest.fn(),
    mergeFcmTokens: jest.fn(),
    getProfileCompleted: jest.fn(),
  },
}));
jest.mock("../../src/repositories/linked-account.repository.js", () => ({
  linkedAccountRepository: { findByProvider: jest.fn(), create: jest.fn() },
}));
jest.mock("../../src/lib/google-id-token.js", () => ({
  verifyGoogleIdToken: jest.fn(),
}));
jest.mock("../../src/lib/token.js", () => ({ issueAuthTokens: jest.fn() }));
jest.mock("../../src/messaging/publish-user-created.js", () => ({
  publishUserCreatedSafe: jest.fn(),
}));

import request from "supertest";
import bcrypt from "bcryptjs";

import app from "../../src/app.js";
import { verifyGoogleIdToken } from "../../src/lib/google-id-token.js";
import { issueAuthTokens } from "../../src/lib/token.js";
import { authRepository } from "../../src/repositories/auth.repository.js";
import { linkedAccountRepository } from "../../src/repositories/linked-account.repository.js";
import { signupProof } from "../helpers/solve-signup-challenge.js";

const repo = authRepository as unknown as Record<string, jest.Mock>;
const linkedRepo = linkedAccountRepository as unknown as Record<
  string,
  jest.Mock
>;
const issue = issueAuthTokens as unknown as jest.Mock;
const verifyGoogle = verifyGoogleIdToken as unknown as jest.Mock;

const PASSWORD = "Correct-Horse-Battery-7";
let passwordHash: string;

const TOKENS = {
  accessToken: "access.jwt.token",
  refreshToken: "refresh-token-value",
  accessTokenExpiresIn: 3600,
  refreshTokenExpiresIn: 604800,
};

/** The payload the web client sends: WEB platform, DESKTOP form factor, nulls. */
const WEB_DEVICE = {
  deviceId: "3F2A1B4C-5D6E-4F70-8A9B-0C1D2E3F4A5B",
  platform: "WEB",
  deviceType: "DESKTOP",
  deviceName: "Chrome on Windows",
  manufacturer: null,
  brand: null,
  model: null,
  osVersion: "10",
  sdkInt: null,
  appVersion: "0.1.0",
  appBuild: null,
  buildType: "release",
  installerPackage: null,
  locale: "en-IN",
  language: "en",
  country: "IN",
  timezone: "Asia/Kolkata",
  utcOffsetMinutes: 330,
  screenWidthPx: 1920,
  screenHeightPx: 1080,
  screenDensityDpi: 160,
  networkType: "UNKNOWN",
  carrier: null,
  isEmulator: null,
  isRooted: null,
};

/** The Android payload, verbatim from the mobile contract. */
const ANDROID_DEVICE = {
  deviceId: "9774d56d682e549c",
  platform: "ANDROID",
  deviceType: "PHONE",
  deviceName: "samsung SM-S911B",
  manufacturer: "samsung",
  brand: "samsung",
  model: "SM-S911B",
  osVersion: "14",
  sdkInt: 34,
  appVersion: "1.4.2",
  appBuild: 142,
  buildType: "release",
  installerPackage: "com.android.vending",
  locale: "en-IN",
  language: "en",
  country: "IN",
  timezone: "Asia/Kolkata",
  utcOffsetMinutes: 330,
  screenWidthPx: 1080,
  screenHeightPx: 2340,
  screenDensityDpi: 420,
  networkType: "WIFI",
  carrier: "Jio",
  isEmulator: false,
  isRooted: false,
};

/** The SessionContext `issueAuthTokens` was handed on the most recent call. */
const capturedSession = () => issue.mock.calls.at(-1)?.[2];

beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
});

beforeEach(() => {
  repo.findByAccountForLogin.mockResolvedValue({
    id: "user-1",
    account: "johndoe",
    passwordHash,
    deletedAt: null,
    emailVerified: true,
    lockedUntil: null,
    status: "ACTIVE",
    isProfileCompleted: true,
    role: "USER",
  });
  repo.recordSuccessfulLogin.mockResolvedValue(undefined);
  repo.recordFailedLogin.mockResolvedValue(undefined);
  repo.mergeFcmTokens.mockResolvedValue(undefined);
  repo.getProfileCompleted.mockResolvedValue(true);
  issue.mockResolvedValue({ tokens: TOKENS, sessionId: "sess-1" });
});

describe("POST /api/auth/login — device payload", () => {
  it("accepts the web payload and keys the session on the client device id", async () => {
    await request(app)
      .post("/api/auth/login")
      .send({ account: "johndoe", password: PASSWORD, device: WEB_DEVICE })
      .expect(200);

    const session = capturedSession();
    expect(session.deviceId).toBe(WEB_DEVICE.deviceId);
    expect(session.device).toMatchObject({
      platform: "WEB",
      deviceName: "Chrome on Windows",
      appVersion: "0.1.0",
    });
  });

  // A desktop browser reports platform WEB; the session bucket must stay
  // DESKTOP or the admin panel's device-targeted announcements lose it.
  it("puts a DESKTOP form factor in the DESKTOP session bucket", async () => {
    await request(app)
      .post("/api/auth/login")
      .send({ account: "johndoe", password: PASSWORD, device: WEB_DEVICE })
      .expect(200);

    expect(capturedSession().deviceType).toBe("DESKTOP");
  });

  it("accepts the Android payload unchanged", async () => {
    await request(app)
      .post("/api/auth/login")
      .send({ account: "johndoe", password: PASSWORD, device: ANDROID_DEVICE })
      .expect(200);

    const session = capturedSession();
    expect(session.deviceId).toBe(ANDROID_DEVICE.deviceId);
    expect(session.deviceType).toBe("ANDROID");
    expect(session.device.sdkInt).toBe(34);
  });

  // The regression that would lock out every shipped client.
  it("logs in with NO device object at all", async () => {
    await request(app)
      .post("/api/auth/login")
      .send({ account: "johndoe", password: PASSWORD })
      .expect(200);

    const session = capturedSession();
    expect(session.device).toBeNull();
    // Falls back to the server-derived fingerprint, exactly as before.
    expect(session.deviceId).toEqual(expect.any(String));
  });

  it("logs in with an explicit device: null", async () => {
    await request(app)
      .post("/api/auth/login")
      .send({ account: "johndoe", password: PASSWORD, device: null })
      .expect(200);

    expect(capturedSession().device).toBeNull();
  });

  it("400s an unknown platform instead of storing it", async () => {
    await request(app)
      .post("/api/auth/login")
      .send({
        account: "johndoe",
        password: PASSWORD,
        device: { ...WEB_DEVICE, platform: "SMARTFRIDGE" },
      })
      .expect(400);
  });

  // The client is not the authority on where the request came from.
  it("ignores a client-supplied ipAddress", async () => {
    await request(app)
      .post("/api/auth/login")
      .send({
        account: "johndoe",
        password: PASSWORD,
        device: { ...WEB_DEVICE, ipAddress: "10.0.0.1" },
      })
      .expect(200);

    expect(capturedSession().device.ipAddress).toBeUndefined();
    expect(capturedSession().ipAddress).not.toBe("10.0.0.1");
  });
});

describe("POST /api/auth/register — device payload", () => {
  beforeEach(() => {
    repo.findByAccount.mockResolvedValue(null);
    repo.createUser.mockResolvedValue({
      id: "user-new",
      account: "brandnew",
      role: "USER",
      createdAt: new Date("2026-09-03T00:00:00.000Z"),
    });
  });

  // A real, solved proof of work, minted fresh per call: the gate claims a
  // challenge id single-use, so reusing one object across two registrations
  // fails the SECOND one with AUTH_CHALLENGE_INVALID.

  it("carries the device payload into the new session", async () => {
    await request(app)
      .post("/api/auth/register")
      .send({
        account: "brandnew",
        password: PASSWORD,
        proof: signupProof(),
        device: WEB_DEVICE,
      })
      .expect(201);

    expect(capturedSession().deviceId).toBe(WEB_DEVICE.deviceId);
  });

  it("registers with no device object", async () => {
    await request(app)
      .post("/api/auth/register")
      .send({ account: "brandnew", password: PASSWORD, proof: signupProof() })
      .expect(201);

    expect(capturedSession().device).toBeNull();
  });
});

describe("POST /api/auth/google — device payload", () => {
  beforeEach(() => {
    verifyGoogle.mockResolvedValue({
      sub: "google-sub-1",
      email: "user@example.com",
      emailVerified: true,
      displayName: "A User",
      firstName: "A",
      lastName: "User",
    });
    linkedRepo.findByProvider.mockResolvedValue({
      user: {
        id: "user-1",
        account: "johndoe",
        email: "user@example.com",
        status: "ACTIVE",
        lockedUntil: null,
        deletedAt: null,
        role: "USER",
      },
    });
  });

  it("carries the device payload into the new session", async () => {
    await request(app)
      .post("/api/auth/google")
      .send({ idToken: "google-id-token", device: ANDROID_DEVICE })
      .expect(200);

    expect(capturedSession().deviceId).toBe(ANDROID_DEVICE.deviceId);
    expect(capturedSession().deviceType).toBe("ANDROID");
  });

  it("signs in with no device object", async () => {
    await request(app)
      .post("/api/auth/google")
      .send({ idToken: "google-id-token" })
      .expect(200);

    expect(capturedSession().device).toBeNull();
  });
});
