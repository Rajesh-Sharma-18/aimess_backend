import { TooManyRequestsError } from "@aimess/errors";
import {
  assertActionQuota,
  clearFallbackWindow,
  consumeActionQuota,
  type QuotaRedis,
} from "@aimess/utils";

function fakeRedis(): QuotaRedis & { ttls: Map<string, number> } {
  const counts = new Map<string, number>();
  const ttls = new Map<string, number>();
  return {
    ttls,
    incr: async (k) => {
      const n = (counts.get(k) ?? 0) + 1;
      counts.set(k, n);
      return n;
    },
    ttl: async (k) => ttls.get(k) ?? -1,
    expire: async (k, s) => {
      ttls.set(k, s);
      return 1;
    },
  };
}

describe("consumeActionQuota", () => {
  it("allows up to the limit, then refuses with the remaining window", async () => {
    const redis = fakeRedis();
    const q = { key: "t:a", limit: 2, windowSec: 3600 };
    expect((await consumeActionQuota(redis, q)).allowed).toBe(true);
    expect((await consumeActionQuota(redis, q)).allowed).toBe(true);
    expect(await consumeActionQuota(redis, q)).toEqual({
      allowed: false,
      retryAfterSec: 3600,
    });
  });

  it("starts a full block on the first refusal and does not extend it", async () => {
    const redis = fakeRedis();
    const q = { key: "t:b", limit: 1, windowSec: 600, blockSec: 900 };
    await consumeActionQuota(redis, q);
    expect((await consumeActionQuota(redis, q)).retryAfterSec).toBe(900);
    redis.ttls.set("aimess:quota:t:b", 500);
    expect((await consumeActionQuota(redis, q)).retryAfterSec).toBe(500);
  });

  it("degrades to the per-process counter when Redis fails", async () => {
    const broken = {
      incr: async () => {
        throw new Error("down");
      },
    } as unknown as QuotaRedis;
    const q = { key: "t:c", limit: 1, windowSec: 60 };
    clearFallbackWindow("aimess:quota:t:c");
    expect((await consumeActionQuota(broken, q)).allowed).toBe(true);
    expect((await consumeActionQuota(broken, q)).allowed).toBe(false);
  });

  it("assertActionQuota throws a 429 carrying the key and retry-after", async () => {
    const redis = fakeRedis();
    const q = { key: "t:d", limit: 0, windowSec: 86400 };
    const err = await assertActionQuota(redis, q, "X_LIMIT").catch((e) => e);
    expect(err).toBeInstanceOf(TooManyRequestsError);
    expect(err.messageKey).toBe("X_LIMIT");
    expect(err.retryAfterSec).toBe(86400);
  });
});
