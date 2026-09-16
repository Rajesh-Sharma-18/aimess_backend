/**
 * AIM-01 — the admin API must carry its own edge guards.
 *
 * The gateway wraps `/admin/*` in a rate limiter, an IP allowlist and an edge
 * JWT check, but this service is also published on its own vhost that routes
 * straight to it, so on that path none of it ran: `POST /v1/auth/login` was an
 * unauthenticated, unthrottled, IP-unrestricted admin credential endpoint, and
 * so were forgot-password / verify-otp / resend-otp — unlimited OTP brute force
 * against admin password reset.
 *
 * `ADMIN_IP_WHITELIST` was declared in this service's config and read by
 * nothing, which is why the deployment comment claiming the service enforced it
 * was false.
 *
 * The limits come from env parsed at import, so each block builds the app
 * inside `jest.isolateModulesAsync` with its own values.
 */
import request from "supertest";
import type { Express } from "express";

/** Build a fresh app under `patch`, with all module state reset. */
async function buildApp(patch: Record<string, string>): Promise<Express> {
  const original = { ...process.env };
  Object.assign(process.env, patch);

  let app: Express | undefined;
  try {
    await jest.isolateModulesAsync(async () => {
      const mod = await import("../../src/app.js");
      app = mod.createApp();
    });
  } finally {
    process.env = original;
  }

  if (!app) throw new Error("app was not created");
  return app;
}

describe("admin credential rate limiter", () => {
  it("throttles repeated login attempts from one address", async () => {
    const app = await buildApp({
      ADMIN_LOGIN_RATE_LIMIT_MAX: "3",
    });

    const attempt = () =>
      request(app)
        .post("/v1/auth/login")
        .send({ email: "admin@example.com", password: "wrong-password" });

    // The first three are answered by the application (401/400 — the point is
    // only that they are NOT throttled).
    for (let i = 0; i < 3; i += 1) {
      const res = await attempt();
      expect(res.status).not.toBe(429);
    }

    const throttled = await attempt();
    expect(throttled.status).toBe(429);
    expect(throttled.body.error?.code ?? throttled.body.messageKey).toBe(
      "RATE_LIMITED"
    );
  });

  it.each([
    "/v1/auth/forgot-password",
    "/v1/auth/verify-otp",
    "/v1/auth/resend-otp",
    "/v1/auth/reset-password",
  ])("covers the unauthenticated password-reset endpoint %s", async (path) => {
    // These were the OTP brute-force surface: unlimited attempts against an
    // admin's reset code.
    const app = await buildApp({
      ADMIN_LOGIN_RATE_LIMIT_MAX: "2",
    });

    const attempt = () => request(app).post(path).send({});

    await attempt();
    await attempt();

    expect((await attempt()).status).toBe(429);
  });

  it("does not throttle a health probe", async () => {
    // Health is mounted above the guards so an infra probe cannot be locked out
    // of a service it is meant to be watching.
    const app = await buildApp({
      ADMIN_LOGIN_RATE_LIMIT_MAX: "1",
      ADMIN_READ_RATE_LIMIT_MAX: "1",
    });

    for (let i = 0; i < 5; i += 1) {
      expect((await request(app).get("/health")).status).toBe(200);
    }
  });
});

describe("admin read/write rate limiters", () => {
  // Whatever answers after the limiters (adminAuth has no database here) is
  // irrelevant: anything but 429 = let through, 429 = throttled.
  const PROBE = "/v1/__rate-limit-probe";
  const SMALL = { ADMIN_READ_RATE_LIMIT_MAX: "3", ADMIN_WRITE_RATE_LIMIT_MAX: "2" };

  async function adminToken(adminId: string): Promise<string> {
    const { signAdminAccessToken } = await import("../../src/lib/admin-jwt.js");
    return signAdminAccessToken({
      adminId,
      sessionId: "22222222-2222-4222-8222-222222222222",
    }).token;
  }

  it("throttles excessive reads with RATE_LIMITED and retryAfter", async () => {
    const app = await buildApp(SMALL);
    const bearer = `Bearer ${await adminToken("admin-a")}`;

    for (let i = 0; i < 3; i += 1) {
      expect((await request(app).get(PROBE).set("Authorization", bearer)).status).not.toBe(429);
    }
    const res = await request(app).get(PROBE).set("Authorization", bearer);

    expect(res.status).toBe(429);
    expect(res.body.error).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(res.body.error.retryAfter).toBeGreaterThan(0);
  });

  it("keeps writes in a separate, stricter bucket", async () => {
    const app = await buildApp(SMALL);
    const bearer = `Bearer ${await adminToken("admin-a")}`;

    await request(app).post(PROBE).set("Authorization", bearer);
    await request(app).post(PROBE).set("Authorization", bearer);
    expect((await request(app).post(PROBE).set("Authorization", bearer)).status).toBe(429);
    expect((await request(app).get(PROBE).set("Authorization", bearer)).status).not.toBe(429);
  });

  it("keys on the verified admin, not the shared address", async () => {
    // Supertest sends every request from one loopback address — the office NAT
    // case. Admin A exhausting their bucket must not throttle admin B.
    const app = await buildApp(SMALL);
    const a = `Bearer ${await adminToken("admin-a")}`;
    const b = `Bearer ${await adminToken("admin-b")}`;

    for (let i = 0; i < 3; i += 1) await request(app).get(PROBE).set("Authorization", a);
    expect((await request(app).get(PROBE).set("Authorization", a)).status).toBe(429);
    expect((await request(app).get(PROBE).set("Authorization", b)).status).not.toBe(429);
  });

  it("gives unverified tokens and spoofed headers only the IP bucket", async () => {
    const app = await buildApp(SMALL);
    const b = `Bearer ${await adminToken("admin-b")}`;
    const spoof = () =>
      request(app)
        .get(PROBE)
        .set("Authorization", "Bearer forged.token.value")
        .set("X-Is-Admin", "true");

    for (let i = 0; i < 3; i += 1) await spoof();
    expect((await spoof()).status).toBe(429);
    expect((await request(app).get(PROBE)).status).toBe(429);
    expect((await request(app).get(PROBE).set("Authorization", b)).status).not.toBe(429);
  });
});

describe("admin IP allowlist", () => {
  it("rejects an address that is not on the list", async () => {
    const app = await buildApp({ ADMIN_IP_WHITELIST: "203.0.113.10" });

    const res = await request(app)
      .post("/v1/auth/login")
      .send({ email: "admin@example.com", password: "whatever" });

    expect(res.status).toBe(403);
    expect(res.body.error?.code ?? res.body.messageKey).toBe("FORBIDDEN");
  });

  it("admits an address on the list", async () => {
    // Supertest connects over loopback, so allowlisting it exercises the
    // pass-through branch.
    const app = await buildApp({
      ADMIN_IP_WHITELIST: "::ffff:127.0.0.1,127.0.0.1",
    });

    const res = await request(app)
      .post("/v1/auth/login")
      .send({ email: "admin@example.com", password: "whatever" });

    expect(res.status).not.toBe(403);
  });

  it("allows everything when the list is empty (development)", async () => {
    // Production cannot be in this state: config/env.ts refuses to boot with an
    // empty allowlist when NODE_ENV is production.
    const app = await buildApp({ ADMIN_IP_WHITELIST: "" });

    const res = await request(app)
      .post("/v1/auth/login")
      .send({ email: "admin@example.com", password: "whatever" });

    expect(res.status).not.toBe(403);
  });
});
