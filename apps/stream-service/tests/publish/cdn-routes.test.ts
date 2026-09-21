/**
 * The CDNetworks callback endpoints, at the wire level.
 *
 * These three URLs are pasted into the vendor console and are the only thing
 * standing between the public internet and our stream state machine, so the
 * contract is pinned here rather than discovered in production:
 *
 * - a missing or wrong `?secret=` is refused, and nothing request-controlled is
 *   read before that check;
 * - the console can be configured to send GET or POST, so parameters must be
 *   accepted from the query string and from a body;
 * - `/cdn/auth` gates whether a broadcast is accepted at all, so it answers
 *   `200`+`0` to allow and `403`+`1` to deny, and it fails CLOSED if our own
 *   handler throws.
 */
import type { IRouter } from "express";

import { createInternalCdnRoutes } from "../../src/routes/internal-cdn.routes.js";

// Matches tests/setup/env.ts.
const SECRET = "test-cdn-callback-secret-do-not-use-in-prod";

/** Drive the router once; resolves with the status + body it wrote. */
function call(
  router: IRouter,
  path: string,
  {
    method = "POST",
    query = {},
    body = {},
    secret = SECRET as string | null,
  }: {
    method?: string;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
    secret?: string | null;
  } = {}
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    let status = 200;
    const fullQuery = secret === null ? query : { ...query, secret };
    const search = new URLSearchParams(
      Object.entries(fullQuery).map(([k, v]) => [k, String(v)])
    ).toString();
    const req = {
      method,
      url: search ? `${path}?${search}` : path,
      originalUrl: `/internal${path}${search ? `?${search}` : ""}`,
      headers: {},
      get: () => undefined,
      body,
      query: fullQuery,
      ip: "203.0.113.9",
    };
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      send(payload: unknown) {
        resolve({ status, body: payload });
        return this;
      },
      type() {
        return this;
      },
    };
    (router as unknown as (q: unknown, s: unknown, n: () => void) => void)(
      req,
      res,
      () => reject(new Error("router did not handle the request"))
    );
  });
}

function makeService(overrides: Record<string, unknown> = {}) {
  return {
    handleCdnStart: jest.fn().mockResolvedValue(true),
    handleCdnEnd: jest.fn().mockResolvedValue(undefined),
    authorizeCdnPublish: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("CDN callbacks — the shared-secret gate", () => {
  it.each(["/cdn/start", "/cdn/end", "/cdn/auth"])(
    "refuses %s with no secret, without touching the service",
    async (path) => {
      const service = makeService();
      const res = await call(createInternalCdnRoutes(service as never), path, {
        secret: null,
        body: { id: "public-name" },
      });

      expect(res.status).toBe(403);
      expect(service.handleCdnStart).not.toHaveBeenCalled();
      expect(service.handleCdnEnd).not.toHaveBeenCalled();
      expect(service.authorizeCdnPublish).not.toHaveBeenCalled();
    }
  );

  it("refuses a wrong secret", async () => {
    const service = makeService();
    const res = await call(createInternalCdnRoutes(service as never), "/cdn/start", {
      secret: "not-the-secret",
      body: { id: "public-name" },
    });

    expect(res.status).toBe(403);
    expect(service.handleCdnStart).not.toHaveBeenCalled();
  });
});

describe("CDN stream status callbacks", () => {
  it("maps a POSTed start callback onto handleCdnStart", async () => {
    const service = makeService();
    const res = await call(createInternalCdnRoutes(service as never), "/cdn/start", {
      body: {
        id: "public-name",
        appname: "live",
        app: "push.example.com",
        ip: "198.51.100.4",
        node: "10.0.0.1",
        port: "1935",
        milltime: "1700000000000",
      },
    });

    expect(res.status).toBe(200);
    expect(res.body).toBe("0");
    expect(service.handleCdnStart).toHaveBeenCalledWith(
      "public-name",
      1_700_000_000_000
    );
  });

  it("accepts a GET-configured callback, parameters in the query", async () => {
    const service = makeService();
    await call(createInternalCdnRoutes(service as never), "/cdn/end", {
      method: "GET",
      query: { id: "public-name", appname: "live", milltime: "1700000000123" },
      body: {},
    });

    expect(service.handleCdnEnd).toHaveBeenCalledWith(
      "public-name",
      1_700_000_000_123
    );
  });

  it("falls back to the second-granularity timestamp when milltime is absent", async () => {
    // Every callback parameter is individually deselectable in the console.
    const service = makeService();
    await call(createInternalCdnRoutes(service as never), "/cdn/end", {
      body: { id: "public-name", time: "1700000000" },
    });

    expect(service.handleCdnEnd).toHaveBeenCalledWith(
      "public-name",
      1_700_000_000_000
    );
  });

  it("ignores a callback for a different application name", async () => {
    const service = makeService();
    const res = await call(createInternalCdnRoutes(service as never), "/cdn/start", {
      body: { id: "public-name", appname: "someone-elses-app" },
    });

    expect(res.body).toBe("0");
    expect(service.handleCdnStart).not.toHaveBeenCalled();
  });

  it("still answers 200 when the handler throws", async () => {
    // The vendor documents no retry, so a 5xx only loses the event and pages
    // someone; the reconciler is the actual safety net.
    const service = makeService({
      handleCdnStart: jest.fn().mockRejectedValue(new Error("db down")),
    });
    const res = await call(createInternalCdnRoutes(service as never), "/cdn/start", {
      body: { id: "public-name", milltime: "1" },
    });

    expect(res.status).toBe(200);
    expect(res.body).toBe("0");
  });
});

describe("CDN remote authentication", () => {
  it("allows with 200/0 and forwards the publish URL", async () => {
    const service = makeService();
    const res = await call(createInternalCdnRoutes(service as never), "/cdn/auth", {
      body: {
        streamName: "public-name",
        appName: "live",
        url: "/live/public-name?secret=the-real-secret",
      },
    });

    expect(res.status).toBe(200);
    expect(res.body).toBe("0");
    expect(service.authorizeCdnPublish).toHaveBeenCalledWith({
      streamName: "public-name",
      url: "/live/public-name?secret=the-real-secret",
    });
  });

  it("denies with 403/1", async () => {
    const service = makeService({
      authorizeCdnPublish: jest.fn().mockResolvedValue(false),
    });
    const res = await call(createInternalCdnRoutes(service as never), "/cdn/auth", {
      body: { streamName: "public-name" },
    });

    expect(res.status).toBe(403);
    expect(res.body).toBe("1");
  });

  it("fails CLOSED when the authorization check throws", async () => {
    // This endpoint is the only publish gate the CDN has: failing open would
    // put a banned host or an ended stream back on air.
    const service = makeService({
      authorizeCdnPublish: jest.fn().mockRejectedValue(new Error("redis down")),
    });
    const res = await call(createInternalCdnRoutes(service as never), "/cdn/auth", {
      body: { streamName: "public-name" },
    });

    expect(res.status).toBe(403);
    expect(res.body).toBe("1");
  });
});
