/**
 * Smoke test — proves the chat-service Express app boots under the harness and
 * serves its public health route, with every real-infra seam mocked.
 *
 * chat-service does not export a ready-built `app`; `src/server.ts` wires the
 * full DI graph at startup (touching Mongo/Redis/MinIO/gRPC). For an
 * import-only boot we instead drive the `createApp(controllers)` factory from
 * `src/app.js` directly, passing a Proxy of no-op controllers. The route
 * factories reference `controller.method` as handler functions at mount time,
 * so each controller must expose callable members — the Proxy supplies them.
 *
 * The `/health` route depends on no controller, so a 200 here proves routing,
 * middleware (helmet, cors, json, locale), route mounting and the error handler
 * all assemble cleanly.
 */
import request from "supertest";

import { createApp } from "../src/app.js";
import type { Controllers } from "../src/api/routes/index.js";

/** A controller whose every accessed member is a no-op Express handler. */
function noopController(): unknown {
  return new Proxy(
    {},
    {
      get: () => (_req: unknown, res: { status: (n: number) => unknown }) =>
        (res.status(200) as { json: (b: unknown) => void }).json({
          success: true,
        }),
    }
  );
}

/** A Controllers object where each controller is a no-op Proxy. */
function noopControllers(): Controllers {
  return new Proxy(
    {},
    {
      get: () => noopController(),
    }
  ) as unknown as Controllers;
}

describe("chat-service smoke", () => {
  const app = createApp(noopControllers());

  it("GET /health returns 200 with the service identity envelope", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      service: "chat-service",
    });
    expect(typeof res.body.timestamp).toBe("string");
  });

  it("an unknown route does not crash the app (boots cleanly)", async () => {
    const res = await request(app).get("/definitely-not-a-route");
    // No route matches; Express returns 404 (proves the app assembled and the
    // request pipeline runs end-to-end without throwing).
    expect(res.status).toBe(404);
  });
});
