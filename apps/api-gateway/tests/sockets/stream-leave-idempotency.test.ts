/**
 * Issue #75 — browser Back must leave/end the livestream.
 *
 * The fix is in the web client's navigation lifecycle (leaving a community's
 * live context now forgets the "I am watching" intent and, for a host, runs the
 * existing end-stream flow). What that fix RELIES ON is that the gateway's
 * livestream leave path is idempotent: an SPA back-navigation can fire
 * `stream:leave` from the viewer teardown AND then have the socket drop, so the
 * decrement must run exactly once no matter how many exit paths execute.
 *
 * These tests drive the REAL `registerStreamNamespace` against an in-memory
 * Redis (the presence hash is a genuine refcount, not a stub) so the invariant
 * is exercised end-to-end rather than restated.
 */
import { registerStreamNamespace } from "../../src/sockets/namespaces/stream.ns.js";

jest.mock("../../src/sockets/auth.middleware.js", () => ({
  createGatewaySocketAuthMiddleware: () => () => undefined,
}));

const STREAM_ID = "stream_abc123";
const ROOM = `stream:${STREAM_ID}`;
const SESSION_KEY = `stream:session:users:${STREAM_ID}`;

/** Minimal in-memory Redis covering the hash + expire commands stream.ns uses. */
function makeRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const hash = (key: string) => {
    let h = hashes.get(key);
    if (!h) hashes.set(key, (h = new Map()));
    return h;
  };
  /** Every command a MULTI batch queued, newest batch last. */
  const batches: string[][] = [];

  const ops = {
    hincrby: (key: string, field: string, by: number) => {
      const h = hash(key);
      const next = Number(h.get(field) ?? 0) + by;
      h.set(field, String(next));
      return next;
    },
    hdel: (key: string, field: string) => (hash(key).delete(field) ? 1 : 0),
    hlen: (key: string) => hash(key).size,
    hsetnx: (key: string, field: string, value: string) => {
      const h = hash(key);
      if (h.has(field)) return 0;
      h.set(field, value);
      return 1;
    },
    expire: () => 1,
  };
  type OpName = keyof typeof ops;

  return {
    hashes,
    batches,
    hincrby: jest.fn(async (...a: [string, string, number]) => ops.hincrby(...a)),
    hdel: jest.fn(async (...a: [string, string]) => ops.hdel(...a)),
    hlen: jest.fn(async (key: string) => ops.hlen(key)),
    hsetnx: jest.fn(async (...a: [string, string, string]) => ops.hsetnx(...a)),
    expire: jest.fn(async () => 1),
    incr: jest.fn(async () => 1),
    psubscribe: jest.fn(async () => undefined),
    on: jest.fn(),
    /**
     * MULTI, modelled faithfully enough to matter.
     *
     * `incrementPresence` batches its writes so the presence hash can never
     * exist without its TTL. A fake that omitted `multi` would make that helper
     * throw INSIDE its own try, get swallowed into a `null` return, and leave
     * every count assertion below silently wrong instead of loudly failing.
     *
     * Commands are recorded into `batches` as well as applied, so a test can
     * assert WHICH commands shared a transaction — that, not the resulting
     * count, is what the TTL guarantee actually rests on.
     *
     * `exec()` returns ioredis's `[err, value]` pairs, so callers that read a
     * value without checking the error slot are caught here too.
     */
    multi: jest.fn(() => {
      const queued: { op: OpName; args: unknown[] }[] = [];
      const chain = {
        hincrby(key: string, field: string, by: number) {
          queued.push({ op: "hincrby", args: [key, field, by] });
          return chain;
        },
        hdel(key: string, field: string) {
          queued.push({ op: "hdel", args: [key, field] });
          return chain;
        },
        hlen(key: string) {
          queued.push({ op: "hlen", args: [key] });
          return chain;
        },
        hsetnx(key: string, field: string, value: string) {
          queued.push({ op: "hsetnx", args: [key, field, value] });
          return chain;
        },
        expire(key: string, ttl: number) {
          queued.push({ op: "expire", args: [key, ttl] });
          return chain;
        },
        exec: async (): Promise<[Error | null, unknown][]> => {
          batches.push(queued.map((q) => q.op));
          return queued.map((q) => [
            null,
            (ops[q.op] as (...a: unknown[]) => unknown)(...q.args),
          ]);
        },
      };
      return chain;
    }),
  };
}

interface FakeSocket {
  id: string;
  data: Record<string, unknown>;
  rooms: Set<string>;
  handlers: Map<string, (...args: unknown[]) => void>;
  emit: jest.Mock;
  on: (event: string, fn: (...args: unknown[]) => void) => void;
  use: jest.Mock;
  join: (room: string) => void;
  leave: (room: string) => void;
}

function makeSocket(id: string, userId: string): FakeSocket {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const rooms = new Set<string>();
  return {
    id,
    data: { userId, locale: "en" },
    rooms,
    handlers,
    emit: jest.fn(),
    on: (event, fn) => handlers.set(event, fn),
    // scopeSocketLocale installs a per-socket middleware; inert here.
    use: jest.fn(),
    join: (room) => rooms.add(room),
    leave: (room) => rooms.delete(room),
  };
}

function harness() {
  const redis = makeRedis();
  const sockets: FakeSocket[] = [];
  const emitted: { room: string; event: string; data: unknown }[] = [];
  const ns = {
    use: jest.fn(),
    on: jest.fn(),
    in: (room: string) => ({
      fetchSockets: async () => sockets.filter((s) => s.rooms.has(room)),
    }),
    to: (room: string) => ({
      emit: (event: string, data: unknown) =>
        emitted.push({ room, event, data }),
    }),
    fetchSockets: async () => sockets,
  };
  const io = { of: () => ns };
  const streamClient = {
    checkStreamAccess: jest.fn(async () => ({
      allowed: true,
      isBanned: false,
      status: "LIVE",
      reason: "",
      canComment: true,
      streamStatus: "LIVE",
      title: "t",
      description: "d",
      thumbnail: null,
      creatorId: "host-1",
      hlsUrl: "",
      hlsQualities: {},
      flvUrl: "",
      flvQualities: {},
      videoLostSince: "",
    })),
    getComments: jest.fn(async () => ({
      comments: [],
      nextCursor: "",
      hasMore: false,
    })),
    recordViewerJoin: jest.fn(async () => undefined),
    recordViewerLeave: jest.fn(async () => undefined),
  };

  registerStreamNamespace(
    io as never,
    streamClient as never,
    redis as never,
    redis as never,
    {} as never
  );
  const onConnection = ns.on.mock.calls.find(
    (c) => c[0] === "connection"
  )![1] as (socket: unknown) => void;

  const connect = (id: string, userId: string): FakeSocket => {
    const socket = makeSocket(id, userId);
    sockets.push(socket);
    onConnection(socket);
    return socket;
  };

  const fire = async (
    socket: FakeSocket,
    event: string,
    payload: unknown
  ): Promise<unknown> => {
    const handler = socket.handlers.get(event)!;
    return new Promise((resolve) => {
      handler(payload, resolve);
      // These take no ack — resolve once their async work is queued.
      if (event === "disconnecting" || event === "stream:heartbeat")
        setImmediate(resolve);
    });
  };

  return { redis, streamClient, connect, fire, emitted, ns };
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
});
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

describe("/stream leave is idempotent — the SPA back-navigation contract", () => {
  it("a viewer join/leave round trip drops the refcount exactly once", async () => {
    const h = harness();
    const viewer = h.connect("s1", "viewer-1");

    await h.fire(viewer, "stream:join", { streamId: STREAM_ID });
    expect(await h.redis.hlen(SESSION_KEY)).toBe(1);
    expect(h.streamClient.recordViewerJoin).toHaveBeenCalledTimes(1);

    await h.fire(viewer, "stream:leave", { streamId: STREAM_ID });
    expect(await h.redis.hlen(SESSION_KEY)).toBe(0);
    expect(viewer.rooms.has(ROOM)).toBe(false);
    expect(h.streamClient.recordViewerLeave).toHaveBeenCalledTimes(1);
  });

  it("a SECOND leave for the same stream is a no-op — no negative count, no duplicate session close", async () => {
    // Browser Back can run the component unmount AND a route-change handler.
    const h = harness();
    const viewer = h.connect("s1", "viewer-1");
    await h.fire(viewer, "stream:join", { streamId: STREAM_ID });

    await h.fire(viewer, "stream:leave", { streamId: STREAM_ID });
    await h.fire(viewer, "stream:leave", { streamId: STREAM_ID });

    expect(await h.redis.hlen(SESSION_KEY)).toBe(0);
    expect(h.streamClient.recordViewerLeave).toHaveBeenCalledTimes(1);
  });

  it("a leave that never joined is a no-op", async () => {
    const h = harness();
    const viewer = h.connect("s1", "viewer-1");

    await h.fire(viewer, "stream:leave", { streamId: STREAM_ID });

    expect(await h.redis.hlen(SESSION_KEY)).toBe(0);
    expect(h.streamClient.recordViewerLeave).not.toHaveBeenCalled();
  });

  it("leave followed by a socket drop does not double-decrement", async () => {
    // The realistic back-navigation race: the client emits leave, then the
    // socket goes away because the page tore the connection down.
    const h = harness();
    const viewer = h.connect("s1", "viewer-1");
    await h.fire(viewer, "stream:join", { streamId: STREAM_ID });
    await h.fire(viewer, "stream:leave", { streamId: STREAM_ID });

    await h.fire(viewer, "disconnecting", "transport close");

    expect(await h.redis.hlen(SESSION_KEY)).toBe(0);
    expect(h.streamClient.recordViewerLeave).toHaveBeenCalledTimes(1);
  });

  it("a socket drop with NO explicit leave still removes the participant (the sweeper is only the last resort)", async () => {
    const h = harness();
    const viewer = h.connect("s1", "viewer-1");
    await h.fire(viewer, "stream:join", { streamId: STREAM_ID });

    await h.fire(viewer, "disconnecting", "transport close");

    expect(await h.redis.hlen(SESSION_KEY)).toBe(0);
    expect(h.streamClient.recordViewerLeave).toHaveBeenCalledTimes(1);
  });

  it("one viewer leaving does not evict the others — the host keeps streaming", async () => {
    const h = harness();
    const a = h.connect("s1", "viewer-1");
    const b = h.connect("s2", "viewer-2");
    await h.fire(a, "stream:join", { streamId: STREAM_ID });
    await h.fire(b, "stream:join", { streamId: STREAM_ID });
    expect(await h.redis.hlen(SESSION_KEY)).toBe(2);

    await h.fire(a, "stream:leave", { streamId: STREAM_ID });

    expect(await h.redis.hlen(SESSION_KEY)).toBe(1);
    expect(h.redis.hashes.get(SESSION_KEY)?.has("viewer-2")).toBe(true);
    expect(b.rooms.has(ROOM)).toBe(true);
  });

  it("a re-join after leaving is a fresh, explicit participant — the count returns to 1", async () => {
    // "Returning to the community must not auto-rejoin" is a client decision;
    // the server side of it is simply that an explicit re-join works cleanly
    // after the leave, with no leftover refcount from the previous session.
    const h = harness();
    const viewer = h.connect("s1", "viewer-1");
    await h.fire(viewer, "stream:join", { streamId: STREAM_ID });
    await h.fire(viewer, "stream:leave", { streamId: STREAM_ID });

    await h.fire(viewer, "stream:join", { streamId: STREAM_ID });

    expect(await h.redis.hlen(SESSION_KEY)).toBe(1);
    expect(h.streamClient.recordViewerJoin).toHaveBeenCalledTimes(2);
  });

  it("a duplicated join on the same socket does not inflate the count", async () => {
    // React strict-mode double-mount, or a reconnect re-join.
    const h = harness();
    const viewer = h.connect("s1", "viewer-1");

    await h.fire(viewer, "stream:join", { streamId: STREAM_ID });
    await h.fire(viewer, "stream:join", { streamId: STREAM_ID });

    expect(await h.redis.hlen(SESSION_KEY)).toBe(1);
    expect(h.redis.hashes.get(SESSION_KEY)?.get("viewer-1")).toBe("1");
  });
});

describe("presence join is atomic", () => {
  // HINCRBY is what CREATES the presence hash, and the EXPIRE beside it is the
  // only thing that ever gives that hash a lifetime. Issued as separate round
  // trips, a process death in between left a key with no TTL at all — Redis
  // keeps it forever and nothing deletes it. The heartbeat re-EXPIREs, so it
  // looks self-healing, but only while somebody is still watching: crash when
  // that viewer was the last one and the key is never touched again.

  it("writes the refcount and its TTL in ONE transaction", async () => {
    const h = harness();
    const viewer = h.connect("s1", "viewer-1");

    await h.fire(viewer, "stream:join", { streamId: STREAM_ID });

    // Exactly one batch, and the EXPIRE for the presence hash rides along with
    // the HINCRBY that created it. This is the guarantee — not the count.
    expect(h.redis.batches).toHaveLength(1);
    expect(h.redis.batches[0]).toEqual([
      "hincrby",
      "expire",
      "hsetnx",
      "expire",
      "hlen",
    ]);
  });

  it("never issues the refcount write outside a transaction", async () => {
    // If a future edit splits these back into loose awaits, the standalone
    // mocks start seeing traffic and this fails.
    const h = harness();
    const viewer = h.connect("s1", "viewer-1");

    await h.fire(viewer, "stream:join", { streamId: STREAM_ID });

    expect(h.redis.hincrby).not.toHaveBeenCalled();
    expect(h.redis.multi).toHaveBeenCalledTimes(1);
  });

  it("reports no count when the transaction reports a per-command failure", async () => {
    // `exec()` resolves with [err, value] pairs and does NOT reject, so a
    // caller that reads the value without checking the error slot gets
    // `undefined` and sails on. The join must degrade to "unknown count"
    // instead, exactly as the old catch-block did.
    const h = harness();
    const viewer = h.connect("s1", "viewer-1");
    h.redis.multi.mockReturnValueOnce({
      hincrby: () => h.redis.multi(),
      expire: () => h.redis.multi(),
      hsetnx: () => h.redis.multi(),
      hlen: () => h.redis.multi(),
      exec: async () => [
        [null, 1],
        [null, 1],
        [null, 1],
        [null, 1],
        [new Error("boom"), null],
      ],
    } as never);

    const ack = (await h.fire(viewer, "stream:join", {
      streamId: STREAM_ID,
    })) as { data?: { viewerCount?: number } };

    // Join still succeeds; the count just falls back rather than going
    // undefined-shaped into the ack.
    expect(ack?.data?.viewerCount).toBe(0);
  });
});

describe("stream:heartbeat is throttled", () => {
  // The `streamIncremented` guard answers "may you heartbeat", not "how often".
  // Each accepted beat costs three Redis round trips, so a joined viewer could
  // loop the event freely.

  it("ignores a second heartbeat inside the interval", async () => {
    const h = harness();
    const viewer = h.connect("s1", "viewer-1");
    await h.fire(viewer, "stream:join", { streamId: STREAM_ID });
    h.redis.expire.mockClear();

    await h.fire(viewer, "stream:heartbeat", { streamId: STREAM_ID });
    await h.fire(viewer, "stream:heartbeat", { streamId: STREAM_ID });
    await h.fire(viewer, "stream:heartbeat", { streamId: STREAM_ID });

    // One accepted beat refreshes both hashes — two EXPIREs, not six.
    expect(h.redis.expire).toHaveBeenCalledTimes(2);
  });

  it("accepts the next heartbeat once the interval has passed", async () => {
    const h = harness();
    const viewer = h.connect("s1", "viewer-1");
    await h.fire(viewer, "stream:join", { streamId: STREAM_ID });
    h.redis.expire.mockClear();

    await h.fire(viewer, "stream:heartbeat", { streamId: STREAM_ID });
    jest.advanceTimersByTime(11_000); // > HEARTBEAT_MIN_INTERVAL_MS
    await h.fire(viewer, "stream:heartbeat", { streamId: STREAM_ID });

    expect(h.redis.expire).toHaveBeenCalledTimes(4);
  });

  it("throttles per socket, not across sockets", async () => {
    // A shared throttle would let one viewer's beat suppress another's and
    // silently evict them when their TTL lapsed.
    const h = harness();
    const a = h.connect("s1", "viewer-1");
    const b = h.connect("s2", "viewer-2");
    await h.fire(a, "stream:join", { streamId: STREAM_ID });
    await h.fire(b, "stream:join", { streamId: STREAM_ID });
    h.redis.expire.mockClear();

    await h.fire(a, "stream:heartbeat", { streamId: STREAM_ID });
    await h.fire(b, "stream:heartbeat", { streamId: STREAM_ID });

    expect(h.redis.expire).toHaveBeenCalledTimes(4);
  });

  it("still ignores a heartbeat from a socket that never joined", async () => {
    const h = harness();
    const viewer = h.connect("s1", "viewer-1");

    await h.fire(viewer, "stream:heartbeat", { streamId: STREAM_ID });

    expect(h.redis.expire).not.toHaveBeenCalled();
  });
});
