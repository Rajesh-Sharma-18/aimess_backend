/**
 * Smoke test — proves the community-service Express app boots under the harness
 * (env validated, every I/O seam mocked) and serves its public health route.
 *
 * `GET /health` is mounted before the authenticated `/api/v1/communities`
 * router and only depends on `env`, so it needs no token. A 200 here means
 * importing `src/app.js` touched no real infra and pulled in no ESM-only lib.
 *
 * NOTE: community-service exports the app as a *named* export `app`
 * (`export const app`), not a default — unlike auth-service.
 */
import request from "supertest";

import { app } from "../src/app.js";

describe("community-service smoke", () => {
  it("GET /health → 200 with the service envelope", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.service).toBe("community-service");
    expect(res.body.environment).toBe("test");
  });

  it("unknown route → 404 (app + error handler wired)", async () => {
    const res = await request(app).get("/does-not-exist");

    expect(res.status).toBe(404);
  });
});
