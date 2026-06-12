/**
 * Smoke test — proves the notifications-service Express app boots under the
 * harness (env validates, all I/O seams mocked, no real infra or ESM-only
 * native lib loaded) by hitting the public GET /health route.
 *
 * `GET /health` is mounted unconditionally in `src/app.ts` and returns the
 * service identity envelope:
 *   { success: true, service, title, environment, timestamp }
 */
import request from "supertest";

// notifications-service exports `app` as a NAMED export (no default), unlike
// auth-service's `export default app`.
import { app } from "../src/app.js";

describe("notifications-service smoke", () => {
  it("GET /health → 200 with the service identity envelope", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.service).toBe("notifications-service");
    expect(res.body.environment).toBe("test");
  });
});
