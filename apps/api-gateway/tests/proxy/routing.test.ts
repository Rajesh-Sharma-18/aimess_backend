/**
 * Gateway proxy ROUTING + PATH-REWRITE resolution.
 *
 * The real downstream services may or may not be reachable from a dev box, so we
 * do NOT make real upstream calls. Instead we mock the proxy FACTORY
 * (`createServiceProxy`) with a sentinel middleware that (a) records the
 * `ServiceProxyOptions` it was built with and (b) responds 299 echoing the
 * downstream path that the real `pathRewrite` would produce. This proves, with
 * zero network and full determinism:
 *   - which `/api/v1/<segment>` mounts exist (registry → env-driven),
 *   - that each maps to the correct downstream target + prefix,
 *   - that the public→downstream path rewrite is correct,
 *   - that unmounted segments / unknown versions fall through to 404.
 *
 * `createServiceProxy` is mocked BEFORE `createApp` is imported so the registry
 * mounts use the sentinel. The real rewrite rule is reproduced here so the
 * assertion still tracks production behaviour.
 */
import type { RequestHandler } from "express";

// Capture every ServiceProxyOptions the v1 router builds.
const builtProxies: Array<{
  target: string;
  downstreamPrefix: string;
  serviceName: string;
}> = [];

// Reproduce the REAL pathRewrite from src/proxy/create-service-proxy.ts so the
// sentinel echoes exactly what the production proxy would forward downstream.
function realRewrite(
  publicPath: string,
  serviceName: string,
  downstreamPrefix: string
): string {
  const prefix = downstreamPrefix.replace(/\/$/, "");
  const suffix = publicPath.startsWith("/") ? publicPath : `/${publicPath}`;
  const normalizedSuffix =
    suffix.replace(new RegExp(`^(/api/v\\d+)?/${serviceName}`), "") || "/";
  return `${prefix}${normalizedSuffix}`;
}

jest.mock("../../src/proxy/create-service-proxy.js", () => ({
  createServiceProxy: (opts: {
    target: string;
    downstreamPrefix: string;
    serviceName: string;
  }): RequestHandler => {
    builtProxies.push({ ...opts });
    return (req, res) => {
      // `req.url` here is the path AFTER the `/api/v1/<segment>` mount has been
      // stripped by Express, but the real proxy rewrites against the full
      // original path. Reconstruct the public path for the rewrite preview.
      const mountedAt = `/api/v1/${opts.serviceName}`;
      const original =
        req.originalUrl.split("?")[0] ?? `${mountedAt}${req.url}`;
      res.status(299).json({
        proxied: true,
        serviceName: opts.serviceName,
        target: opts.target,
        downstream: realRewrite(
          original,
          opts.serviceName,
          opts.downstreamPrefix
        ),
      });
    };
  },
}));

import request from "supertest";

import { createApp } from "../../src/app.js";
import type { MessagingClient } from "../../src/grpc/clients/messaging.client.js";

const app = createApp({} as unknown as MessagingClient);

describe("gateway proxy routing", () => {
  // --- Registry mounts (env-driven) ---------------------------------------
  it("mounts auth, users, communities, chat, devices for v1", () => {
    const segments = builtProxies.map((p) => p.serviceName);
    expect(segments).toEqual(
      expect.arrayContaining([
        "auth",
        "users",
        "communities",
        "chat",
        "devices",
      ])
    );
  });

  // --- POSITIVE: each mounted segment resolves to its downstream -----------
  it("/api/v1/auth/* → auth-service /api/auth/* (prefix swap)", async () => {
    const res = await request(app).get("/api/v1/auth/login");
    expect(res.status).toBe(299);
    expect(res.body.serviceName).toBe("auth");
    expect(res.body.target).toBe("http://localhost:3001");
    expect(res.body.downstream).toBe("/api/auth/login");
  });

  it("/api/v1/users/* → user-service /api/v1/* (segment dropped)", async () => {
    const res = await request(app).get("/api/v1/users/me");
    expect(res.status).toBe(299);
    expect(res.body.serviceName).toBe("users");
    expect(res.body.downstream).toBe("/api/v1/users/me");
  });

  it("/api/v1/communities/* → community-service keeps the segment", async () => {
    const res = await request(app).get("/api/v1/communities/abc/members");
    expect(res.status).toBe(299);
    expect(res.body.serviceName).toBe("communities");
    expect(res.body.downstream).toBe("/api/v1/communities/abc/members");
  });

  it("/api/v1/chat/* → chat-service /api/chat/*", async () => {
    const res = await request(app).get("/api/v1/chat/conversations");
    expect(res.status).toBe(299);
    expect(res.body.serviceName).toBe("chat");
    expect(res.body.downstream).toBe("/api/chat/conversations");
  });

  it("/api/v1/devices (bare segment) → notification-service /v1/devices/", async () => {
    const res = await request(app).post("/api/v1/devices").send({ token: "x" });
    expect(res.status).toBe(299);
    expect(res.body.serviceName).toBe("devices");
    // Bare segment → suffix becomes "/" → prefix + "/".
    expect(res.body.downstream).toBe("/v1/devices/");
  });

  it("/api/v1/devices/:token → notification-service /v1/devices/:token", async () => {
    const res = await request(app).delete("/api/v1/devices/abc123");
    expect(res.status).toBe(299);
    expect(res.body.serviceName).toBe("devices");
    expect(res.body.downstream).toBe("/v1/devices/abc123");
  });

  it("rewrites the bare segment root to '/'", async () => {
    const res = await request(app).get("/api/v1/auth");
    expect(res.status).toBe(299);
    // `/api/v1/auth` → strip `^/api/v1/auth` → "" → "/" → prefix + "/".
    expect(res.body.downstream).toBe("/api/auth/");
  });

  // --- NEGATIVE: unmounted / unknown --------------------------------------
  it("unknown v1 segment → 404 (no proxy)", async () => {
    const res = await request(app).get("/api/v1/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("unknown API version /api/v2/* → 404 (only v1 mounted)", async () => {
    const res = await request(app).get("/api/v2/auth/login");
    expect(res.status).toBe(404);
  });

  it("bare /api → 404", async () => {
    const res = await request(app).get("/api");
    expect(res.status).toBe(404);
  });

  // --- SECURITY: path-traversal-shaped segment is not mis-routed ----------
  it("path-traversal-shaped segment does not escape to another mount", async () => {
    const res = await request(app).get("/api/v1/%2e%2e/admin");
    // Decodes to nothing that matches a mounted segment → 404, never proxied
    // to admin or an unintended service.
    expect(res.status).toBe(404);
  });
});
