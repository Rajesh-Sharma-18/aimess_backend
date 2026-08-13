/**
 * The Redis sliding-window limiter.
 *
 * The bug this file exists for: the limiter ran ZADD unconditionally and never
 * removed the member when it rejected, so it RECORDED THE REQUEST IT REFUSED. A
 * client retrying faster than the window kept injecting entries, ZCARD never
 * fell back under the limit, and the user was locked out indefinitely rather
 * than for one window — while the reported `retryAfterSec` (derived from the
 * oldest member, now including rejected attempts) grew past the real wait.
 *
 * The suite-wide Redis stub in tests/setup/global-mocks.ts returns
 * `exec: async () => null`, which makes the limiter a permanent no-op. This
 * file therefore installs its own in-memory Redis so the middleware is actually
 * exercised.
 */
import type { Request, Response, NextFunction } from "express";

type Member = { score: number; value: string };

/** Just enough of a Redis sorted set to drive the middleware honestly. */
const store = new Map<string, Member[]>();
/** Commands whose result should be replaced with an error, keyed by command name. */
const failing = new Set<string>();
let execReturnsNull = false;

function sorted(key: string): Member[] {
  return store.get(key) ?? [];
}

jest.mock("../../src/config/redis.js", () => {
  const makeMulti = () => {
    const ops: Array<() => [Error | null, unknown]> = [];
    const multi = {
      zremrangebyscore(key: string, min: number, max: number) {
        ops.push(() => {
          const kept = sorted(key).filter((m) => m.score < min || m.score > max);
          store.set(key, kept);
          return [null, 0];
        });
        return multi;
      },
      zadd(key: string, score: number, value: string) {
        ops.push(() => {
          const list = sorted(key);
          list.push({ score, value });
          store.set(key, list);
          return [null, 1];
        });
        return multi;
      },
      zcard(key: string) {
        ops.push(() =>
          failing.has("zcard")
            ? [new Error("zcard failed"), null]
            : [null, sorted(key).length]
        );
        return multi;
      },
      pexpire() {
        ops.push(() => [null, 1]);
        return multi;
      },
      async exec() {
        if (execReturnsNull) return null;
        return ops.map((run) => run());
      },
    };
    return multi;
  };

  return {
    redis: {
      status: "ready",
      multi: jest.fn(() => makeMulti()),
      async zrem(key: string, ...members: string[]) {
        const drop = new Set(members);
        const before = sorted(key).length;
        store.set(
          key,
          sorted(key).filter((m) => !drop.has(m.value))
        );
        return before - sorted(key).length;
      },
      async zrange(key: string, start: number, stop: number, withScores?: string) {
        const list = [...sorted(key)].sort((a, b) => a.score - b.score);
        const slice = list.slice(start, stop + 1);
        if (withScores) {
          return slice.flatMap((m) => [m.value, String(m.score)]);
        }
        return slice.map((m) => m.value);
      },
    },
    isChatCacheReady: () => true,
  };
});

// Imported AFTER the mock so the middleware binds to the fake client.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRateLimit } = require("../../src/middleware/rate-limit.js");

type Captured = {
  status?: number;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
};

function makeReqRes(userId = "user-1", body: unknown = {}) {
  const captured: Captured = { headers: {} };
  const req = {
    auth: { userId },
    ip: "203.0.113.9",
    method: "POST",
    originalUrl: "/chat/private/rooms/r1/messages",
    headers: {},
    body,
  } as unknown as Request;

  const res = {
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
    },
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(payload: Record<string, unknown>) {
      captured.body = payload;
      return res;
    },
  } as unknown as Response;

  return { req, res, captured };
}

async function run(
  limiter: (req: Request, res: Response, next: NextFunction) => Promise<void>,
  userId = "user-1",
  body: unknown = {}
) {
  const { req, res, captured } = makeReqRes(userId, body);
  let passed = false;
  await limiter(req, res, () => {
    passed = true;
  });
  return { passed, ...captured };
}

beforeEach(() => {
  store.clear();
  failing.clear();
  execReturnsNull = false;
});

describe("createRateLimit — allow/deny", () => {
  const limiter = createRateLimit({
    windowMs: 60_000,
    maxRequests: 3,
    keyPrefix: "test:basic",
  });

  it("passes requests under the limit", async () => {
    for (let i = 0; i < 3; i += 1) {
      const result = await run(limiter);
      expect(result.passed).toBe(true);
      expect(result.status).toBeUndefined();
    }
  });

  it("rejects the request that exceeds the limit", async () => {
    for (let i = 0; i < 3; i += 1) await run(limiter);

    const result = await run(limiter);
    expect(result.passed).toBe(false);
    expect(result.status).toBe(429);
  });

  it("buckets per user, so one user cannot throttle another", async () => {
    for (let i = 0; i < 4; i += 1) await run(limiter, "noisy-user");

    const quiet = await run(limiter, "quiet-user");
    expect(quiet.passed).toBe(true);
  });
});

describe("createRateLimit — the lockout regression", () => {
  const limiter = createRateLimit({
    windowMs: 60_000,
    maxRequests: 2,
    keyPrefix: "test:lockout",
  });

  it("does NOT record the request it rejects", async () => {
    await run(limiter);
    await run(limiter);
    expect(store.get("rl:test:lockout:user-1")).toHaveLength(2);

    await run(limiter);

    // The rejected attempt must leave the window exactly as it found it.
    // Without the ZREM this was 3, and every subsequent retry pushed it higher.
    expect(store.get("rl:test:lockout:user-1")).toHaveLength(2);
  });

  it("stays bounded under a retry storm instead of locking the user out forever", async () => {
    for (let i = 0; i < 50; i += 1) await run(limiter);

    // 50 attempts against a limit of 2: the window holds the 2 that were
    // ACCEPTED, never the 48 that were refused.
    expect(store.get("rl:test:lockout:user-1")).toHaveLength(2);
  });

  it("reports a retryAfter that does not inflate as the client retries", async () => {
    await run(limiter);
    await run(limiter);

    const first = await run(limiter);
    for (let i = 0; i < 20; i += 1) await run(limiter);
    const later = await run(limiter);

    const firstRetry = (first.body?.error as { retryAfter: number }).retryAfter;
    const laterRetry = (later.body?.error as { retryAfter: number }).retryAfter;

    // Derived from the oldest ACCEPTED member, so it can only shrink as the
    // window slides. Previously the refused attempts were in the set too, so
    // the reported wait grew with every retry.
    expect(laterRetry).toBeLessThanOrEqual(firstRetry);
  });
});

describe("createRateLimit — 429 envelope", () => {
  const limiter = createRateLimit({
    windowMs: 60_000,
    maxRequests: 1,
    keyPrefix: "test:envelope",
  });

  it("emits the structured envelope and the Retry-After header", async () => {
    await run(limiter);
    const result = await run(limiter);

    expect(result.status).toBe(429);
    expect(result.body?.success).toBe(false);
    // Retained for clients already reading the flat shape.
    expect(typeof result.body?.message).toBe("string");
    expect(result.body?.retryAfterSec).toBeGreaterThan(0);

    const error = result.body?.error as Record<string, unknown>;
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retryable).toBe(true);
    expect(error.statusCode).toBe(429);
    expect(typeof error.retryAfter).toBe("number");

    // The header is what a client actually backs off on; its absence was why
    // every throttled client fell back to guessing.
    expect(result.headers["retry-after"]).toBe(String(error.retryAfter));
  });
});

describe("createRateLimit — batch-aware cost", () => {
  const limiter = createRateLimit({
    windowMs: 60_000,
    maxRequests: 60,
    keyPrefix: "test:bulk",
    cost: (req: Request) => {
      const roomIds = (req.body as { roomIds?: unknown })?.roomIds;
      return 1 + Math.floor((Array.isArray(roomIds) ? roomIds.length : 1) / 10);
    },
  });

  it("charges a single-item batch one token", async () => {
    await run(limiter, "user-1", { roomIds: ["r1"] });
    expect(store.get("rl:test:bulk:user-1")).toHaveLength(1);
  });

  it("charges a 50-item batch six tokens, not fifty", async () => {
    const roomIds = Array.from({ length: 50 }, (_, i) => `r${i}`);
    await run(limiter, "user-1", { roomIds });

    // Sub-linear on purpose: charging 50 would make one legitimate
    // "select all and mark read" exhaust the budget outright.
    expect(store.get("rl:test:bulk:user-1")).toHaveLength(6);
  });

  it("still lets ten full-size batches through in one window", async () => {
    const roomIds = Array.from({ length: 50 }, (_, i) => `r${i}`);
    for (let i = 0; i < 10; i += 1) {
      const result = await run(limiter, "user-1", { roomIds });
      expect(result.passed).toBe(true);
    }
  });
});

describe("createRateLimit — fails open, loudly", () => {
  const limiter = createRateLimit({
    windowMs: 60_000,
    maxRequests: 1,
    keyPrefix: "test:failopen",
  });

  it("allows the request when the pipeline returns null", async () => {
    execReturnsNull = true;
    const result = await run(limiter);
    expect(result.passed).toBe(true);
  });

  it("allows the request when ZCARD itself errored", async () => {
    // The original code read `results[2]?.[1] as number` with no check on the
    // error slot, so a failed command left `count` undefined and
    // `undefined > max` is false — the limiter silently passed everything
    // through while appearing healthy. It must fail open EXPLICITLY.
    failing.add("zcard");
    const result = await run(limiter);
    expect(result.passed).toBe(true);
  });
});
