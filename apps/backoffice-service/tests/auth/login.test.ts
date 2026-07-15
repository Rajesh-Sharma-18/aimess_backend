/**
 * POST /v1/auth/login — public (no admin bearer). Routing, the Zod login schema,
 * the controller and the success/error envelope all run for real; the
 * `adminAuthService` seam is mocked so each branch (success, bad creds → 401,
 * non-active → 403) is driven deterministically.
 */
jest.mock("../../src/services/index.js", () => {
  const actual = jest.requireActual("../../src/services/index.js");
  return {
    __esModule: true,
    ...actual,
    adminAuthService: { login: jest.fn() },
  };
});

import request from "supertest";
import { ForbiddenError, UnauthorizedError } from "@aimess/errors";

import { app } from "../../src/app.js";
import { adminAuthService } from "../../src/services/index.js";

const svc = adminAuthService as unknown as { login: jest.Mock };

const TOKENS = {
  accessToken: "admin.access.jwt",
  refreshToken: "admin-refresh-token",
  accessTokenExpiresIn: 28800,
  refreshTokenExpiresIn: 604800,
};

const PROFILE = {
  id: "admin-1",
  email: "admin@aimess.local",
  name: "Admin One",
  avatarUrl: "https://cdn/avatar.png",
  role: "ADMIN",
  status: "ACTIVE",
  lastLoginAt: null,
  permissions: ["dashboard.read"],
};

describe("POST /v1/auth/login", () => {
  beforeEach(() => {
    svc.login.mockResolvedValue({ tokens: TOKENS, admin: PROFILE });
  });

  it("logs in with valid credentials → 200 with tokens + admin profile", async () => {
    const res = await request(app)
      .post("/v1/auth/login")
      .send({ email: "admin@aimess.local", password: "Sup3rSecret!" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe("Login successful.");
    expect(res.body.data.tokens.accessToken).toBe(TOKENS.accessToken);
    expect(res.body.data.admin.email).toBe(PROFILE.email);
    expect(svc.login).toHaveBeenCalledWith(
      "admin@aimess.local",
      "Sup3rSecret!",
      expect.objectContaining({ ip: expect.any(String) })
    );
  });

  it("returns 401 with a generic message for invalid credentials (wrong password)", async () => {
    svc.login.mockRejectedValue(
      new UnauthorizedError("ADMIN_INVALID_CREDENTIALS")
    );

    const res = await request(app)
      .post("/v1/auth/login")
      .send({ email: "admin@aimess.local", password: "wrong" });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Invalid email or password.");
  });

  it("returns the SAME 401 + message for an unknown email (no account enumeration)", async () => {
    svc.login.mockRejectedValue(
      new UnauthorizedError("ADMIN_INVALID_CREDENTIALS")
    );

    const res = await request(app)
      .post("/v1/auth/login")
      .send({ email: "nobody@aimess.local", password: "Sup3rSecret!" });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Invalid email or password.");
  });

  it("returns 403 when the admin account is disabled", async () => {
    svc.login.mockRejectedValue(new ForbiddenError("ADMIN_ACCOUNT_NOT_ACTIVE"));

    const res = await request(app)
      .post("/v1/auth/login")
      .send({ email: "suspended@aimess.local", password: "Sup3rSecret!" });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe(
      "Your account has been disabled. Please contact the super administrator."
    );
  });

  it("returns 403 with a distinct message when the admin account is deleted", async () => {
    svc.login.mockRejectedValue(new ForbiddenError("ADMIN_ACCOUNT_DELETED"));

    const res = await request(app)
      .post("/v1/auth/login")
      .send({ email: "gone@aimess.local", password: "Sup3rSecret!" });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Your account is no longer available.");
  });

  it.each([
    ["missing email", { password: "Sup3rSecret!" }],
    ["missing password", { email: "admin@aimess.local" }],
    ["malformed email", { email: "not-an-email", password: "Sup3rSecret!" }],
    ["empty password", { email: "admin@aimess.local", password: "" }],
    ["empty body", {}],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app).post("/v1/auth/login").send(body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(svc.login).not.toHaveBeenCalled();
  });

  it("rejects a malformed JSON body with 400 (never 500)", async () => {
    const res = await request(app)
      .post("/v1/auth/login")
      .set("Content-Type", "application/json")
      .send('{"email": "admin@aimess.local", "password":');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(svc.login).not.toHaveBeenCalled();
  });

  it("ignores extra/privileged fields in the body (mass-assignment guard)", async () => {
    const res = await request(app)
      .post("/v1/auth/login")
      .send({
        email: "admin@aimess.local",
        password: "Sup3rSecret!",
        role: "SUPER_ADMIN",
        permissions: ["*"],
        isSuperAdmin: true,
      });

    expect(res.status).toBe(200);
    // The service is only ever called with the two whitelisted credential
    // fields — the injected privileged fields never reach it.
    expect(svc.login).toHaveBeenCalledWith(
      "admin@aimess.local",
      "Sup3rSecret!",
      expect.any(Object)
    );
  });

  it("safely handles a NoSQL-injection-shaped email payload (400, not executed)", async () => {
    const res = await request(app)
      .post("/v1/auth/login")
      .send({ email: { $ne: null }, password: { $ne: null } });

    // The Zod email check rejects the object before any lookup runs.
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(svc.login).not.toHaveBeenCalled();
  });
});
