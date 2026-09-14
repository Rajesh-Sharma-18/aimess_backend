/**
 * Rate-limit shape of the media routes: scan polling must not spend the upload budget.
 *
 * `/media/scan-status` used to sit behind `mediaRateLimiter`, the same 200-per-15-minutes bucket
 * as `/media/upload-url` and `/media/confirm`. That charged a wait the user never asked for
 * against the budget they needed to upload: confirm answers PENDING while ClamAV is still
 * running, every client then polls the object until it resolves, and a single multi-item album
 * could spend the whole window on polls — after which the next perfectly ordinary upload came
 * back 429 RATE_LIMITED.
 *
 * These specs pin the split. Scan polling has its own, far more generous bucket; uploads keep the
 * tight one; neither is unlimited.
 */
import request from "supertest";

import { app } from "../../src/app.js";
import { bearer, makeAccessToken } from "../helpers/auth.js";

const SCAN_PATH = "/api/v1/media/scan-status";
const UPLOAD_PATH = "/api/v1/media/upload-url";

/** `mediaRateLimiter`'s ceiling — the bucket scan polling must no longer share. */
const WRITE_MAX = 200;

/**
 * Fire `count` requests as one caller and report the 1-based index of the first 429, or null.
 *
 * Every spec uses its own subject: the limiters are keyed per user, so a shared token would leak
 * one spec's counter into the next and make results depend on file order. The requests are
 * deliberately unparameterised — a scan-status call with no `objectKey` is a 400, an upload-url
 * call with no body is a 400, and both still count against their limiter, which is the only thing
 * under test here.
 */
async function fire(
  path: string,
  count: number,
  userId: string,
  method: "get" | "post" = "get"
): Promise<number | null> {
  const headers = bearer(makeAccessToken({ userId }));
  for (let i = 1; i <= count; i += 1) {
    const res = await request(app)[method](path).set(headers);
    if (res.status === 429) return i;
  }
  return null;
}

describe("media rate limiting", () => {
  it("does not throttle scan polling at the upload bucket's ceiling", async () => {
    const throttledAt = await fire(
      SCAN_PATH,
      WRITE_MAX + 25,
      "00000000-0000-4000-8000-0000000005a1"
    );

    expect(throttledAt).toBeNull();
  });

  it("keeps scan polling usable after the upload bucket is exhausted", async () => {
    const userId = "00000000-0000-4000-8000-0000000005a2";
    // Spend the write budget…
    await fire(UPLOAD_PATH, WRITE_MAX + 5, userId, "post");
    // …the same caller must still be able to learn whether earlier uploads came back clean.
    // Failing here means an album's last item is throttled out of ever resolving its own scan.
    const throttledAt = await fire(SCAN_PATH, 10, userId);

    expect(throttledAt).toBeNull();
  });

  it("still throttles uploads at the write ceiling", async () => {
    const throttledAt = await fire(
      UPLOAD_PATH,
      WRITE_MAX + 10,
      "00000000-0000-4000-8000-0000000005a3",
      "post"
    );

    expect(throttledAt).not.toBeNull();
    expect(throttledAt).toBeLessThanOrEqual(WRITE_MAX + 1);
  });
});
