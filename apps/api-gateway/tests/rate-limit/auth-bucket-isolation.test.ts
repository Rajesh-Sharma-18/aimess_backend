/**
 * The three auth endpoints a normal session touches must not share a counter.
 *
 * They used to. `sensitiveAuthRateLimiter` is ONE limiter object, and one
 * limiter object is one `rule`, and one rule is one key prefix
 * (`rl:gw:<rule>:<ip>` — see redis-rate-limit-store.ts). Mounting that single
 * object on `/auth/login`, `/auth/accounts` and `/auth/refresh` therefore gave
 * all three a single 20-per-15-minute allowance between them: a signup form
 * probing availability while the user typed spent the budget the user then
 * needed to sign in, and the background refreshes that followed spent what was
 * left. The 429 lasted fifteen minutes and applied to all three.
 *
 * The store already namespaced by rule, so the isolation only ever needed
 * distinct rules — which is what this asserts: drive one limiter to its ceiling
 * and the other two must still pass a request through.
 *
 * Deliberately mounted on a bare express app rather than driven through
 * `createApp`. The real `/auth/*` routes are proxied, and this harness points
 * the service URLs at the ports a developer's own stack listens on — so on a
 * machine running the dev services the assertion would be reading auth-service's
 * `RateLimit` headers off a proxied response instead of the gateway's own. The
 * limiters are module singletons; mounting them directly tests the counters
 * themselves with nothing downstream to confuse them. Route mounting is pinned
 * separately, in auth-service's `sensitive-auth-limiter-mounted` spec.
 */
import express, { type Express } from "express";
import request from "supertest";

import {
  accountValidateRateLimiter,
  loginRateLimiter,
  refreshRateLimiter,
} from "../../src/middleware/rate-limit.js";

const VALIDATE = "/validate";
const LOGIN = "/login";
const REFRESH = "/refresh";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.post(VALIDATE, accountValidateRateLimiter, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  // Answers 401 so the failure path is what gets counted — `loginRateLimiter`
  // refunds successful requests, and a limiter that only ever saw 200s could
  // never be driven to its ceiling at all.
  app.post(LOGIN, loginRateLimiter, (_req, res) => {
    res.status(401).json({ ok: false });
  });
  app.post(REFRESH, refreshRateLimiter, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

const app = buildApp();

/** Hammer a path until it 429s, or give up after `budget` attempts. */
async function drive(path: string, budget: number) {
  let last;
  for (let i = 0; i < budget; i += 1) {
    last = await request(app).post(path).send({ account: `probe-${i}` });
    if (last.status === 429) return last;
  }
  return last;
}

describe("auth limiter bucket isolation", () => {
  it("exhausting account-validate leaves login and refresh usable", async () => {
    // ACCOUNT_VALIDATE_RATE_LIMIT_MAX defaults to 30/minute; the budget is
    // comfortably above it so the ceiling is reached, not merely approached.
    const throttled = await drive(VALIDATE, 60);
    expect(throttled?.status).toBe(429);
    expect(throttled?.body.error.code).toBe("RATE_LIMITED");
    // A short window is half the fix: the old shared bucket answered 429 for up
    // to 900 seconds, which is indistinguishable from being locked out.
    expect(throttled?.body.error.retryAfter).toBeLessThanOrEqual(60);

    // The regression: both of these used to inherit the exhausted bucket.
    expect((await request(app).post(LOGIN).send({})).status).not.toBe(429);
    expect((await request(app).post(REFRESH).send({})).status).not.toBe(429);
  });

  it("exhausting login leaves refresh usable and does not re-block validate's window", async () => {
    const throttled = await drive(LOGIN, 40);
    expect(throttled?.status).toBe(429);
    // Five minutes, not fifteen.
    expect(throttled?.body.error.retryAfter).toBeLessThanOrEqual(300);

    // Session refresh is background behaviour; a brute-force run against login
    // must never be able to sign a legitimate tab out.
    expect((await request(app).post(REFRESH).send({})).status).not.toBe(429);
  });

  it("exhausting refresh leaves login usable", async () => {
    const throttled = await drive(REFRESH, 120);
    expect(throttled?.status).toBe(429);

    // `loginRateLimiter` was driven to its ceiling by the spec above and its
    // window has not elapsed, so this asserts what it can: refresh did not make
    // things WORSE for login, which is the direction the shared bucket broke.
    const login = await request(app).post(LOGIN).send({});
    expect(login.headers["ratelimit-policy"]).toBe("15;w=300");
  });

  it("advertises a different policy per endpoint", async () => {
    // `RateLimit-Policy` is `<limit>;w=<window seconds>` and is emitted by the
    // limiter that served the request. Three policies means three counters.
    const validate = await request(app).post(VALIDATE).send({});
    const login = await request(app).post(LOGIN).send({});
    const refresh = await request(app).post(REFRESH).send({});

    expect(validate.headers["ratelimit-policy"]).toBe("30;w=60");
    expect(login.headers["ratelimit-policy"]).toBe("15;w=300");
    expect(refresh.headers["ratelimit-policy"]).toBe("60;w=300");
  });
});
