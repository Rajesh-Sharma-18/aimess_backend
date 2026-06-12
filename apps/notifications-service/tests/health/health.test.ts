/**
 * GET /health — public liveness/identity probe. Mounted unconditionally in
 * src/app.ts, no auth, no body. Verifies the full identity envelope shape from
 * src/routes/health.routes.ts and that it is publicly reachable.
 */
import request from "supertest";

import { app } from "../../src/app.js";

describe("GET /health", () => {
  it("returns 200 with the full service identity envelope", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        success: true,
        service: "notifications-service",
        title: "Notifications Service",
        environment: "test",
      })
    );
    // timestamp is a valid ISO-8601 string.
    expect(typeof res.body.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(res.body.timestamp))).toBe(false);
  });

  it("is reachable without any Authorization header (public)", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });

  it("returns 404 for an unknown path", async () => {
    const res = await request(app).get("/health/nope");
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unmounted top-level path", async () => {
    const res = await request(app).get("/does-not-exist");
    expect(res.status).toBe(404);
  });
});
