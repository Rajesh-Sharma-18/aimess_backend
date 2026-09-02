/**
 * AIM-03 / AIM-04 — the socket send path must consume the same quota as REST.
 *
 * Every anti-spam send limit in this service was Express middleware on the REST
 * router, while the socket path called the gRPC `sendMessage` /
 * `sendCommunityMessage` directly — so none of it ran there. A socket frame is
 * cheaper to send than an HTTP request, which made the unthrottled path the
 * higher-throughput one: an authenticated client could emit in a loop for
 * unlimited private, group and community messages, each a database write, a
 * Redis fan-out and a push. A community send is amplified to every member.
 *
 * The fix is one bucket, consumed by both entry points, so the quota belongs to
 * the user rather than to the transport they picked. These tests assert exactly
 * that: REST consumption is visible to the gRPC path and vice versa.
 *
 * The suite-wide Redis stub returns `exec: async () => null`, which would make
 * the limiter a no-op, so this file installs its own in-memory sorted set.
 */

type Member = { score: number; value: string };

const store = new Map<string, Member[]>();
let execFails = false;

function sorted(key: string): Member[] {
  return store.get(key) ?? [];
}

jest.mock("../../src/config/redis.js", () => {
  const makeMulti = () => {
    const ops: Array<() => [Error | null, unknown]> = [];
    const multi = {
      zremrangebyscore(key: string, min: number, max: number) {
        ops.push(() => {
          store.set(
            key,
            sorted(key).filter((m) => m.score < min || m.score > max)
          );
          return [null, 0];
        });
        return multi;
      },
      zadd(key: string, score: number, value: string) {
        ops.push(() => {
          store.set(key, [...sorted(key), { score, value }]);
          return [null, 1];
        });
        return multi;
      },
      zcard(key: string) {
        ops.push(() => [null, sorted(key).length]);
        return multi;
      },
      pexpire() {
        ops.push(() => [null, 1]);
        return multi;
      },
      async exec() {
        if (execFails) throw new Error("redis unavailable");
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
        store.set(
          key,
          sorted(key).filter((m) => !drop.has(m.value))
        );
        return 0;
      },
      async zrange() {
        return [];
      },
    },
    isChatCacheReady: () => true,
  };
});

// Imported AFTER the mock so the module binds to the fake client.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  assertSendAllowed,
  consumeRateLimit,
  MESSAGING_RATE_LIMITS,
  MESSAGING_RATE_WINDOW_MS,
} = require("../../src/middleware/rate-limit.js") as typeof import("../../src/middleware/rate-limit.js");

const USER = "user-1";

/** Consume `n` tokens the way the REST middleware does, for the same bucket. */
async function consumeAsRest(scope: string, times: number) {
  for (let i = 0; i < times; i += 1) {
    await consumeRateLimit({
      keyPrefix: `${scope}:send`,
      identifier: USER,
      windowMs: MESSAGING_RATE_WINDOW_MS,
      maxRequests: MESSAGING_RATE_LIMITS.send,
      onCacheError: "fallback",
    });
  }
}

beforeEach(() => {
  store.clear();
  execFails = false;
});

describe("send limiter — one bucket for REST and gRPC", () => {
  it.each(["pm", "gm", "cm"] as const)(
    "%s: refuses the gRPC send once the REST quota is spent",
    async (scope) => {
      await consumeAsRest(scope, MESSAGING_RATE_LIMITS.send);

      // The socket path arrives here. Previously it had its own (absent) limit.
      await expect(assertSendAllowed(scope, USER)).rejects.toMatchObject({
        statusCode: 429,
        messageKey: "RATE_LIMITED",
      });
    }
  );

  it("allows sends up to the ceiling, then refuses", async () => {
    for (let i = 0; i < MESSAGING_RATE_LIMITS.send; i += 1) {
      await expect(assertSendAllowed("pm", USER)).resolves.toBeUndefined();
    }

    await expect(assertSendAllowed("pm", USER)).rejects.toMatchObject({
      statusCode: 429,
    });
  });

  it("charges the same key REST uses, so neither path is a free door", async () => {
    await assertSendAllowed("pm", USER);

    expect([...store.keys()]).toContain(`rl:pm:send:${USER}`);
  });

  it("keeps the buckets separate per user", async () => {
    for (let i = 0; i < MESSAGING_RATE_LIMITS.send; i += 1) {
      await assertSendAllowed("pm", USER);
    }

    // A throttled user must not throttle everyone else.
    await expect(assertSendAllowed("pm", "user-2")).resolves.toBeUndefined();
  });

  it("keeps the buckets separate per conversation kind", async () => {
    await consumeAsRest("pm", MESSAGING_RATE_LIMITS.send);

    // Exhausting private sends must not block group or community sends: they
    // are separate ceilings by design, and always have been on REST.
    await expect(assertSendAllowed("gm", USER)).resolves.toBeUndefined();
    await expect(assertSendAllowed("cm", USER)).resolves.toBeUndefined();
  });

  it("still bounds sends when Redis is unavailable", async () => {
    // The old behaviour was to fail fully open, so a Redis outage removed every
    // send limit at once — exactly when a flood is least absorbable. Writes now
    // degrade to a per-process counter with the same ceiling.
    execFails = true;

    for (let i = 0; i < MESSAGING_RATE_LIMITS.send; i += 1) {
      await expect(assertSendAllowed("pm", "outage-user")).resolves.toBeUndefined();
    }

    await expect(assertSendAllowed("pm", "outage-user")).rejects.toMatchObject({
      statusCode: 429,
    });
  });

  it("reports a retry hint the client can wait on", async () => {
    await consumeAsRest("pm", MESSAGING_RATE_LIMITS.send);

    await expect(assertSendAllowed("pm", USER)).rejects.toMatchObject({
      retryAfterSec: expect.any(Number),
    });
  });
});
