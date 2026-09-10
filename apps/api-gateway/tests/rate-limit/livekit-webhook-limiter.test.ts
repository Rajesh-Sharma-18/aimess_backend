/**
 * POST /livekit/webhook is the ONLY channel that reconciles a call once its
 * media session ends, and it was metered by the global limiter.
 *
 * LiveKit Cloud sends its signature as `Authorization: <jwt>` with no `Bearer `
 * prefix, so `credentialKey` finds no credential and the session-scoped global
 * limiter falls back to one IP bucket for LiveKit's egress address, capped at
 * GLOBAL_RATE_LIMIT_MAX. LiveKit emits ~10-14 events per call, so a handful of
 * concurrent calls exhausted the window. What made that serious rather than
 * annoying is what a dropped `room_finished` / `participant_left` costs:
 * nothing else settles the Call row, so both participants stay "busy" and
 * cannot place or receive a call until the 3h stale-IN_PROGRESS sweep.
 *
 * The suite pins its own global ceiling rather than inheriting one, for the
 * reason `stream-limiter.test.ts` documents — with a large `*_RATE_LIMIT_MAX`
 * in the environment, an assertion like case 1 passes vacuously.
 *
 * Signature verification is expected to FAIL on every request here: these are
 * unsigned bodies, so the route answers 401 `invalid_signature`. That is the
 * signal the whole suite reads. A 401 means the request reached the handler,
 * i.e. the limiter let it through. A 429 means it did not.
 */
process.env.GLOBAL_RATE_LIMIT_MAX = "3";

import request from "supertest";

import { createApp } from "../../src/app.js";
import type { MessagingClient } from "../../src/grpc/clients/messaging.client.js";
import type { MediaClient } from "../../src/grpc/clients/media.client.js";

const WEBHOOK_PATH = "/livekit/webhook";
const GLOBAL_MAX = 3;
/** Mirrors `livekitWebhookRateLimiter` in src/middleware/rate-limit.ts. */
const WEBHOOK_POLICY = "3000;w=60";

function buildApp() {
  return createApp(
    {} as unknown as MessagingClient,
    {} as unknown as MediaClient
  );
}

/**
 * One webhook POST in the shape LiveKit actually sends: the signed-JWT content
 * type, and the signature on a bare `Authorization` header with NO `Bearer `
 * prefix. The prefix matters — it is precisely why these requests fell to the
 * IP bucket instead of a per-credential one.
 */
function postWebhook(
  app: ReturnType<typeof buildApp>,
  auth = "not-a-real-livekit-jwt"
) {
  return request(app)
    .post(WEBHOOK_PATH)
    .set("Content-Type", "application/webhook+json")
    .set("Authorization", auth)
    .send("{}");
}

describe("LiveKit webhook rate limiting", () => {
  it("does not count webhooks against the global bucket", async () => {
    const app = buildApp();
    const seen: number[] = [];
    // Comfortably past the pinned global ceiling of 3. Before the exemption,
    // requests 4 onward came back 429 and the call never reconciled.
    for (let i = 0; i < GLOBAL_MAX + 7; i += 1) {
      const res = await postWebhook(app);
      seen.push(res.status);
    }

    expect(seen).not.toContain(429);
    // Every one reached the handler and was rejected on its signature, which is
    // what "the limiter let it through" looks like from outside.
    expect([...new Set(seen)]).toEqual([401]);
  });

  it("meters webhooks in their own bucket rather than merely exempting them", async () => {
    const res = await postWebhook(buildApp());

    // express-rate-limit returns before setting any header when a limiter
    // skips, so the presence of a policy header proves a limiter ran — and the
    // VALUE proves which one. The global bucket would read "3;w=60" here.
    // This fails if either half of the fix is reverted: drop the dedicated
    // limiter and the header is absent, drop the exemption and it is the
    // global one's.
    expect(res.headers["ratelimit-policy"]).toBe(WEBHOOK_POLICY);
  });

  it("buckets by IP, not by the Authorization value", async () => {
    const app = buildApp();

    const first = await postWebhook(app, "signature-alpha");
    const second = await postWebhook(app, "signature-beta");

    expect(first.headers["ratelimit-policy"]).toBe(WEBHOOK_POLICY);
    expect(second.headers["ratelimit-policy"]).toBe(WEBHOOK_POLICY);

    // Two different Authorization values share one counter, so the second
    // request sees one fewer remaining. Under a session scope each header value
    // would open its own bucket and both would report the same figure — which
    // is the arrangement that let the global limiter's accounting drift.
    const remainingOf = (res: request.Response) =>
      Number(
        /remaining=(\d+)/.exec(res.headers["ratelimit"] ?? "")?.[1] ?? "NaN"
      );
    const firstRemaining = remainingOf(first);
    const secondRemaining = remainingOf(second);

    expect(Number.isFinite(firstRemaining)).toBe(true);
    expect(secondRemaining).toBe(firstRemaining - 1);
  });
});
