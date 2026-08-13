/**
 * The 429 contract at the gateway edge.
 *
 * Before this work a throttled client got `{ success, message }` and nothing
 * else — no machine-readable code, no retry hint in the body — so it could not
 * distinguish a throttle from any other 4xx and had nothing to wait on. It also
 * bucketed every caller by IP, which meant users sharing one egress address
 * (office, campus, CGNAT, VPN) shared one quota and throttled each other.
 *
 * These specs pin both: the envelope shape, and the per-credential scoping.
 */
import request from "supertest";

import { createApp } from "../../src/app.js";
import type { MessagingClient } from "../../src/grpc/clients/messaging.client.js";
import type { MediaClient } from "../../src/grpc/clients/media.client.js";
import { makeAccessToken } from "../helpers/auth.js";

// `/auth/login` carries `sensitiveAuthRateLimiter` (IP-scoped, 20 per 15 min in
// the test env) and is reachable without a session, so it is the cheapest way
// to drive a limiter to its ceiling deterministically.
const SENSITIVE_PATH = "/api/v1/auth/login";

function buildApp() {
  return createApp(
    {} as unknown as MessagingClient,
    {} as unknown as MediaClient
  );
}

/** Hammer a path until it 429s, or give up after `budget` attempts. */
async function drive(
  app: ReturnType<typeof buildApp>,
  path: string,
  budget: number,
  headers: Record<string, string> = {}
) {
  let last;
  for (let i = 0; i < budget; i += 1) {
    const req = request(app).post(path).send({});
    for (const [key, value] of Object.entries(headers)) req.set(key, value);
    last = await req;
    if (last.status === 429) return last;
  }
  return last;
}

describe("gateway 429 envelope", () => {
  const app = buildApp();

  it("answers a throttled request with the structured error envelope", async () => {
    const res = await drive(app, SENSITIVE_PATH, 40);

    expect(res?.status).toBe(429);
    expect(res?.body.success).toBe(false);
    expect(res?.body.error).toBeDefined();
    expect(res?.body.error.code).toBe("RATE_LIMITED");
    expect(res?.body.error.retryable).toBe(true);
    expect(typeof res?.body.error.message).toBe("string");
    expect(res?.body.error.message.length).toBeGreaterThan(0);
    // The literal key must never reach a user — `t()` echoes unknown keys back,
    // and "RATE_LIMITED" had no catalog entry at all before this change.
    expect(res?.body.error.message).not.toBe("RATE_LIMITED");
  });

  it("carries a numeric retryAfter and the matching Retry-After header", async () => {
    const res = await drive(app, SENSITIVE_PATH, 40);

    expect(res?.status).toBe(429);
    expect(typeof res?.body.error.retryAfter).toBe("number");
    expect(res?.body.error.retryAfter).toBeGreaterThanOrEqual(0);

    const header = res?.headers["retry-after"];
    expect(header).toBeDefined();
    expect(Number(header)).toBe(res?.body.error.retryAfter);
  });

  it("keeps the legacy top-level `message` so existing clients still parse it", async () => {
    const res = await drive(app, SENSITIVE_PATH, 40);

    // The migration is additive on purpose: the web, iOS and Android clients
    // all read `data.message` today. Dropping it would break them all at once.
    expect(typeof res?.body.message).toBe("string");
    expect(res?.body.message).toBe(res?.body.error.message);
  });

  it("echoes the request id so a user-reported 429 can be traced", async () => {
    const requestId = "trace-me-0123456789";
    const res = await drive(app, SENSITIVE_PATH, 40, {
      "x-request-id": requestId,
    });

    expect(res?.status).toBe(429);
    expect(res?.body.error.requestId).toBe(requestId);
    expect(res?.headers["x-request-id"]).toBe(requestId);
  });
});

describe("gateway limiter scoping", () => {
  it("gives two sessions on the SAME IP independent quotas", async () => {
    // The regression this pins: with IP-only bucketing, user B was throttled by
    // user A's traffic purely for sharing an office/CGNAT address. supertest
    // sources every request from the same address, so if the quota were still
    // IP-keyed, B would inherit A's exhausted bucket immediately.
    const app = buildApp();
    const tokenA = makeAccessToken({ userId: "user-a" });
    const tokenB = makeAccessToken({ userId: "user-b" });

    // Drive session A's global bucket hard.
    for (let i = 0; i < 30; i += 1) {
      await request(app)
        .get("/api/v1/users/me")
        .set("Authorization", `Bearer ${tokenA}`);
    }

    const first = await request(app)
      .get("/api/v1/users/me")
      .set("Authorization", `Bearer ${tokenB}`);

    expect(first.status).not.toBe(429);
  });

  it("does not let an anonymous caller escape limiting by omitting the header", async () => {
    // `session` scope falls back to the IP bucket when there is no credential,
    // so an unauthenticated flood is still bounded.
    const app = buildApp();
    const res = await drive(app, SENSITIVE_PATH, 40);
    expect(res?.status).toBe(429);
  });
});
