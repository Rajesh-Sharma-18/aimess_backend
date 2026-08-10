/**
 * `/auth` namespace (QR device-link login) — logic-layer unit tests.
 *
 * Full Socket.IO integration (live server + socket.io-client) is out of scope
 * here, matching this suite's existing convention (see community-typing.test.ts):
 * fake `io`/`Namespace`/`Socket`/`redisSub` doubles exercise the actual
 * `registerAuthNamespace` handler logic — room join/leave on
 * `auth:qr:subscribe`, and the Redis `devlink:<token>` → room `qr:<token>`
 * relay — without booting a real server.
 */
import { EventEmitter } from "node:events";

import { registerAuthNamespace } from "../../src/sockets/namespaces/auth.ns.js";

class FakeSocket extends EventEmitter {
  joined: string[] = [];
  left: string[] = [];
  join(room: string) {
    this.joined.push(room);
    return Promise.resolve();
  }
  leave(room: string) {
    this.left.push(room);
    return Promise.resolve();
  }
}

class FakeNamespace extends EventEmitter {
  emittedTo: Array<{ room: string; event: string; data: unknown }> = [];
  to(room: string) {
    return {
      emit: (event: string, data: unknown) => {
        this.emittedTo.push({ room, event, data });
      },
    };
  }
}

class FakeRedis extends EventEmitter {
  subscribed: string[] = [];
  unsubscribed: string[] = [];
  subscribe(channel: string) {
    this.subscribed.push(channel);
    return Promise.resolve();
  }
  unsubscribe(channel: string) {
    this.unsubscribed.push(channel);
    return Promise.resolve();
  }
}

/** Regular client: only `eval` is exercised (the GET+DEL mailbox take). */
class FakeRedisCommands {
  results = new Map<string, string>();
  evalKeys: string[] = [];
  eval(_script: string, _numKeys: number, key: string) {
    this.evalKeys.push(key);
    const value = this.results.get(key) ?? null;
    this.results.delete(key);
    return Promise.resolve(value);
  }
}

/** Let the subscribe handler's async chain settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup() {
  const namespace = new FakeNamespace();
  const io = { of: () => namespace } as unknown as Parameters<
    typeof registerAuthNamespace
  >[0];
  const redisSub = new FakeRedis() as unknown as Parameters<
    typeof registerAuthNamespace
  >[1];
  const redis = new FakeRedisCommands();

  registerAuthNamespace(
    io,
    redisSub,
    redis as unknown as Parameters<typeof registerAuthNamespace>[2]
  );

  return { namespace, redisSub: redisSub as unknown as FakeRedis, redis };
}

describe("/auth namespace — auth:qr:subscribe", () => {
  it("joins room qr:<token> and subscribes the shared Redis channel", async () => {
    const { namespace, redisSub } = setup();
    const socket = new FakeSocket();
    namespace.emit("connection", socket);

    socket.emit("auth:qr:subscribe", { token: "abc-123" });
    await flush();

    expect(socket.joined).toContain("qr:abc-123");
    expect(redisSub.subscribed).toContain("devlink:abc-123");
  });

  it("ignores a malformed payload (no token) — no join, no subscribe", async () => {
    const { namespace, redisSub } = setup();
    const socket = new FakeSocket();
    namespace.emit("connection", socket);

    socket.emit("auth:qr:subscribe", {});
    await flush();

    expect(socket.joined).toHaveLength(0);
    expect(redisSub.subscribed).toHaveLength(0);
  });

  it("replays a success published while the browser was not subscribed", async () => {
    const { namespace, redis } = setup();
    const socket = new FakeSocket();
    const received: Array<{ event: string; data: unknown }> = [];
    socket.emit = ((event: string, data: unknown) => {
      received.push({ event, data });
      return true;
    }) as any;
    namespace.emit("connection", socket);

    redis.results.set(
      "aimess:devlink:result:abc-123",
      JSON.stringify({
        event: "auth:qr:success",
        data: { linkToken: "abc-123", accessToken: "at" },
      })
    );

    // Re-emit through the EventEmitter internals since `emit` is stubbed above.
    EventEmitter.prototype.emit.call(socket, "auth:qr:subscribe", {
      token: "abc-123",
    });
    await flush();

    expect(received).toContainEqual({
      event: "auth:qr:success",
      data: { linkToken: "abc-123", accessToken: "at" },
    });
  });

  it("emits nothing when no pending success is waiting", async () => {
    const { namespace, redis } = setup();
    const socket = new FakeSocket();
    const received: string[] = [];
    socket.emit = ((event: string) => {
      received.push(event);
      return true;
    }) as any;
    namespace.emit("connection", socket);

    EventEmitter.prototype.emit.call(socket, "auth:qr:subscribe", {
      token: "nothing-pending",
    });
    await flush();

    expect(redis.evalKeys).toContain("aimess:devlink:result:nothing-pending");
    expect(received).toHaveLength(0);
  });

  it("re-subscribing leaves the previous room before joining the new one", async () => {
    const { namespace } = setup();
    const socket = new FakeSocket();
    namespace.emit("connection", socket);

    socket.emit("auth:qr:subscribe", { token: "first" });
    await flush();
    socket.emit("auth:qr:subscribe", { token: "second" });
    await flush();

    expect(socket.left).toContain("qr:first");
    expect(socket.joined).toContain("qr:second");
  });

  it("unsubscribes the Redis channel on disconnect", async () => {
    const { namespace, redisSub } = setup();
    const socket = new FakeSocket();
    namespace.emit("connection", socket);

    socket.emit("auth:qr:subscribe", { token: "abc-123" });
    await flush();
    socket.emit("disconnect");

    expect(redisSub.unsubscribed).toContain("devlink:abc-123");
  });
});

describe("/auth namespace — Redis devlink:<token> relay", () => {
  it("relays a devlink message to room qr:<token> under the original event name", () => {
    const { namespace, redisSub } = setup();

    redisSub.emit(
      "message",
      "devlink:abc-123",
      JSON.stringify({
        event: "auth:qr:success",
        data: { linkToken: "abc-123" },
      })
    );

    expect(namespace.emittedTo).toContainEqual({
      room: "qr:abc-123",
      event: "auth:qr:success",
      data: { linkToken: "abc-123" },
    });
  });

  it("ignores messages on unrelated Redis channels", () => {
    const { namespace, redisSub } = setup();

    redisSub.emit(
      "message",
      "notify:some-user",
      JSON.stringify({ event: "x", data: {} })
    );

    expect(namespace.emittedTo).toHaveLength(0);
  });

  it("never throws on malformed JSON — logs and continues", () => {
    const { namespace, redisSub } = setup();

    expect(() =>
      redisSub.emit("message", "devlink:abc-123", "{not json")
    ).not.toThrow();
    expect(namespace.emittedTo).toHaveLength(0);
  });
});
