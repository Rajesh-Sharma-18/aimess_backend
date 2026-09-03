/**
 * Smoke test — proves the real Express app boots under the harness (env +
 * global I/O mocks) and serves its public liveness route. No auth, no DB:
 * `GET /health` returns a static JSON liveness envelope.
 *
 * backoffice-service exports the app as a NAMED `app` (createApp() result),
 * not as a default export.
 */
import request from "supertest";

import { app } from "../src/app.js";

describe("backoffice-service smoke", () => {
  it("GET /health → 200 liveness envelope, and nothing else (AIM-86)", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // This route is mounted above the admin guards and the admin vhost proxies
    // every path here, so it answers unauthenticated callers from anywhere. It
    // used to name the service and disclose NODE_ENV, which told an attacker
    // that the admin service lives at that hostname and which environment it
    // is — reconnaissance for free. The liveness answer is now the verdict
    // alone.
    expect(res.body.service).toBeUndefined();
    expect(res.body.title).toBeUndefined();
    expect(res.body.environment).toBeUndefined();
  });

  it("GET /v1/health → 200 (gateway-proxied liveness path)", async () => {
    const res = await request(app).get("/v1/health");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("unmatched top-level route → 404 JSON, never HTML", async () => {
    // A path outside `/v1` (and `/health`) falls straight through to the
    // terminal `notFound` handler, proving it emits JSON, not an HTML page.
    const res = await request(app).get("/totally-unknown");

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("unauthenticated admin route → 401 JSON via the error handler", async () => {
    // Self-prefixed admin routers run `adminAuth` for every fall-through
    // `/v1/*` path; with no Bearer token the gate rejects with the standard
    // error envelope before any handler runs. Exercises real auth + the
    // central error handler.
    const res = await request(app).get("/v1/does-not-exist");

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});
