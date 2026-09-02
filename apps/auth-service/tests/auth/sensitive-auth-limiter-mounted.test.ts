/**
 * AUDIT F2 — `sensitiveAuthRateLimiter` was declared, given its own env knobs,
 * and then imported by NOTHING. Every credential-guessing surface (login,
 * register, social login, forgot-password) was unthrottled at the HTTP layer.
 *
 * This asserts the limiter is MOUNTED, not that express-rate-limit counts
 * correctly — that is the library's job, and exhausting a per-IP ceiling inside
 * a shared Jest process would 429 every sibling spec that runs after it. The
 * `RateLimit` / `RateLimit-Policy` headers (`standardHeaders: "draft-7"`) are
 * emitted only when the middleware actually ran, so their presence is the
 * signal, and their absence on an unprotected route is the control.
 *
 * The policy header also pins AUDIT F3: `windowMs` was fed the raw MINUTES env
 * var, making the window 15 MILLIseconds. `w=` is in seconds, so a correct
 * window reads `w=900`, not `w=0`.
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
    "/api/auth/login",
    { account: "johndoe", password: "Correct-Horse-Battery-7" },
  ],
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
    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: "nope" });

    expect(res.headers).not.toHaveProperty("ratelimit-policy");
  });
});
