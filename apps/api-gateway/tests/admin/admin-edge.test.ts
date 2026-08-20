/**
 * /admin/* edge router. The gateway proxies admin traffic to backoffice-service,
 * but the EDGE controls run on the gateway itself and are what we assert here:
 *
 *   adminRateLimiter → adminIpAllowlist → (sensitive: adminLoginRateLimiter)
 *     → adminJwt (skips PUBLIC_ADMIN_PATHS) → proxy → backoffice-service
 *
 * In the test env: ADMIN_IP_WHITELIST is empty (allow-all), BACKOFFICE_SERVICE_URL
 * is set (so the proxy mounts). The actual backoffice upstream may or may not be
 * reachable from a dev box, so we DO NOT assert a specific proxied status.
 *
 * REJECTIONS are asserted over HTTP on `error.code` — UNAUTHORIZED,
 * AUTH_INVALID_TOKEN, AUTH_TOKEN_EXPIRED — never on the sentence, which is
 * localized per request.
 *
 * ACCEPTANCE is asserted by calling `adminJwt` directly. It used to be inferred
 * from "the response is not one of the edge's own messages", which worked only
 * while the gateway and backoffice-service happened to word their 401s
 * differently. They now share one error envelope, so a proxied 401 is
 * byte-identical to an edge 401 and no response-based check can separate them.
 * Calling the middleware asks the real question — does a valid token reach
 * `next()` — and is independent of whether a backoffice is running locally.
 *
 * Admin tokens are HS256 over JWT_ADMIN_SECRET (see middleware/admin-jwt.ts).
 */
import request from "supertest";

import { createApp } from "../../src/app.js";
import { adminJwt } from "../../src/middleware/admin-jwt.js";
import type { MessagingClient } from "../../src/grpc/clients/messaging.client.js";
import {
  bearer,
  makeAdminToken,
  makeExpiredAdminToken,
  makeForgedAdminToken,
} from "../helpers/auth.js";

const app = createApp({} as unknown as MessagingClient);

// A protected admin path (NOT in PUBLIC_ADMIN_PATHS).
const PROTECTED = "/admin/v1/users";
// A public admin path (login) — adminJwt skips it.
const PUBLIC_LOGIN = "/admin/v1/auth/login";

/** The exact codes the gateway edge (adminJwt) emits when it REJECTS. */
const EDGE_REJECTION_CODES = new Set([
  "UNAUTHORIZED",
  "AUTH_INVALID_TOKEN",
  "AUTH_TOKEN_EXPIRED",
  "AUTH_UNAUTHORIZED",
]);

/** True iff the response is a gateway-edge 401 rejection (not a proxied reply). */
function isEdgeRejection(res: { status: number; body: { code?: string } }) {
  return (
    res.status === 401 &&
    typeof res.body.code === "string" &&
    EDGE_REJECTION_CODES.has(res.body.code)
  );
}

/** Assert the shared error envelope, ignoring the localized sentence. */
function expectEdge401(
  res: { status: number; body: Record<string, unknown> },
  code: string
) {
  expect(res.status).toBe(401);
  expect(res.body.success).toBe(false);
  expect(res.body.code).toBe(code);
  expect(res.body.error).toMatchObject({
    statusCode: 401,
    code,
    retryable: false,
  });
  expect(typeof res.body.message).toBe("string");
}

describe("/admin/* edge — adminJwt", () => {
  // --- NEGATIVE: unauthenticated on a protected path -----------------------
  it("no Authorization header → 401 UNAUTHORIZED", async () => {
    const res = await request(app).get(PROTECTED);

    expectEdge401(res, "UNAUTHORIZED");
  });

  it("malformed header (no 'Bearer ' prefix) → 401", async () => {
    const res = await request(app)
      .get(PROTECTED)
      .set("Authorization", "Token abc.def.ghi");

    expectEdge401(res, "UNAUTHORIZED");
  });

  it("'Bearer ' with empty token → 401", async () => {
    const res = await request(app)
      .get(PROTECTED)
      .set("Authorization", "Bearer ");

    expectEdge401(res, "UNAUTHORIZED");
  });

  it("expired admin token → 401 Authentication token has expired.", async () => {
    const res = await request(app)
      .get(PROTECTED)
      .set(bearer(makeExpiredAdminToken()));

    expectEdge401(res, "AUTH_TOKEN_EXPIRED");
  });

  it("forged admin token (wrong secret) → 401 Invalid authentication token.", async () => {
    const res = await request(app)
      .get(PROTECTED)
      .set(bearer(makeForgedAdminToken()));

    expectEdge401(res, "AUTH_INVALID_TOKEN");
  });

  it("garbage (non-JWT) bearer token → 401", async () => {
    const res = await request(app)
      .get(PROTECTED)
      .set("Authorization", "Bearer not-a-jwt");

    expectEdge401(res, "AUTH_INVALID_TOKEN");
  });

  it("a USER access token (wrong audience/secret) is NOT a valid admin token → 401", async () => {
    // User tokens are signed with JWT_ACCESS_SECRET, not JWT_ADMIN_SECRET.
    const { makeAccessToken } = await import("../helpers/auth.js");
    const res = await request(app)
      .get(PROTECTED)
      .set(bearer(makeAccessToken()));

    expectEdge401(res, "AUTH_INVALID_TOKEN");
  });

  // --- POSITIVE: a valid admin token passes the edge -----------------------
  //
  // Driven through `adminJwt` directly rather than over HTTP. Now that every
  // service answers in ONE error envelope, a 401 from the proxied
  // backoffice-service is byte-identical to an edge 401 — same
  // `error.code: AUTH_INVALID_TOKEN`, same shape — so a response-based
  // discriminator cannot tell "the edge rejected me" from "the edge let me
  // through and the upstream rejected me". It only appeared to work while the
  // two services emitted different prose. Calling the middleware answers the
  // actual question (does a valid token reach `next()`?) and does not depend on
  // whether a backoffice happens to be running on the machine.
  function runAdminJwt(path: string, headers: Record<string, string> = {}) {
    const next = jest.fn();
    const res = {
      headersSent: false,
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Parameters<typeof adminJwt>[1];
    adminJwt(
      { headers, path, method: "GET" } as unknown as Parameters<
        typeof adminJwt
      >[0],
      res,
      next
    );
    return { next, res };
  }

  it("valid admin token passes the edge", () => {
    const { next, res } = runAdminJwt("/v1/users", {
      authorization: `Bearer ${makeAdminToken()}`,
    });

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("still rejects at the edge without a token", () => {
    const { next, res } = runAdminJwt("/v1/users");

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  // --- PUBLIC PATHS: adminJwt is skipped -----------------------------------
  it("public login path is reachable WITHOUT a token (skipped, then proxied)", async () => {
    const res = await request(app).post(PUBLIC_LOGIN).send({
      email: "admin@example.com",
      password: "secret",
    });

    // adminJwt skips PUBLIC_ADMIN_PATHS, so the unauthenticated request is
    // proxied rather than rejected with an edge 401.
    expect(isEdgeRejection(res)).toBe(false);
  });

  it("public forgot-password path is reachable without a token", async () => {
    const res = await request(app)
      .post("/admin/v1/auth/forgot-password")
      .send({ email: "admin@example.com" });

    expect(isEdgeRejection(res)).toBe(false);
  });

  // --- SECURITY: tampered token does not bypass the edge -------------------
  it("JWT tampering: altered payload (broken signature) → 401, never proxied", async () => {
    const good = makeAdminToken();
    const [h, , s] = good.split(".");
    // Swap in a forged payload; signature no longer matches.
    const tamperedPayload = Buffer.from(
      JSON.stringify({ sub: "attacker", role: "SUPER_ADMIN" })
    ).toString("base64url");
    const tampered = `${h}.${tamperedPayload}.${s}`;

    const res = await request(app)
      .get(PROTECTED)
      .set("Authorization", `Bearer ${tampered}`);

    expectEdge401(res, "AUTH_INVALID_TOKEN");
  });
});
