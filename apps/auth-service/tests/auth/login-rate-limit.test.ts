/**
 * POST /api/auth/login — the 429 the client has to render differently from a
 * credential failure.
 *
 * Login carries its own limiter (`loginRateLimiter`), and a throttled request
 * never reaches the service, so the body is the shared rate-limit envelope
 * rather than an auth error: `code: "RATE_LIMITED"`, a `retryAfter` hint and a
 * `Retry-After` header. Showing "Incorrect account or password" for it tells
 * the user to keep typing, which is the one thing that will not help.
 *
 * The ceiling is read from env at import time, so the app is imported only
 * after the override, and the override is undone afterwards so a leaked
 * ceiling cannot 429 a sibling spec. Requests carry a client address of their
 * own — the limiter buckets on `x-client-ip` — so exhausting it here leaves
 * every other spec's quota untouched.
 */
jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: {
    findByAccountForLogin: jest.fn(async () => null),
    findByEmailForLogin: jest.fn(async () => null),
    recordSuccessfulLogin: jest.fn(),
    recordFailedLogin: jest.fn(),
    mergeFcmTokens: jest.fn(),
  },
}));

import request from "supertest";

const LIMIT = 2;
const CLIENT_IP = "198.51.100.42";

let app: import("express").Express;
const sharedLimit = process.env.LOGIN_RATE_LIMIT_MAX;

beforeAll(async () => {
  process.env.LOGIN_RATE_LIMIT_MAX = String(LIMIT);
  app = (await import("../../src/app.js")).default;
});

afterAll(() => {
  process.env.LOGIN_RATE_LIMIT_MAX = sharedLimit;
});

describe("POST /api/auth/login rate limit", () => {
  it("answers RATE_LIMITED with a Retry-After once the window is spent", async () => {
    const attempt = () =>
      request(app)
        .post("/api/auth/login")
        .set("x-client-ip", CLIENT_IP)
        .send({ account: "johndoe", password: "Correct-Horse-Battery-7" });

    // Failed attempts count in full — `skipSuccessfulRequests` only spares the
    // ones that worked, and the mocked repository resolves no user.
    for (let i = 0; i < LIMIT; i += 1) {
      expect((await attempt()).status).toBe(401);
    }

    const throttled = await attempt();

    expect(throttled.status).toBe(429);
    expect(throttled.body.error.code).toBe("RATE_LIMITED");
    expect(throttled.body.error.retryable).toBe(true);
    expect(typeof throttled.body.error.retryAfter).toBe("number");
    expect(throttled.headers["retry-after"]).toBeDefined();
  });
});
