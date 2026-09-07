/**
 * The livestream REST surface had no limiter of its own — only the global
 * backstop, shared with every other call the same user makes. Unmetered until
 * now: `GET /streams/:id/comments` (up to 100 rows plus a user-service
 * enrichment round trip per page), `GET /streams/:id/viewers` (a whole-hash
 * read plus a bulk snapshot), and every moderation endpoint (one gRPC round
 * trip to community-service each).
 *
 * The half that actually needs pinning is the EXEMPTION. The bucket is
 * session-scoped and shared across everything the client sends to `/streams`,
 * so a viewer-heavy session could exhaust it and starve the broadcaster's
 * heartbeat — and a dropped heartbeat is not a retried read: the sweeper ends
 * the broadcast. The exemption is also the part most likely to be silently
 * wrong, because `req.path` inside a mounted limiter is MOUNT-RELATIVE: a
 * heartbeat arrives as `/<id>/heartbeat`, not `/api/v1/streams/<id>/heartbeat`,
 * so the `startsWith` idiom used elsewhere in that file would match nothing and
 * quietly do the opposite of what it says.
 *
 * This suite pins its own ceiling rather than inheriting one. The neighbouring
 * `envelope.test.ts` does not, and on a machine whose `.env` carries a large
 * `*_RATE_LIMIT_MAX` its assertions never trip — one of them passes vacuously
 * as a result.
 */
process.env.STREAM_RATE_LIMIT_MAX = "5";

import request from "supertest";

import { createApp } from "../../src/app.js";
import type { MessagingClient } from "../../src/grpc/clients/messaging.client.js";
import type { MediaClient } from "../../src/grpc/clients/media.client.js";
import { makeAccessToken } from "../helpers/auth.js";

const STREAM_ID = "a".repeat(24);
const LIMIT = 5;

function buildApp() {
  return createApp(
    {} as unknown as MessagingClient,
    {} as unknown as MediaClient
  );
}

/**
 * Send `count` requests as one session and report the statuses seen.
 *
 * The upstream stream-service is not running under test, so a request that gets
 * past the limiter fails at the proxy (502/503). That is fine and is exactly
 * the signal we want: reaching the proxy at all proves the limiter let it
 * through. Only a 429 proves it did not.
 */
async function send(
  app: ReturnType<typeof buildApp>,
  path: string,
  count: number,
  token: string
): Promise<number[]> {
  const seen: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const res = await request(app)
      .get(path)
      .set("Authorization", `Bearer ${token}`);
    seen.push(res.status);
  }
  return seen;
}

describe("stream rate limiter", () => {
  const app = buildApp();

  it("throttles the comment-paging endpoint past its ceiling", async () => {
    const token = makeAccessToken({ userId: "stream-limit-comments" });

    const seen = await send(
      app,
      `/api/v1/streams/${STREAM_ID}/comments`,
      LIMIT + 3,
      token
    );

    expect(seen).toContain(429);
  });

  it("throttles the viewers endpoint from the same shared bucket", async () => {
    const token = makeAccessToken({ userId: "stream-limit-viewers" });

    const seen = await send(
      app,
      `/api/v1/streams/${STREAM_ID}/viewers`,
      LIMIT + 3,
      token
    );

    expect(seen).toContain(429);
  });

  it("NEVER throttles the publisher heartbeat", async () => {
    // The one that matters. A throttled heartbeat means the sweeper ends a
    // live broadcast, which is strictly worse than the abuse being bounded.
    const token = makeAccessToken({ userId: "stream-limit-heartbeat" });

    const seen: number[] = [];
    for (let i = 0; i < LIMIT * 4; i += 1) {
      const res = await request(app)
        .post(`/api/v1/streams/${STREAM_ID}/heartbeat`)
        .set("Authorization", `Bearer ${token}`)
        .send({});
      seen.push(res.status);
    }

    expect(seen).not.toContain(429);
  });

  it("NEVER throttles quality reports", async () => {
    const token = makeAccessToken({ userId: "stream-limit-quality" });

    const seen: number[] = [];
    for (let i = 0; i < LIMIT * 4; i += 1) {
      const res = await request(app)
        .post(`/api/v1/streams/${STREAM_ID}/quality`)
        .set("Authorization", `Bearer ${token}`)
        .send({ resolution: "1280x720", bitrateKbps: 2500 });
      seen.push(res.status);
    }

    expect(seen).not.toContain(429);
  });

  it("keeps the heartbeat usable after the rest of the bucket is spent", async () => {
    // The real-world shape: one session doing both. Burn the bucket on reads,
    // then confirm the broadcaster can still keep their own stream alive.
    const token = makeAccessToken({ userId: "stream-limit-mixed" });

    const reads = await send(
      app,
      `/api/v1/streams/${STREAM_ID}/comments`,
      LIMIT + 3,
      token
    );
    expect(reads).toContain(429);

    const beat = await request(app)
      .post(`/api/v1/streams/${STREAM_ID}/heartbeat`)
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(beat.status).not.toBe(429);
  });

  it("buckets per session, not per IP", async () => {
    const spender = makeAccessToken({ userId: "stream-limit-spender" });
    const bystander = makeAccessToken({ userId: "stream-limit-bystander" });

    const spent = await send(
      app,
      `/api/v1/streams/${STREAM_ID}/comments`,
      LIMIT + 3,
      spender
    );
    expect(spent).toContain(429);

    const other = await request(app)
      .get(`/api/v1/streams/${STREAM_ID}/comments`)
      .set("Authorization", `Bearer ${bystander}`);

    expect(other.status).not.toBe(429);
  });
});
