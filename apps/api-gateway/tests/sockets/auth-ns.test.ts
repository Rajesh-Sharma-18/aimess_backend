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

function setup() {
  const namespace = new FakeNamespace();
  const io = { of: () => namespace } as unknown as Parameters<
    typeof registerAuthNamespace
  >[0];
  const redisSub = new FakeRedis() as unknown as Parameters<
    typeof registerAuthNamespace
  >[1];

  registerAuthNamespace(io, redisSub);

  return { namespace, redisSub: redisSub as unknown as FakeRedis };
}

describe("/auth namespace — auth:qr:subscribe", () => {
  it("joins room qr:<token> and subscribes the shared Redis channel", () => {
    const { namespace, redisSub } = setup();
    const socket = new FakeSocket();
    namespace.emit("connection", socket);

    socket.emit("auth:qr:subscribe", { token: "abc-123" });

    expect(socket.joined).toContain("qr:abc-123");
    expect(redisSub.subscribed).toContain("devlink:abc-123");
  });

  it("ignores a malformed payload (no token) — no join, no subscribe", () => {
    const { namespace, redisSub } = setup();
    const socket = new FakeSocket();
    namespace.emit("connection", socket);

    socket.emit("auth:qr:subscribe", {});

    expect(socket.joined).toHaveLength(0);
    expect(redisSub.subscribed).toHaveLength(0);
  });

  it("re-subscribing leaves the previous room before joining the new one", () => {
    const { namespace } = setup();
    const socket = new FakeSocket();
    namespace.emit("connection", socket);

    socket.emit("auth:qr:subscribe", { token: "first" });
    socket.emit("auth:qr:subscribe", { token: "second" });

    expect(socket.left).toContain("qr:first");
    expect(socket.joined).toContain("qr:second");
  });

  it("unsubscribes the Redis channel on disconnect", () => {
    const { namespace, redisSub } = setup();
    const socket = new FakeSocket();
    namespace.emit("connection", socket);

    socket.emit("auth:qr:subscribe", { token: "abc-123" });
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
