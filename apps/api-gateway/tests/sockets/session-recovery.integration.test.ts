/**
 * REAL Socket.IO + Redis integration test — no mocks — proving Scenario 2 of
 * the multi-device session-termination audit:
 *
 *   Device is online → loses internet (TCP dies mid-connection, no clean
 *   disconnect packet) → session is terminated from another device while
 *   offline → internet returns → engine.io auto-reconnects and, because
 *   Socket.IO's `connectionStateRecovery` restores the socket's prior rooms
 *   and data, tries to recover the SAME authenticated session.
 *
 * Root cause found in `node_modules/socket.io/dist/namespace.js` `_add()`:
 * when `connectionStateRecovery` is enabled, Socket.IO defaults
 * `skipMiddlewares` to `true` — meaning a recovered reconnect SKIPS
 * `namespace.use()` entirely (see `_createSocket` → `_add`: `if (... &&
 * socket.recovered && ...) return this._doConnect(socket, fn)`, bypassing
 * `this.run(socket, ...)`). A session revoked while the device was offline
 * would silently rejoin its rooms with zero re-authentication.
 *
 * `src/sockets/index.ts` now sets `skipMiddlewares: false`, forcing every
 * reconnect — recovered or not — back through
 * `createGatewaySocketAuthMiddleware`, which re-checks the session-active
 * Redis key (the same helper `@aimess/redis`'s `getActiveSessionFromCache`
 * used everywhere else in this system — no duplicate validation logic).
 *
 * This suite talks to a REAL Redis instance (docker-compose `aimess-redis`,
 * 127.0.0.1:6379 in this dev environment) and a REAL `socket.io-client` over
 * a REAL TCP connection — network loss is simulated by destroying the raw
 * TCP socket server-side (no `.disconnect()` call, so no clean DISCONNECT
 * packet — indistinguishable from a phone losing signal).
 *
 * Skips itself (with a console.warn, tests reported as passing/no-op) when
 * Redis isn't reachable — e.g. `pnpm test` run without `docker-compose up`.
 * `it.skip` isn't usable here: it must be decided at `describe`-body
 * collection time, before the async reachability probe (which needs
 * `beforeAll`) has run.
 */
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket as NetSocket } from "node:net";
import { randomUUID } from "node:crypto";
import { Server as SocketIOServer, type Namespace } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import IORedis from "ioredis";
import {
  registerActiveSession,
  revokeActiveSession,
  publishSessionRevokedEvent,
} from "@aimess/redis";

import { createGatewaySocketAuthMiddleware } from "../../src/sockets/auth.middleware.js";
import { registerSessionRevokeListener } from "../../src/sockets/session-revoke.js";
import { makeAccessToken } from "../helpers/auth.js";

const REDIS_HOST = "127.0.0.1";
const REDIS_PORT = 6379;

async function isRedisReachable(): Promise<boolean> {
  const probe = new IORedis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    lazyConnect: true,
    connectTimeout: 3000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

/** Builds one real io.Server for a test, wired exactly like a production namespace. */
function buildServer(opts: {
  skipMiddlewares: boolean;
  redisForAuth: IORedis;
  /** `registerSessionRevokeListener`'s LIVE_NAMESPACES is hardcoded to the
   *  production namespace names — use one of them ("/notify") when a test
   *  needs the auth:session_terminated emit to actually reach the client. */
  nsName?: string;
}): {
  httpServer: HttpServer;
  io: SocketIOServer;
  ns: Namespace;
  rawSockets: NetSocket[];
} {
  const httpServer = createServer();
  const rawSockets: NetSocket[] = [];
  httpServer.on("connection", (sock) => rawSockets.push(sock));

  const io = new SocketIOServer(httpServer, {
    connectionStateRecovery: {
      maxDisconnectionDuration: 10_000,
      skipMiddlewares: opts.skipMiddlewares,
    },
  });

  // Mirrors notify.ns.ts / chat.ns.ts / community.ns.ts: auth middleware, then
  // join `user:<userId>` + `session:<sessionId>` on connect.
  const ns = io.of(opts.nsName ?? "/test");
  ns.use(createGatewaySocketAuthMiddleware(opts.redisForAuth));
  ns.on("connection", (socket) => {
    void socket.join(`user:${socket.data.userId}`);
    void socket.join(`session:${socket.data.sessionId}`);
    // Real namespaces always emit at least one event right after connect
    // (e.g. /notify's `notification:count`). Socket.IO only records a
    // recoverable `offset` on the client from a received event packet — with
    // zero packets sent, `auth.pid`/`auth.offset` would never be set on
    // reconnect and connectionStateRecovery could never engage, making this
    // harness silently fail to exercise the recovery path it exists to test.
    socket.emit("welcome", {});
  });

  return { httpServer, io, ns, rawSockets };
}

function listen(httpServer: HttpServer): Promise<number> {
  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      resolve((httpServer.address() as AddressInfo).port);
    });
  });
}

function waitForEvent<T = unknown>(
  emitter: { once: (event: string, cb: (...args: unknown[]) => void) => void },
  event: string,
  timeoutMs = 5000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for "${event}"`)),
      timeoutMs
    );
    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args[0] as T);
    });
  });
}

describe("real Socket.IO + Redis: session-recovery reconnect gate", () => {
  let redisReachable = false;
  let redis: IORedis;
  let sessionRevokeSub: IORedis;

  beforeAll(async () => {
    redisReachable = await isRedisReachable();
    if (!redisReachable) {
      console.warn(
        "[session-recovery.integration] Redis unreachable at 127.0.0.1:6379 — skipping real-infra assertions (docker-compose up?)."
      );
      return;
    }
    redis = new IORedis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      lazyConnect: true,
    });
    sessionRevokeSub = new IORedis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      lazyConnect: true,
    });
    await Promise.all([redis.connect(), sessionRevokeSub.connect()]);
  });

  afterAll(async () => {
    if (!redisReachable) return;
    redis.disconnect();
    sessionRevokeSub.disconnect();
  });

  // --- Scenario 1: already-online device, terminated live -------------------
  it("online device: receives auth:session_terminated then is disconnected", async () => {
    if (!redisReachable) return;

    const userId = randomUUID();
    const sessionId = randomUUID();
    await registerActiveSession(redis, sessionId, 60);

    const { httpServer, io } = buildServer({
      skipMiddlewares: false,
      redisForAuth: redis,
      // registerSessionRevokeListener only emits to the production
      // namespace names (LIVE_NAMESPACES) — use a real one so the
      // auth:session_terminated emit actually reaches this client.
      nsName: "/notify",
    });
    registerSessionRevokeListener(io, sessionRevokeSub);
    await sessionRevokeSub.psubscribe("session-revoke:*");
    const port = await listen(httpServer);

    const token = makeAccessToken({ userId, sessionId });
    const client: ClientSocket = ioClient(`http://127.0.0.1:${port}/notify`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
    });

    try {
      await waitForEvent(client, "connect");

      const terminatedEvent = waitForEvent<{ sessionId: string }>(
        client,
        "auth:session_terminated"
      );
      const disconnected = waitForEvent(client, "disconnect");

      // "Another device" terminates this session — reuses the real
      // production publish helper (@aimess/redis `publishSessionRevokedEvent`).
      await revokeActiveSession(redis, sessionId, 60);
      await publishSessionRevokedEvent(redis, userId, sessionId);

      const payload = await terminatedEvent;
      expect(payload.sessionId).toBe(sessionId);
      await disconnected;
      expect(client.connected).toBe(false);
    } finally {
      client.close();
      io.close();
      httpServer.close();
    }
  }, 15000);

  // --- Scenario 2: THE GAP — silent network loss + offline termination -----
  it("FIXED (skipMiddlewares: false): reconnect after silent network loss + offline termination is REJECTED", async () => {
    if (!redisReachable) return;

    const userId = randomUUID();
    const sessionId = randomUUID();
    await registerActiveSession(redis, sessionId, 60);

    const { httpServer, io, ns, rawSockets } = buildServer({
      skipMiddlewares: false,
      redisForAuth: redis,
    });
    const port = await listen(httpServer);

    const token = makeAccessToken({ userId, sessionId });
    const client: ClientSocket = ioClient(`http://127.0.0.1:${port}/test`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 100,
      reconnectionDelayMax: 200,
    });

    try {
      await waitForEvent(client, "connect");
      expect((await ns.in(`session:${sessionId}`).fetchSockets()).length).toBe(
        1
      );

      // Simulate the device losing internet: kill the raw TCP pipe with no
      // close handshake — NOT client.disconnect() (which is a clean,
      // non-recoverable close per Socket.IO's RECOVERABLE_DISCONNECT_REASONS).
      expect(rawSockets.length).toBeGreaterThan(0);
      for (const sock of rawSockets.splice(0)) sock.destroy();

      // "Another device" terminates the session WHILE this one is offline —
      // reuses the exact production revoke helper.
      await revokeActiveSession(redis, sessionId, 60);

      // Reconnection is automatic (engine.io-client). It must fail.
      const connectError = await waitForEvent(client, "connect_error", 8000);
      expect(connectError).toBeDefined();
      expect(client.connected).toBe(false);

      // No room membership survived the rejected reconnect.
      expect((await ns.in(`session:${sessionId}`).fetchSockets()).length).toBe(
        0
      );
      expect((await ns.in(`user:${userId}`).fetchSockets()).length).toBe(0);
    } finally {
      client.close();
      io.close();
      httpServer.close();
    }
  }, 15000);

  // --- Same scenario, WITHOUT the fix — proves the fix is load-bearing ------
  it("UNFIXED (skipMiddlewares: true, Socket.IO's own default): reconnect after silent network loss + offline termination SUCCEEDS — this is the bug the fix closes", async () => {
    if (!redisReachable) return;

    const userId = randomUUID();
    const sessionId = randomUUID();
    await registerActiveSession(redis, sessionId, 60);

    const { httpServer, io, ns, rawSockets } = buildServer({
      skipMiddlewares: true,
      redisForAuth: redis,
    });
    const port = await listen(httpServer);

    const token = makeAccessToken({ userId, sessionId });
    const client: ClientSocket = ioClient(`http://127.0.0.1:${port}/test`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 100,
      reconnectionDelayMax: 200,
    });

    try {
      await waitForEvent(client, "connect");

      for (const sock of rawSockets.splice(0)) sock.destroy();
      await revokeActiveSession(redis, sessionId, 60);

      // Without the fix, the recovered reconnect skips auth middleware
      // entirely and just reconnects — proving the bug is real, not
      // theoretical.
      await waitForEvent(client, "connect", 8000);
      expect(client.connected).toBe(true);
      expect((await ns.in(`session:${sessionId}`).fetchSockets()).length).toBe(
        1
      );
    } finally {
      client.close();
      io.close();
      httpServer.close();
    }
  }, 15000);

  // --- Sanity: brand-new (non-recovered) connect attempt with an already-
  //     revoked session is rejected too (already covered by unit tests; kept
  //     here once for real-infra confidence in the same harness). ------------
  it("brand-new connection attempt with an already-revoked session is rejected", async () => {
    if (!redisReachable) return;

    const sessionId = randomUUID();
    await revokeActiveSession(redis, sessionId, 60);

    const { httpServer } = buildServer({
      skipMiddlewares: false,
      redisForAuth: redis,
    });
    const port = await listen(httpServer);

    const token = makeAccessToken({ sessionId });
    const client: ClientSocket = ioClient(`http://127.0.0.1:${port}/test`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
    });

    try {
      await waitForEvent(client, "connect_error");
      expect(client.connected).toBe(false);
    } finally {
      client.close();
      httpServer.close();
    }
  }, 10000);
});
