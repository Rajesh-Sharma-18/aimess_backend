/**
 * OTP issuance: 3 per hour per email, then blocked for an hour (client table).
 */
jest.mock("../../src/config/env.js", () => {
  const actual = jest.requireActual("../../src/config/env.js");
  return {
    env: {
      ...actual.env,
      OTP_REQUEST_MAX: 3,
      OTP_REQUEST_WINDOW_SEC: 3600,
      OTP_REQUEST_IP_MAX: 20,
    },
  };
});
jest.mock("../../src/config/redis.js", () => {
  const counts = new Map<string, number>();
  const ttls = new Map<string, number>();
  return {
    redis: {
      incr: jest.fn(async (k: string) => {
        counts.set(k, (counts.get(k) ?? 0) + 1);
        return counts.get(k);
      }),
      ttl: jest.fn(async (k: string) => ttls.get(k) ?? -1),
      expire: jest.fn(async (k: string, s: number) => {
        ttls.set(k, s);
        return 1;
      }),
    },
  };
});

import { assertOtpRequestAllowed } from "../../src/lib/otp-rate-limit.js";

it("allows 3 per email per hour, the 4th → 429 AUTH_OTP_REQUEST_THROTTLED + 1h retry", async () => {
  for (let i = 0; i < 3; i += 1) {
    await expect(
      assertOtpRequestAllowed("A@x.com", "1.1.1.1")
    ).resolves.toBeUndefined();
  }
  await expect(
    assertOtpRequestAllowed("a@x.com", "2.2.2.2")
  ).rejects.toMatchObject({
    statusCode: 429,
    messageKey: "AUTH_OTP_REQUEST_THROTTLED",
    retryAfterSec: 3600,
  });
  // Another email is its own bucket.
  await expect(
    assertOtpRequestAllowed("b@x.com", "2.2.2.2")
  ).resolves.toBeUndefined();
});
