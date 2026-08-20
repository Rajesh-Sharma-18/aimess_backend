/**
 * /admin/* edge router. The gateway proxies admin traffic to backoffice-service,
 * but the EDGE controls run on the gateway itself and are what we assert here:
 *
 *   adminRateLimiter → adminIpAllowlist → (sensitive: adminLoginRateLimiter)
 *     → adminJwt (skips PUBLIC_ADMIN_PATHS) → proxy → backoffice-service
 *
 * In the test env: ADMIN_IP_WHITELIST is empty (allow-all), BACKOFFICE_SERVICE_URL
 * is set (so the proxy mounts). The actual backoffice upstream may or may not be
 * reachable from a dev box, so we DO NOT assert a specific proxied status. The
 * edge rejects with exactly these gateway-authored messages:
 *     "Authentication token is required." | "Invalid authentication token." |
 *     "Authentication token has expired." | "Admin auth not configured"
 * When the edge ACCEPTS, the request is proxied and the body comes from
 * downstream (a 502 graceful error if the upstream is down, or the real service
 * response if up) — and is NEVER one of those edge messages. We therefore prove
 * accept-vs-reject deterministically by checking for the edge-rejection envelope,
 * independent of whether a backoffice happens to be running locally.
 *
 * Admin tokens are HS256 over JWT_ADMIN_SECRET (see middleware/admin-jwt.ts).
 */
import request from "supertest";

import { createApp } from "../../src/app.js";
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
  it("valid admin token passes the edge (proxied, NOT an edge 401)", async () => {
    const res = await request(app).get(PROTECTED).set(bearer(makeAdminToken()));

    // Edge accepted → request was proxied. The proxied status varies with
    // whether a backoffice is reachable, but it must NOT be a gateway-edge
    // rejection — a 401 with an edge message would mean the edge wrongly
    // rejected a valid token.
    expect(isEdgeRejection(res)).toBe(false);
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
