/**
 * Media limiter shapes.
 *
 * `/media` used to be mounted as ONE segment behind `mediaRateLimiter`, a
 * write-shaped bucket sized for presigned-URL minting (30/min). Every read on
 * the segment therefore spent the write budget: sending one attachment costs an
 * upload-url, a confirm and up to twenty scan-status polls, and opening a
 * media-heavy room mints a download URL per attachment — so a normal user got
 * 429 RATE_LIMITED on `POST /media/download-url` while doing nothing abusive.
 *
 * These specs pin the split: writes keep the tight bucket, `download-url` gets
 * the generous read bucket, and neither is unlimited.
 */
import request from "supertest";

import { createApp } from "../../src/app.js";
import type { MessagingClient } from "../../src/grpc/clients/messaging.client.js";
import type { MediaClient } from "../../src/grpc/clients/media.client.js";
import { makeAccessToken } from "../helpers/auth.js";

const UPLOAD_PATH = "/api/v1/media/upload-url";
const DOWNLOAD_PATH = "/api/v1/media/download-url";

/** The write bucket's ceiling (`mediaRateLimiter`, 30 per minute). */
const MEDIA_WRITE_MAX = 30;

function buildApp() {
  return createApp(
    {} as unknown as MessagingClient,
    {} as unknown as MediaClient
  );
}

/**
 * Fire `count` POSTs as one user and report the first 429, if any.
 *
 * Each spec uses its OWN user id: the limiters are session-scoped, so a shared
 * token would leak one spec's counter into the next and make the result depend
 * on file order.
 */
async function fire(
  app: ReturnType<typeof buildApp>,
  path: string,
  count: number,
  userId: string
): Promise<{ throttledAt: number | null }> {
  const token = makeAccessToken({ userId, sessionId: userId });
  for (let i = 1; i <= count; i += 1) {
    const res = await request(app)
      .post(path)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    if (res.status === 429) return { throttledAt: i };
  }
  return { throttledAt: null };
}

describe("media rate limiting", () => {
  const app = buildApp();

  it("does not throttle download-url at the write bucket's ceiling", async () => {
    const { throttledAt } = await fire(
      app,
      DOWNLOAD_PATH,
      MEDIA_WRITE_MAX + 20,
      "44444444-4444-4444-8444-444444444401"
    );

    expect(throttledAt).toBeNull();
  });

  it("still throttles upload-url at the write ceiling", async () => {
    const { throttledAt } = await fire(
      app,
      UPLOAD_PATH,
      MEDIA_WRITE_MAX + 10,
      "44444444-4444-4444-8444-444444444402"
    );

    expect(throttledAt).not.toBeNull();
    expect(throttledAt).toBeLessThanOrEqual(MEDIA_WRITE_MAX + 1);
  });

  it("keeps download-url out of the upload bucket entirely", async () => {
    const userId = "44444444-4444-4444-8444-444444444403";
    // Exhaust the write bucket first…
    await fire(app, UPLOAD_PATH, MEDIA_WRITE_MAX + 5, userId);
    // …then the same user's reads must still be served.
    const { throttledAt } = await fire(app, DOWNLOAD_PATH, 5, userId);

    expect(throttledAt).toBeNull();
  });

  it("answers a throttled media write with the RATE_LIMITED envelope", async () => {
    const token = makeAccessToken({
      userId: "44444444-4444-4444-8444-444444444404",
      sessionId: "44444444-4444-4444-8444-444444444404",
    });
    let last;
    for (let i = 0; i < MEDIA_WRITE_MAX + 10; i += 1) {
      last = await request(app)
        .post(UPLOAD_PATH)
        .set("Authorization", `Bearer ${token}`)
        .send({});
      if (last.status === 429) break;
    }

    expect(last?.status).toBe(429);
    expect(last?.body.error.code).toBe("RATE_LIMITED");
    expect(typeof last?.body.error.retryAfter).toBe("number");
  });
});
