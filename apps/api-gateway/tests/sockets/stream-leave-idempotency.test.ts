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
  return {
    hashes,
    hincrby: jest.fn(async (key: string, field: string, by: number) => {
      const h = hash(key);
      const next = Number(h.get(field) ?? 0) + by;
      h.set(field, String(next));
      return next;
    }),
    hdel: jest.fn(async (key: string, field: string) => {
      return hash(key).delete(field) ? 1 : 0;
    }),
    hlen: jest.fn(async (key: string) => hash(key).size),
    hsetnx: jest.fn(async (key: string, field: string, value: string) => {
      const h = hash(key);
      if (h.has(field)) return 0;
      h.set(field, value);
      return 1;
    }),
    expire: jest.fn(async () => 1),
    incr: jest.fn(async () => 1),
    psubscribe: jest.fn(async () => undefined),
    on: jest.fn(),
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
      // `disconnecting` takes no ack — resolve once its async work is queued.
      if (event === "disconnecting") setImmediate(resolve);
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
