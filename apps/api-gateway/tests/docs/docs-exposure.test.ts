/**
 * Which docs pages the gateway mounts, per environment.
 *
 * Production used to 404 every docs path because both viewers sat behind one
 * `NODE_ENV !== "production"` guard. The Socket.IO contract is now switchable
 * on its own (SOCKET_DOCS_ENABLED) while Swagger keeps the old rule, so these
 * cases pin the whole matrix: defaults, the explicit opt-in, the explicit
 * opt-out, and that opting the socket docs in never drags Swagger or its CSP
 * exemption along.
 *
 * `src/docs/asyncapi.ts` is unparseable under CommonJS Jest (`import.meta`),
 * so it is replaced here by a stand-in that mounts the same two paths. The
 * real page, spec and assets are verified against a running gateway instead.
 */
import type { Express } from "express";
import request from "supertest";

// Each case re-imports the whole app graph; a cold ts-jest compile of it can
// outrun the default timeout on the first case.
jest.setTimeout(90_000);

type EnvPatch = Record<string, string | undefined>;

const PRODUCTION: EnvPatch = {
  NODE_ENV: "production",
  CORS_ALLOWED_ORIGINS: "https://app.example.com",
  CORS_ALLOW_ANY_ORIGIN: "false",
  RATE_LIMIT_ENABLED: "true",
  RATE_LIMIT_STORE: "redis",
  BACKOFFICE_SERVICE_URL: "http://backoffice:3010",
  JWT_ADMIN_SECRET: "test-admin-secret-do-not-use-in-prod",
  ADMIN_IP_WHITELIST: "203.0.113.10",
};

const DEVELOPMENT: EnvPatch = {
  NODE_ENV: "development",
  // The rate limiter would reach for Redis on every request otherwise.
  RATE_LIMIT_ENABLED: "false",
};

/** Build a fresh app under `patch`. `""` means "not configured" (see env-guards). */
async function appWith(patch: EnvPatch): Promise<Express> {
  const original = { ...process.env };
  Object.assign(process.env, patch);
  let app: Express | undefined;
  try {
    await jest.isolateModulesAsync(async () => {
      jest.doMock("../../src/docs/asyncapi.js", () => ({
        setupAsyncApiDocs: (a: Express) => {
          a.get(["/docs/socket", "/docs/socket/"], (_req, res) => {
            res.type("html").send("<div id=asyncapi></div>");
          });
          a.get("/docs/socket/asyncapi.yaml", (_req, res) => {
            res.type("application/yaml").send("asyncapi: 3.0.0\n");
          });
        },
      }));
      const { createApp } = await import("../../src/app.js");
      app = createApp({} as never, {} as never);
    });
  } finally {
    process.env = original;
  }
  return app!;
}

describe("docs exposure", () => {
  it("development: socket docs and Swagger are both served", async () => {
    const app = await appWith({ ...DEVELOPMENT, SOCKET_DOCS_ENABLED: "" });

    expect((await request(app).get("/docs/socket")).status).toBe(200);
    expect(
      (await request(app).get("/docs/socket/asyncapi.yaml")).status
    ).toBe(200);
    expect((await request(app).get("/docs/v1/openapi.json")).status).toBe(200);
  });

  it("development: SOCKET_DOCS_ENABLED=false turns off only the socket docs", async () => {
    const app = await appWith({ ...DEVELOPMENT, SOCKET_DOCS_ENABLED: "false" });

    expect((await request(app).get("/docs/socket")).status).toBe(404);
    expect((await request(app).get("/docs/v1/openapi.json")).status).toBe(200);
  });

  it("production default: every docs path 404s and keeps the strict CSP", async () => {
    const app = await appWith({ ...PRODUCTION, SOCKET_DOCS_ENABLED: "" });

    for (const path of [
      "/docs/socket",
      "/docs/socket/asyncapi.yaml",
      "/docs/v1",
      "/docs/v1/openapi.json",
    ]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(404);
      expect(res.headers["content-security-policy"]).toContain(
        "default-src 'none'"
      );
    }
  });

  it("production + SOCKET_DOCS_ENABLED=false: socket docs stay off", async () => {
    const app = await appWith({ ...PRODUCTION, SOCKET_DOCS_ENABLED: "false" });
    expect((await request(app).get("/docs/socket")).status).toBe(404);
  });

  it("production + SOCKET_DOCS_ENABLED=true: socket docs served, Swagger still off", async () => {
    const app = await appWith({ ...PRODUCTION, SOCKET_DOCS_ENABLED: "true" });

    const page = await request(app).get("/docs/socket");
    expect(page.status).toBe(200);
    // The viewer needs its off-origin bundle and inline bootstrap.
    expect(page.headers["content-security-policy"]).toBeUndefined();

    const spec = await request(app).get("/docs/socket/asyncapi.yaml");
    expect(spec.status).toBe(200);
    expect(spec.headers["content-type"]).toContain("application/yaml");

    // Enabling the socket docs must not expose Swagger, nor widen the CSP
    // exemption to the rest of /docs.
    for (const path of ["/docs", "/docs/v1", "/docs/v1/openapi.json"]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(404);
      expect(res.headers["content-security-policy"]).toContain(
        "default-src 'none'"
      );
    }
    // A sibling that merely shares the prefix is not exempt either.
    const sibling = await request(app).get("/docs/socketx");
    expect(sibling.headers["content-security-policy"]).toContain(
      "default-src 'none'"
    );
  });

  it("production + SOCKET_DOCS_ENABLED=true: API routes keep the strict policy", async () => {
    const app = await appWith({ ...PRODUCTION, SOCKET_DOCS_ENABLED: "true" });

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toContain(
      "default-src 'none'"
    );
  });
});
