/**
 * Suite: the SRS hook does not exempt rendition names.
 *
 * `POST /internal/srs/hooks` used to short-circuit any stream name ending in
 * `_1080p` / `_720p` / `_480p` / `_360p` with a bare `0` — SRS's "allow" — before
 * any DB lookup, publish-secret check or ownership check. Those are exactly the
 * public rendition URLs `buildHlsQualityUrls` / `buildFlvQualityUrls` hand every
 * viewer, derived from the public `playbackId`, so every rung of a live stream's
 * quality ladder was publishable by anyone who could read that id out of their
 * own player.
 *
 * Nothing legitimate needed the exemption: renditions never reach this hook. On
 * the server they come from external ffmpeg workers pushing into I-03, which runs
 * no http_hooks (docs/calls/SRS-Server-Snapshot-2026-08-04.md §1); locally the
 * transcode block publishes into `vhost abr`, which likewise has none
 * (docker/srs/aimess.conf).
 *
 * This is the only route-level test in the service — every other suite constructs
 * service classes directly. The router is driven with minimal fake req/res rather
 * than supertest so no new dependency is needed; it still exercises the real
 * Express routing, the real secret guard and the real handler.
 */
import type { IRouter } from "express";

import { createInternalRoutes } from "../../src/routes/internal.routes.js";

// Matches tests/setup/env.ts.
const HOOK_SECRET = "test-srs-hook-secret-do-not-use-in-prod";

/** Drive the router once; resolves with the status + JSON body it wrote. */
function postHook(
  router: IRouter,
  body: Record<string, unknown>,
  { secret = HOOK_SECRET }: { secret?: string | null } = {}
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    let status = 200;
    const req = {
      method: "POST",
      url: secret === null ? "/srs/hooks" : `/srs/hooks?secret=${secret}`,
      originalUrl: "/internal/srs/hooks",
      headers: {},
      body,
      query: secret === null ? {} : { secret },
      ip: "203.0.113.9",
    };
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: unknown) {
        resolve({ status, body: payload });
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
    handlePublish: jest.fn().mockResolvedValue(true),
    handleUnpublish: jest.fn().mockResolvedValue(undefined),
    incrementViewer: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("POST /internal/srs/hooks — rendition names are not exempt", () => {
  it.each(["_1080p", "_720p", "_480p", "_360p"])(
    "routes a %s name through handlePublish instead of allowing it outright",
    async (suffix) => {
      // handlePublish denies an unknown name; the point is that it is CONSULTED.
      const service = makeService({
        handlePublish: jest.fn().mockResolvedValue(false),
      });
      const router = createInternalRoutes(service as never);

      const res = await postHook(router, {
        action: "on_publish",
        app: "live",
        stream: `public-id${suffix}`,
      });

      // 1 = deny.
      expect(res.body).toBe(1);
      expect(service.handlePublish).toHaveBeenCalledWith(
        `public-id${suffix}`,
        undefined,
        { secret: "" }
      );
    }
  );

  it("forwards the publish secret for a rendition name, like any other name", async () => {
    const service = makeService();
    const router = createInternalRoutes(service as never);

    await postHook(router, {
      action: "on_publish",
      app: "live",
      stream: "public-id_720p",
      client_id: "c-1",
      param: "?secret=the-real-secret",
    });

    expect(service.handlePublish).toHaveBeenCalledWith("public-id_720p", "c-1", {
      secret: "the-real-secret",
    });
  });

  it("still allows a publish the service authorises", async () => {
    const service = makeService();
    const router = createInternalRoutes(service as never);

    const res = await postHook(router, {
      action: "on_publish",
      app: "live",
      stream: "public-id",
      param: "?secret=the-real-secret",
    });

    expect(res.body).toBe(0);
  });

  it("rejects a hook with no shared secret before reading the body", async () => {
    const service = makeService();
    const router = createInternalRoutes(service as never);

    const res = await postHook(
      router,
      { action: "on_publish", stream: "public-id_720p" },
      { secret: null }
    );

    expect(res.status).toBe(403);
    expect(res.body).toBe(1);
    expect(service.handlePublish).not.toHaveBeenCalled();
  });

  it("rejects a hook with the wrong shared secret", async () => {
    const service = makeService();
    const router = createInternalRoutes(service as never);

    const res = await postHook(
      router,
      { action: "on_publish", stream: "public-id_720p" },
      { secret: "wrong-secret-of-the-same-sort" }
    );

    expect(res.status).toBe(403);
    expect(service.handlePublish).not.toHaveBeenCalled();
  });

  it("denies on_publish when the service throws (fail-closed on publish only)", async () => {
    const service = makeService({
      handlePublish: jest.fn().mockRejectedValue(new Error("db down")),
    });
    const router = createInternalRoutes(service as never);

    const res = await postHook(router, {
      action: "on_publish",
      stream: "public-id",
    });

    expect(res.body).toBe(1);
  });
});
