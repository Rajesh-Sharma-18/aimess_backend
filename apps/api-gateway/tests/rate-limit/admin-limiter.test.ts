/**
 * Backoffice (`/admin/*`) rate limiting at the gateway edge.
 *
 * The whole admin surface used to share ONE bucket of 100 requests per 15
 * minutes (`admin.global`) — about 6.7 requests a minute for reads, writes and
 * polling combined. The Dashboard's service-status card alone polls every 15s,
 * which is 60 of those 100 in a single window, so an operator who left the
 * Dashboard open and then navigated a handful of pages was answered 429. The
 * key was also the token digest rather than the admin, so it tracked neither
 * the operator nor the session reliably.
 *
 * The replacement splits reads from writes and keys authenticated traffic on
 * the VERIFIED admin id. Everything unverified — no token, a forged or expired
 * token, a user token, a browser-supplied "I am an admin" header — falls back
 * to the per-IP bucket, so none of it can reach an admin's allowance.
 *
 * Every spec builds its own app so the in-process counters start at zero, and
 * BACKOFFICE_SERVICE_URL is unset so the router answers 503 immediately instead
 * of dialling an upstream that is not running. A 503 therefore means "the
 * limiter let it through"; a 429 means it did not.
 */
import jwt from "jsonwebtoken";
import request from "supertest";
import type { Express } from "express";

const ADMIN_SECRET = process.env.JWT_ADMIN_SECRET as string;
const ADMIN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION_1 = "11111111-1111-4111-8111-111111111111";
const SESSION_2 = "22222222-2222-4222-8222-222222222222";

/** An admin access token in the exact shape backoffice-service signs. */
function adminToken(
  adminId = ADMIN_A,
  sessionId = SESSION_1,
  secret = ADMIN_SECRET
): string {
  return jwt.sign({ sub: adminId, sid: sessionId, type: "admin_access" }, secret, {
    expiresIn: 3600,
  });
}

/** Build a fresh app under `patch` (`undefined` deletes the variable). */
async function buildApp(
  patch: Record<string, string | undefined> = {}
): Promise<Express> {
  const original = { ...process.env };
  for (const [key, value] of Object.entries({
    BACKOFFICE_SERVICE_URL: undefined,
    ...patch,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  let app: Express | undefined;
  try {
    await jest.isolateModulesAsync(async () => {
      const mod = await import("../../src/app.js");
      app = mod.createApp({} as never, {} as never) as Express;
    });
  } finally {
    process.env = original;
  }
  if (!app) throw new Error("app was not created");
  return app;
}

const get = (app: Express, path: string, token?: string) => {
  const req = request(app).get(`/admin/v1/${path}`);
  return token ? req.set("Authorization", `Bearer ${token}`) : req;
};

const post = (app: Express, path: string, token?: string) => {
  const req = request(app).post(`/admin/v1/${path}`).send({});
  return token ? req.set("Authorization", `Bearer ${token}`) : req;
};

/**
 * One operator's 15-minute Backoffice session, as the panel actually issues it
 * (paths from aimess_admin_panel/src/constants/api-endpoints.ts). Sent in one
 * burst, i.e. compressed into a single limiter window — stricter than reality.
 */
function normalAdminSession(): string[] {
  const pages = [
    // Dashboard mount
    "me",
    "dashboard/overview",
    "dashboard/charts?period=monthly",
    "dashboard/service-status",
    // User Management → a user → back, with search and pagination
    "users?page=1&limit=10",
    "users?page=1&limit=10&search=john",
    "users?page=2&limit=10&search=john",
    `users/${ADMIN_B}/details`,
    `users/${ADMIN_B}/reports`,
    `users/${ADMIN_B}/devices`,
    `users/${ADMIN_B}/communities`,
    "communities?page=1&limit=10",
    "communities?page=1&limit=10&status=ACTIVE",
    "groups?page=1&limit=10",
    "reports?page=1&limit=10",
    "reports/r1",
    "reports/r1/evidence",
    "reports/r1/history",
    "livestreams?page=1&limit=10",
    "announcements?page=1&limit=10",
    "categories",
    "notification-categories",
    "audit-logs?page=1&limit=20",
    "audit-logs?page=2&limit=20",
    "system-health",
    "admin-accounts",
    "admin-accounts/permissions",
  ];
  // The Dashboard's service-status card polled every 15s for the 15 minutes.
  const polling = Array.from({ length: 60 }, () => "dashboard/service-status");
  // Twice round the navigation, plus the poll.
  return [...pages, ...pages, ...polling];
}

describe("admin rate limiting — normal Backoffice usage", () => {
  it("a realistic 15-minute admin session is never throttled", async () => {
    const app = await buildApp();
    const token = adminToken();
    const session = normalAdminSession();
    // More than the old 100-per-15-minutes ceiling, which is the reproduction.
    expect(session.length).toBeGreaterThan(100);

    const statuses: number[] = [];
    for (const path of session) {
      statuses.push((await get(app, path, token)).status);
    }

    expect(statuses).not.toContain(429);
    expect([...new Set(statuses)]).toEqual([503]);
  });

  it("several tabs / sessions of one admin share that admin's read bucket", async () => {
    const app = await buildApp({ ADMIN_READ_RATE_LIMIT_MAX: "10" });
    const remaining = (res: request.Response) =>
      Number(/remaining=(\d+)/.exec(res.headers["ratelimit"] ?? "")?.[1]);

    const first = await get(app, "dashboard/overview", adminToken(ADMIN_A, SESSION_1));
    const second = await get(app, "system-health", adminToken(ADMIN_A, SESSION_2));

    expect(first.headers["ratelimit-policy"]).toBe("10;w=60");
    expect(remaining(second)).toBe(remaining(first) - 1);
  });
});

describe("admin rate limiting — protection is kept", () => {
  const SMALL = {
    ADMIN_READ_RATE_LIMIT_MAX: "5",
    ADMIN_WRITE_RATE_LIMIT_MAX: "3",
    ADMIN_LOGIN_RATE_LIMIT_MAX: "100",
  };

  it("excessive reads are answered 429 RATE_LIMITED with retryAfter", async () => {
    const app = await buildApp(SMALL);
    const token = adminToken();

    for (let i = 0; i < 5; i += 1) {
      expect((await get(app, "users", token)).status).not.toBe(429);
    }
    const throttled = await get(app, "users", token);

    expect(throttled.status).toBe(429);
    expect(throttled.body.code).toBe("RATE_LIMITED");
    expect(throttled.body.error).toMatchObject({
      statusCode: 429,
      code: "RATE_LIMITED",
      retryable: true,
    });
    expect(throttled.body.error.retryAfter).toBeGreaterThan(0);
    expect(Number(throttled.headers["retry-after"])).toBeGreaterThan(0);
    expect(typeof throttled.body.message).toBe("string");
  });

  it("sensitive mutations have their own, stricter bucket", async () => {
    const app = await buildApp(SMALL);
    const token = adminToken();

    for (let i = 0; i < 3; i += 1) {
      expect((await post(app, `users/u${i}/ban`, token)).status).not.toBe(429);
    }
    expect((await post(app, "users/u9/ban", token)).status).toBe(429);

    // Exhausting writes does not lock the operator out of reading.
    expect((await get(app, "users", token)).status).not.toBe(429);
  });

  it("reads do not spend the write allowance", async () => {
    const app = await buildApp(SMALL);
    const token = adminToken();

    for (let i = 0; i < 5; i += 1) await get(app, "users", token);
    expect((await get(app, "users", token)).status).toBe(429);
    expect((await post(app, "users/u1/ban", token)).status).not.toBe(429);
  });

  it("one admin exhausting their bucket does not throttle another admin", async () => {
    const app = await buildApp(SMALL);

    for (let i = 0; i < 6; i += 1) await get(app, "users", adminToken(ADMIN_A));
    expect((await get(app, "users", adminToken(ADMIN_A))).status).toBe(429);

    expect((await get(app, "users", adminToken(ADMIN_B))).status).not.toBe(429);
  });

  it("a forged token naming another admin cannot spend that admin's bucket", async () => {
    const app = await buildApp(SMALL);
    const forged = adminToken(ADMIN_B, SESSION_1, "not-the-admin-secret");

    // Forged traffic lands in the caller's IP bucket, and exhausts only that.
    for (let i = 0; i < 6; i += 1) await get(app, "users", forged);
    expect((await get(app, "users", forged)).status).toBe(429);
    expect((await get(app, "users")).status).toBe(429);

    // The real admin B is untouched.
    expect((await get(app, "users", adminToken(ADMIN_B))).status).not.toBe(429);
  });

  it("client-supplied admin headers and user tokens do not obtain admin limits", async () => {
    const app = await buildApp(SMALL);
    const { makeAccessToken } = await import("../helpers/auth.js");
    const userToken = makeAccessToken();

    const spoof = () =>
      get(app, "users", userToken)
        .set("X-Is-Admin", "true")
        .set("X-Admin-Id", ADMIN_A)
        .set("X-Role", "SUPER_ADMIN");

    for (let i = 0; i < 5; i += 1) await spoof();
    expect((await spoof()).status).toBe(429);
    // Same IP bucket as any unauthenticated caller.
    expect((await get(app, "users")).status).toBe(429);
    // Admin A's own bucket is untouched by the spoofed traffic.
    expect((await get(app, "users", adminToken(ADMIN_A))).status).not.toBe(429);
  });

  it("unauthenticated traffic is limited per IP and cannot escape by omitting a token", async () => {
    const app = await buildApp(SMALL);

    for (let i = 0; i < 5; i += 1) {
      expect((await get(app, "users")).status).toBe(401);
    }
    expect((await get(app, "users")).status).toBe(429);
  });

  it("admin login keeps its strict limit, independent of the admin allowances", async () => {
    const app = await buildApp({
      ADMIN_READ_RATE_LIMIT_MAX: "1000",
      ADMIN_WRITE_RATE_LIMIT_MAX: "1000",
      ADMIN_LOGIN_RATE_LIMIT_MAX: "3",
    });

    for (let i = 0; i < 3; i += 1) {
      expect((await post(app, "auth/login")).status).not.toBe(429);
    }
    const throttled = await post(app, "auth/login");
    expect(throttled.status).toBe(429);
    expect(throttled.body.code).toBe("RATE_LIMITED");
  });
});
