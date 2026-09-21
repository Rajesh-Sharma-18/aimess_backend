/**
 * Global backstop split: reads and writes are separate buckets.
 *
 * They used to share one `global` counter, so opening a few media-heavy rooms
 * (history + inbox + one download-url per attachment) spent the allowance the
 * next send needed, and a send burst made the following history fetch 429 —
 * which the client painted as an empty room. Pins:
 *  - a normal room open (30 history pages) is never throttled;
 *  - a write flood 429s writes only, never history or download-url;
 *  - download-url has its own media-read bucket, not the history bucket.
 */
import request from "supertest";

import { createApp } from "../../src/app.js";
import type { MessagingClient } from "../../src/grpc/clients/messaging.client.js";
import type { MediaClient } from "../../src/grpc/clients/media.client.js";
import { makeAccessToken } from "../helpers/auth.js";
import { env } from "../../src/config/env.js";

const HISTORY = "/api/v1/chat/private/rooms/room-1/messages";
const DOWNLOAD = "/api/v1/media/download-url";
// Any authenticated write; unrouted is fine — the backstop runs first.
const WRITE = "/api/v1/chat/__write_probe";

const app = createApp(
  {} as unknown as MessagingClient,
  {} as unknown as MediaClient
);

const auth = (userId: string) => ({
  Authorization: `Bearer ${makeAccessToken({ userId, sessionId: userId })}`,
});

async function statuses(
  count: number,
  send: () => request.Test
): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) out.push((await send()).status);
  return out;
}

describe("global read/write split", () => {
  it("30x GET history is never 429", async () => {
    const h = auth("55555555-5555-4555-8555-555555555501");
    const got = await statuses(30, () => request(app).get(HISTORY).set(h));
    expect(got).not.toContain(429);
  });

  it("a write flood 429s writes only — history and download-url still served", async () => {
    const h = auth("55555555-5555-4555-8555-555555555502");
    const writes = await statuses(env.GLOBAL_RATE_LIMIT_MAX + 5, () =>
      request(app).post(WRITE).set(h).send({})
    );
    expect(writes).toContain(429);

    const reads = await statuses(10, () => request(app).get(HISTORY).set(h));
    expect(reads).not.toContain(429);
    const downloads = await statuses(10, () =>
      request(app).post(DOWNLOAD).set(h).send({})
    );
    expect(downloads).not.toContain(429);
  });

  it("a download-url burst past the history bucket does not throttle history", async () => {
    const h = auth("55555555-5555-4555-8555-555555555503");
    const burst = env.READ_RATE_LIMIT_MAX + 10;
    expect(burst).toBeLessThan(env.MEDIA_READ_RATE_LIMIT_MAX);
    expect(burst).toBeLessThan(env.GLOBAL_READ_RATE_LIMIT_MAX);

    const downloads = await statuses(burst, () =>
      request(app).post(DOWNLOAD).set(h).send({})
    );
    expect(downloads).not.toContain(429);
    const reads = await statuses(5, () =>
      request(app).get("/api/v1/chat/conversations").set(h)
    );
    expect(reads).not.toContain(429);
  });

  it("a POST that is not download-url cannot pose as a read", async () => {
    const h = auth("55555555-5555-4555-8555-555555555504");
    const got = await statuses(env.GLOBAL_RATE_LIMIT_MAX + 1, () =>
      request(app).post("/api/v1/media/download-url-x").set(h).send({})
    );
    expect(got).toContain(429);
  });
});
