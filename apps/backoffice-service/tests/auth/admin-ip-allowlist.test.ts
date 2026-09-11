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

/**
 * Every case here rebuilds the whole service under `isolateModulesAsync`, so
 * each one pays a cold module-graph cost and the first pays the compile too.
 * That already sat close to Jest's 5s default alone, and tips over it when the
 * file runs alongside the rest of the repo's suites on a loaded machine — a
 * timeout that says nothing about the allowlist. Raised for the file rather
 * than pinned per case, since the cost is the harness, not any one assertion.
 */
jest.setTimeout(30_000);

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

/**
 * ADMIN_IP_WHITELIST_ENABLED — the runtime half of the switch.
 *
 * `config/env.ts` decides whether a boot is allowed; these decide what a live
 * request meets. The pairing matters: the boot assertion is what stops
 * production quietly running with no perimeter, and the guard below is what
 * makes "no perimeter" mean ONLY "no source-address check" rather than "no
 * admin security".
 *
 * Supertest binds loopback, so the caller is 127.0.0.1 or ::1 — "not
 * allowlisted" is spelled as a documentation-range address the caller can never
 * hold (RFC 5737 / RFC 3849), never as a developer's real address.
 */
describe("admin IP allowlist — enforcement switch", () => {
  it("admits an allowlisted IPv4 caller while enabled", async () => {
    const app = await buildApp({
      ADMIN_IP_WHITELIST_ENABLED: "true",
      ADMIN_IP_WHITELIST: "127.0.0.1",
    });

    const res = await request(app)
      .post("/v1/auth/login")
      .send({ email: "admin@example.com", password: "whatever" });

    expect(res.status).not.toBe(403);
  });

  it("denies a caller outside the list while enabled", async () => {
    const app = await buildApp({
      ADMIN_IP_WHITELIST_ENABLED: "true",
      ADMIN_IP_WHITELIST: "203.0.113.10",
    });

    const res = await request(app)
      .post("/v1/auth/login")
      .send({ email: "admin@example.com", password: "whatever" });

    expect(res.status).toBe(403);
  });

  it("keeps IPv6 behaviour while enabled", async () => {
    // Two halves of the same rule: a v6 range that covers the loopback caller
    // admits, and one that does not denies. Asserting only the first would pass
    // just as well against a guard that had stopped matching altogether.
    const admitted = await buildApp({
      ADMIN_IP_WHITELIST_ENABLED: "true",
      ADMIN_IP_WHITELIST: "::1/128,127.0.0.1",
    });
    const denied = await buildApp({
      ADMIN_IP_WHITELIST_ENABLED: "true",
      ADMIN_IP_WHITELIST: "2001:db8::/32",
    });

    const okRes = await request(admitted)
      .post("/v1/auth/login")
      .send({ email: "admin@example.com", password: "whatever" });
    const denyRes = await request(denied)
      .post("/v1/auth/login")
      .send({ email: "admin@example.com", password: "whatever" });

    expect(okRes.status).not.toBe(403);
    expect(denyRes.status).toBe(403);
  });

  it("skips the check while disabled, even for a caller outside the list", async () => {
    // Same list that produced a 403 two cases up. The switch is the only
    // difference, so a pass here is the switch working and nothing else.
    const app = await buildApp({
      ADMIN_IP_WHITELIST_ENABLED: "false",
      ADMIN_IP_WHITELIST: "203.0.113.10",
    });

    const res = await request(app)
      .post("/v1/auth/login")
      .send({ email: "admin@example.com", password: "whatever" });

    expect(res.status).not.toBe(403);
  });

  it("serves admin requests while disabled with an empty list", async () => {
    const app = await buildApp({
      ADMIN_IP_WHITELIST_ENABLED: "false",
      ADMIN_IP_WHITELIST: "",
    });

    const res = await request(app)
      .post("/v1/auth/login")
      .send({ email: "admin@example.com", password: "whatever" });

    expect(res.status).not.toBe(403);
  });

  it("still demands authentication on a protected route while disabled", async () => {
    // The failure this switch could have introduced: "no IP perimeter" quietly
    // becoming "no admin security". An unauthenticated call to a SUPER_ADMIN
    // route must still be refused as unauthenticated, never served.
    const app = await buildApp({
      ADMIN_IP_WHITELIST_ENABLED: "false",
      ADMIN_IP_WHITELIST: "",
    });

    const res = await request(app).get("/v1/notification-categories");

    expect(res.status).toBe(401);
  });

  it("still demands authentication on a protected route while enabled and allowlisted", async () => {
    // The same route from an address the perimeter admits. Passing the IP check
    // is not passing authentication.
    const app = await buildApp({
      ADMIN_IP_WHITELIST_ENABLED: "true",
      ADMIN_IP_WHITELIST: "127.0.0.1,::1/128",
    });

    const res = await request(app).get("/v1/notification-categories");

    expect(res.status).toBe(401);
  });

  it.each(["abc", "1", "yes", "TRUE", "off"])(
    "refuses to load at all on the unparseable switch value %p",
    async (value) => {
      // The fail-safe, asserted where it bites. A `=== "true"` coercion would
      // read every one of these as false and drop the perimeter silently; the
      // schema rejects them, and `env.ts` ends the process on a schema failure.
      // `process.exit` is stubbed to throw so the assertion sees the refusal
      // instead of the Jest worker dying on it.
      const exitSpy = jest
        .spyOn(process, "exit")
        .mockImplementation((): never => {
          throw new Error("__EXIT__");
        });
      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      try {
        await expect(
          buildApp({
            ADMIN_IP_WHITELIST_ENABLED: value,
            ADMIN_IP_WHITELIST: "203.0.113.10",
          })
        ).rejects.toThrow("__EXIT__");
      } finally {
        exitSpy.mockRestore();
        errorSpy.mockRestore();
      }
    }
  );
});
