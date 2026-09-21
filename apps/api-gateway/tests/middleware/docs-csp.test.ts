/**
 * The docs pages load a third-party viewer bundle and bootstrap it from an
 * inline script, so they cannot live under the API origin's strict CSP. The
 * `/docs` helmet mount only declines to SET the header — the strict mount that
 * follows it still ran for `/docs`, which re-applied the policy and left the
 * AsyncAPI and Swagger viewers rendering a blank page. These assertions pin
 * both halves: docs exempt, everything else strict.
 */
import request from "supertest";

import { createApp } from "../../src/app.js";
import type { MessagingClient } from "../../src/grpc/clients/messaging.client.js";

const app = createApp({} as unknown as MessagingClient);

describe("Content-Security-Policy", () => {
  // The docs modules are mocked out under jest (they read `import.meta.url`),
  // so these two routes 404 here — the header, not the body, is what is pinned.
  it("is not applied to the docs pages", async () => {
    const res = await request(app).get("/docs/socket");
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });

  it("is not applied to the raw AsyncAPI spec", async () => {
    const res = await request(app).get("/docs/socket/asyncapi.yaml");
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });

  it("still locks down the API routes", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["content-security-policy"]).toContain(
      "default-src 'none'"
    );
    expect(res.headers["content-security-policy"]).toContain(
      "script-src 'self'"
    );
  });

  it("does not exempt a path that merely starts with the word docs", async () => {
    const res = await request(app).get("/docsomething");
    expect(res.headers["content-security-policy"]).toContain(
      "default-src 'none'"
    );
  });
});
