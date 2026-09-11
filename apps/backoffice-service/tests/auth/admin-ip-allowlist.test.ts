/**
 * Admin IP allowlist — the parse-failure cases.
 *
 * Split out of `edge-guards.test.ts` rather than appended to it: each case
 * rebuilds the whole app under `jest.isolateModulesAsync`, and adding three
 * more to that file pushed its first (already slow) rate-limiter case over
 * Jest's default per-test timeout.
 *
 * The middleware fails OPEN when every configured entry is malformed, because
 * enforcing an empty rule set would deny the whole admin surface over one typo.
 * What stops that ever being production's state is the boot invariant in
 * `config/env.ts` — covered in packages/utils/tests/ip-allowlist.test.ts. These
 * cases pin the development behaviour it is paired with.
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

describe("admin IP allowlist — malformed entries", () => {
  it("opens when every entry is malformed, but only outside production", async () => {
    const app = await buildApp({
      ADMIN_IP_WHITELIST: "203.0.113.0/33,not-an-ip",
    });

    const res = await request(app)
      .post("/v1/auth/login")
      .send({ email: "admin@example.com", password: "whatever" });

    expect(res.status).not.toBe(403);
  });

  it("enforces the surviving rules when only SOME entries are malformed", async () => {
    const app = await buildApp({
      ADMIN_IP_WHITELIST: "203.0.113.10,not-an-ip",
    });

    const res = await request(app)
      .post("/v1/auth/login")
      .send({ email: "admin@example.com", password: "whatever" });

    expect(res.status).toBe(403);
  });

  it("admits a loopback caller through a CIDR range", async () => {
    const app = await buildApp({ ADMIN_IP_WHITELIST: "127.0.0.0/8,::1/128" });

    const res = await request(app)
      .post("/v1/auth/login")
      .send({ email: "admin@example.com", password: "whatever" });

    expect(res.status).not.toBe(403);
  });
});
