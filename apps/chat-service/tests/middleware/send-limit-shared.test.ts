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
  mentionAllAllowed,
  assertSendAllowed,
  consumeRateLimit,
  MESSAGE_SEND_LIMITS,
  MESSAGING_RATE_WINDOW_MS,
  sendRateLimit,
} =
  require("../../src/middleware/rate-limit.js") as typeof import("../../src/middleware/rate-limit.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { env } =
  require("../../src/config/env.js") as typeof import("../../src/config/env.js");

const USER = "user-1";
const ROOM = "room-1";
type Scope = "pm" | "gm" | "cm";

/** Consume `n` tokens the way the REST middleware does, for the same bucket. */
async function consumeAsRest(scope: Scope, times: number, room = ROOM) {
  for (let i = 0; i < times; i += 1) {
    await consumeRateLimit({
      keyPrefix: `${scope}:send`,
      identifier: `${USER}:${room}`,
      windowMs: MESSAGING_RATE_WINDOW_MS,
      maxRequests: MESSAGE_SEND_LIMITS[scope],
      onCacheError: "fallback",
    });
  }
}

beforeEach(() => {
  store.clear();
  execFails = false;
});

describe("send limiter — one bucket for REST and gRPC", () => {
  it("client table: 60/min per private recipient, 30/min per group/community channel", () => {
    expect(MESSAGE_SEND_LIMITS).toEqual({ pm: 60, gm: 30, cm: 30 });
  });

  it.each(["pm", "gm", "cm"] as const)(
    "%s: refuses the gRPC send once the REST quota is spent",
    async (scope) => {
      await consumeAsRest(scope, MESSAGE_SEND_LIMITS[scope]);

      // The socket path arrives here. Previously it had its own (absent) limit.
      await expect(assertSendAllowed(scope, USER, ROOM)).rejects.toMatchObject({
        statusCode: 429,
        messageKey: "RATE_LIMITED",
      });
    }
  );

  it.each(["pm", "gm", "cm"] as const)(
    "%s: allows sends up to the ceiling, then refuses",
    async (scope) => {
      for (let i = 0; i < MESSAGE_SEND_LIMITS[scope]; i += 1) {
        await expect(
          assertSendAllowed(scope, USER, ROOM)
        ).resolves.toBeUndefined();
      }

      await expect(assertSendAllowed(scope, USER, ROOM)).rejects.toMatchObject({
        statusCode: 429,
      });
    }
  );

  it("charges the same key REST uses, so neither path is a free door", async () => {
    await assertSendAllowed("pm", USER, ROOM);

    expect([...store.keys()]).toContain(`rl:pm:send:${USER}:${ROOM}`);
  });

  it("keeps the buckets separate per user", async () => {
    await consumeAsRest("pm", MESSAGE_SEND_LIMITS.pm);

    // A throttled user must not throttle everyone else.
    await expect(
      assertSendAllowed("pm", "user-2", ROOM)
    ).resolves.toBeUndefined();
  });

  it("keeps the buckets separate per conversation (recipient / channel)", async () => {
    await consumeAsRest("gm", MESSAGE_SEND_LIMITS.gm);

    await expect(assertSendAllowed("gm", USER, ROOM)).rejects.toMatchObject({
      statusCode: 429,
    });
    await expect(
      assertSendAllowed("gm", USER, "room-2")
    ).resolves.toBeUndefined();
  });

  it("keeps the buckets separate per conversation kind", async () => {
    await consumeAsRest("pm", MESSAGE_SEND_LIMITS.pm);

    await expect(assertSendAllowed("gm", USER, ROOM)).resolves.toBeUndefined();
    await expect(assertSendAllowed("cm", USER, ROOM)).resolves.toBeUndefined();
  });

  it("charges a multi-message forward per message", async () => {
    await expect(
      assertSendAllowed("cm", USER, ROOM, MESSAGE_SEND_LIMITS.cm)
    ).resolves.toBeUndefined();
    await expect(assertSendAllowed("cm", USER, ROOM)).rejects.toMatchObject({
      statusCode: 429,
    });
  });

  it("still bounds sends when Redis is unavailable", async () => {
    // Writes degrade to a per-process counter with the same ceiling.
    execFails = true;

    for (let i = 0; i < MESSAGE_SEND_LIMITS.pm; i += 1) {
      await expect(
        assertSendAllowed("pm", "outage-user", ROOM)
      ).resolves.toBeUndefined();
    }

    await expect(
      assertSendAllowed("pm", "outage-user", ROOM)
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it("reports a retry hint the client can wait on", async () => {
    await consumeAsRest("pm", MESSAGE_SEND_LIMITS.pm);

    await expect(assertSendAllowed("pm", USER, ROOM)).rejects.toMatchObject({
      retryAfterSec: expect.any(Number),
    });
  });
});

describe("REST sendRateLimit — same (sender, conversation) bucket", () => {
  const call = async (roomId: string) => {
    const req = {
      auth: { userId: USER },
      params: { roomId },
      headers: {},
      method: "POST",
      originalUrl: `/rooms/${roomId}/messages`,
    };
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      setHeader: jest.fn(),
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(b: unknown) {
        this.body = b;
        return this;
      },
    };
    const next = jest.fn();
    await sendRateLimit("gm")(req as never, res as never, next);
    return { res, next };
  };

  it("refuses REST once gRPC spent the room's quota; another room is unaffected", async () => {
    for (let i = 0; i < MESSAGE_SEND_LIMITS.gm; i += 1) {
      await assertSendAllowed("gm", USER, ROOM);
    }
    const refused = await call(ROOM);
    expect(refused.next).not.toHaveBeenCalled();
    expect(refused.res.statusCode).toBe(429);
    expect(refused.res.body).toMatchObject({
      error: { code: "RATE_LIMITED", retryAfter: expect.any(Number) },
    });
    expect((await call("room-2")).next).toHaveBeenCalled();
  });
});

describe("@all limiter — per room and sender", () => {
  it("allows GROUP_MENTION_ALL_RATE_MAX, then answers false (never throws) under its own key", async () => {
    for (let i = 0; i < env.GROUP_MENTION_ALL_RATE_MAX; i += 1) {
      await expect(mentionAllAllowed(USER, "room-1")).resolves.toBe(true);
    }

    await expect(mentionAllAllowed(USER, "room-1")).resolves.toBe(false);
    expect([...store.keys()]).toEqual([`rl:gm:mention-all:room-1:${USER}`]);
  });

  it("is separate per room and never spends the send bucket", async () => {
    for (let i = 0; i < env.GROUP_MENTION_ALL_RATE_MAX; i += 1) {
      await mentionAllAllowed(USER, "room-1");
    }

    await expect(mentionAllAllowed(USER, "room-2")).resolves.toBe(true);
    await expect(assertSendAllowed("gm", USER, ROOM)).resolves.toBeUndefined();
    expect(sorted(`rl:gm:send:${USER}:${ROOM}`)).toHaveLength(1);
  });
});
