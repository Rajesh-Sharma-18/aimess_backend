/**
 * /health liveness route + a few gateway-wide behaviours that are easiest to
 * assert here: the request-id middleware (uuid stub), the global rate limiter's
 * health-skip exemption, and the catch-all 404 for unmounted paths.
 */
import request from "supertest";

import { createApp } from "../../src/app.js";
import type { MessagingClient } from "../../src/grpc/clients/messaging.client.js";

const app = createApp({} as unknown as MessagingClient);

describe("/health", () => {
  it("GET /health → 200 running envelope", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: "API Gateway Running",
    });
  });

  it("sets an x-request-id response header (request-id middleware)", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-request-id"]).toBeDefined();
    // uuid v4 (crypto.randomUUID-backed stub) shape.
    expect(res.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("mints a fresh request id per request", async () => {
    const a = await request(app).get("/health");
    const b = await request(app).get("/health");
    expect(a.headers["x-request-id"]).not.toBe(b.headers["x-request-id"]);
  });

  it("health is exempt from the global rate limiter (many rapid hits all 200)", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => request(app).get("/health"))
    );
    for (const r of results) {
      expect(r.status).toBe(200);
    }
  });

  it("hides x-powered-by (app.disable)", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("sets helmet security headers", async () => {
    const res = await request(app).get("/health");
    // helmet() default adds these; CSP is disabled by config, but these remain.
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-dns-prefetch-control"]).toBeDefined();
  });

  it("unknown top-level path → 404", async () => {
    const res = await request(app).get("/totally-unknown-path");
    expect(res.status).toBe(404);
  });

  it("POST /health (no POST handler) → 404", async () => {
    const res = await request(app).post("/health").send({});
    expect(res.status).toBe(404);
  });
});
