/**
 * Integration tests — health + debug routes.
 * Route file: apps/chat-service/src/api/routes/health.routes.ts (mounted at /).
 *
 * AUDIT H1 — the unauthenticated `GET /debug/snapshot/:userId` route leaked
 * user identity (displayName/username/account) to anyone and wiped the Redis
 * snapshot cache (a cache-poison / gRPC-fan-out DoS vector). It has been
 * removed; these tests pin that it no longer responds.
 */
import request from "supertest";

import { buildApp } from "../helpers/app-factory.js";

let app: import("express").Express;

beforeEach(() => {
  ({ app } = buildApp());
});

describe("GET /health", () => {
  it("POSITIVE: returns the service identity envelope", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, service: "chat-service" });
  });
});

describe("GET /debug/snapshot/:userId (removed — AUDIT H1)", () => {
  it("SECURITY: the unauthenticated debug snapshot route no longer exists (404)", async () => {
    const res = await request(app).get(
      "/debug/snapshot/11111111-1111-4111-8111-111111111111"
    );

    // Route deleted → Express has no match → 404 (not a 200 identity leak).
    expect(res.status).toBe(404);
  });
});
