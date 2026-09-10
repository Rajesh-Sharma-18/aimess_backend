/**
 * AUDIT F2 — `sensitiveAuthRateLimiter` was declared, given its own env knobs,
 * and then imported by NOTHING. Every credential-guessing surface (login,
 * register, social login, forgot-password) was unthrottled at the HTTP layer.
 *
 * This asserts the limiters are MOUNTED, not that express-rate-limit counts
 * correctly — that is the library's job, and exhausting a per-IP ceiling inside
 * a shared Jest process would 429 every sibling spec that runs after it. The
 * `RateLimit` / `RateLimit-Policy` headers (`standardHeaders: "draft-7"`) are
 * emitted only when the middleware actually ran, so their presence is the
 * signal, and their absence on an unprotected route is the control.
 *
 * The policy header also pins AUDIT F3: `windowMs` was fed the raw MINUTES env
 * var, making the window 15 MILLIseconds. `w=` is in seconds, so a correct
 * window reads `w=900`, not `w=0`.
 *
 * And it pins the SPLIT: /accounts/validate, /login and /refresh used to carry
 * one shared limiter, so a probe fired while a user typed their name spent the
 * budget they then needed to sign in. Each now advertises its own window, which
 * is only possible if each has its own limiter instance and counter.
 */
jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: {
    findByAccountForLogin: jest.fn(async () => null),
    findByEmailForLogin: jest.fn(async () => null),
    recordSuccessfulLogin: jest.fn(),
    recordFailedLogin: jest.fn(),
    mergeFcmTokens: jest.fn(),
    createUser: jest.fn(),
    findByAccount: jest.fn(async () => null),
  },
}));

import request from "supertest";

import app from "../../src/app.js";

const THROTTLED: Array<[string, Record<string, unknown>]> = [
  [
    "/api/auth/register",
    { account: "johndoe", password: "Correct-Horse-Battery-7" },
  ],
  ["/api/auth/forgot-password/request", { email: "a@example.com" }],
];

describe("sensitive auth routes are throttled", () => {
  it.each(THROTTLED)("%s emits RateLimit headers", async (path, body) => {
    const res = await request(app).post(path).send(body);

    // Whatever the outcome (200/400/401/404), the limiter ran first.
    expect(res.headers).toHaveProperty("ratelimit-policy");
    // AUDIT F3 — the window is 15 MINUTES (900s), not the 15ms the raw env var
    // produced when it was passed straight into a milliseconds field.
    expect(res.headers["ratelimit-policy"]).toMatch(/;w=900$/);
  });

  it("control: an unthrottled route emits no RateLimit headers", async () => {
    // /auth/logout carries authentication, not a limiter. NOT /accounts/validate
    // and NOT /auth/refresh any more — both have their own limiter now.
    const res = await request(app).post("/api/auth/logout").send({});

    expect(res.headers).not.toHaveProperty("ratelimit-policy");
  });
});

describe("validate / login / refresh do not share a limiter", () => {
  // Each limiter advertises its own window in `RateLimit-Policy`. Three
  // distinct windows can only come from three distinct limiter instances, and
  // in express-rate-limit an instance IS the counter — which is the property
  // the split exists for.
  it("gives /accounts/validate a short window of its own", async () => {
    const res = await request(app)
      .post("/api/auth/accounts/validate")
      .send({ account: "johndoe" });

    expect(res.headers["ratelimit-policy"]).toMatch(/;w=60$/);
  });

  it("gives /login a 5-minute window of its own", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ account: "johndoe", password: "Correct-Horse-Battery-7" });

    expect(res.headers["ratelimit-policy"]).toMatch(/;w=300$/);
  });

  it("gives /refresh a window of its own", async () => {
    const res = await request(app).post("/api/auth/refresh").send({});

    expect(res.headers["ratelimit-policy"]).toMatch(/;w=300$/);
  });

  it("leaves /register on the sensitive bucket's 15-minute window", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ account: "johndoe", password: "Correct-Horse-Battery-7" });

    expect(res.headers["ratelimit-policy"]).toMatch(/;w=900$/);
  });
});

describe("limiters bucket on the caller, not on the gateway", () => {
  /**
   * Behind the gateway, `req.ip` is the GATEWAY: this service runs with
   * TRUST_PROXY_HOPS=0 and the gateway does not append itself to
   * `X-Forwarded-For`. Every per-IP limiter here was therefore ONE bucket
   * shared by the whole platform — "20 per 15 minutes per address" meant 20 for
   * everybody, and a few people signing in at once looked exactly like an
   * attack.
   *
   * The gateway now stamps `x-client-ip` with the address it resolved and the
   * limiter key reads it. `RateLimit: limit=…, remaining=…` is per key, so two
   * callers drawing down two independent remainders is the whole property.
   */
  const remainingOf = (header: string | undefined) =>
    Number(/remaining=(\d+)/.exec(header ?? "")?.[1]);

  const probe = (clientIp: string) =>
    request(app)
      .post("/api/auth/accounts/validate")
      .set("x-client-ip", clientIp)
      .send({ account: "johndoe" });

  it("gives two client addresses independent quotas", async () => {
    const first = await probe("198.51.100.7");
    const second = await probe("198.51.100.7");
    const other = await probe("203.0.113.9");

    // The same caller draws its own bucket down.
    expect(remainingOf(second.headers["ratelimit"])).toBe(
      remainingOf(first.headers["ratelimit"]) - 1
    );
    // A different caller starts where the first one did — untouched by it.
    expect(remainingOf(other.headers["ratelimit"])).toBe(
      remainingOf(first.headers["ratelimit"])
    );
  });

  it("falls back to req.ip when the gateway stamped nothing", async () => {
    // A direct call (no gateway in front) must still be limited, not exempt.
    const res = await request(app)
      .post("/api/auth/accounts/validate")
      .send({ account: "johndoe" });

    expect(res.headers).toHaveProperty("ratelimit");
  });
});
