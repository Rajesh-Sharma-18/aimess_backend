/**
 * The SRS hook proxy must give up on a wedged stream-service.
 *
 * `on_publish` is what tells SRS whether to accept a broadcast, so SRS is
 * blocked on this response. With no timeout on the upstream fetch, a stuck
 * stream-service held open both this handler and SRS's own hook connection
 * indefinitely, and under load those pile up.
 *
 * Worth noting what this file is: `srs-hook-url.test.ts` next door imports only
 * the `srsHookUrl` string helper and never invokes the route, so until now the
 * handler itself — the secret check, the forwarding, the 503 path — had no
 * coverage at all, and a timeout added there would have been invisible to CI in
 * both directions.
 */
import express from "express";
import request from "supertest";

import { createInternalSrsRouter } from "../../src/routes/internal-srs.routes.js";

const HOOK_PATH = "/internal/srs/hooks";
const SECRET = "test-srs-hook-secret";
const BODY = { action: "on_publish", app: "live", stream: "public-id" };

function buildApp() {
  const app = express();
  app.use("/internal", createInternalSrsRouter());
  return app;
}

/** Send one hook request with the shared secret in the query, as SRS does. */
function postHook(app: express.Express) {
  return request(app).post(`${HOOK_PATH}?secret=${SECRET}`).send(BODY);
}

const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
  jest.useRealTimers();
});

describe("SRS hook proxy — upstream timeout", () => {
  it("answers 503 instead of hanging when stream-service never responds", async () => {
    // A fetch that only ever settles by abort — i.e. a wedged upstream.
    global.fetch = jest.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          );
        })
    ) as unknown as typeof fetch;

    const res = await postHook(buildApp());

    expect(res.status).toBe(503);
  }, 20_000);

  it("passes an AbortSignal to the upstream call", async () => {
    // The mechanism, pinned directly: without a signal there is no deadline,
    // and the case above would pass for the wrong reason if the upstream
    // happened to reject on its own.
    const fetchMock = jest.fn(async () => new Response("0", { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await postHook(buildApp());

    const init = fetchMock.mock.calls[0]?.[1] as
      | { signal?: AbortSignal }
      | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("still forwards a healthy upstream's status and body verbatim", async () => {
    // SRS reads the body as a bare integer: 0 allows the publish, non-zero
    // denies it. Mangling it here would allow a publish the backend refused.
    global.fetch = jest.fn(
      async () =>
        new Response("1", {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    ) as unknown as typeof fetch;

    const res = await postHook(buildApp());

    expect(res.status).toBe(200);
    expect(res.text).toBe("1");
  });

  it("rejects a hook with no secret before calling upstream at all", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await request(buildApp()).post(HOOK_PATH).send(BODY);

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
