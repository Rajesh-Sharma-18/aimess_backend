/**
 * Session-revoke listener — logic-layer unit tests (same convention as
 * auth-ns.test.ts / community-typing.test.ts: fake `io`/namespace/socket
 * doubles, no real Socket.IO server).
 *
 * Verifies spec #7: revoking a linked device disconnects its LIVE socket
 * immediately, in whichever namespace(s) it's connected to — not just on
 * next reconnect/token-expiry.
 */
import { EventEmitter } from "node:events";

import { registerSessionRevokeListener } from "../../src/sockets/session-revoke.js";

class FakeSocket {
  data: { sessionId: string };
  disconnected = false;
  constructor(sessionId: string) {
    this.data = { sessionId };
  }
  disconnect(_close: boolean) {
    this.disconnected = true;
  }
}

class FakeNamespace {
  constructor(private sockets: FakeSocket[]) {}
  in(_room: string) {
    return { fetchSockets: async () => this.sockets };
  }
}

class FakeRedis extends EventEmitter {
  psubscribed: string[] = [];
  psubscribe(pattern: string) {
    this.psubscribed.push(pattern);
    return Promise.resolve();
  }
}

function setup(socketsByNs: Record<string, FakeSocket[]>) {
  const io = {
    of: (name: string) => new FakeNamespace(socketsByNs[name] ?? []),
  } as unknown as Parameters<typeof registerSessionRevokeListener>[0];
  const sub = new FakeRedis() as unknown as Parameters<
    typeof registerSessionRevokeListener
  >[1];

  registerSessionRevokeListener(io, sub);
  return sub as unknown as FakeRedis;
}

describe("session-revoke listener", () => {
  it("PSUBSCRIBEs to session-revoke:* once (durable, not per-user)", () => {
    const sub = setup({});
    expect(sub.psubscribed).toContain("session-revoke:*");
  });

  it("disconnects the matching socket in every live namespace, leaves other sessions alone", async () => {
    const matching = new FakeSocket("sess-revoked");
    const other = new FakeSocket("sess-other-device");
    const sub = setup({
      "/chat": [matching, other],
      "/community": [],
      "/notify": [matching],
      "/stream": [],
    });

    sub.emit(
      "pmessage",
      "session-revoke:*",
      "session-revoke:user-1",
      JSON.stringify({ sessionId: "sess-revoked" })
    );
    // fetchSockets() resolves on a microtask; flush it.
    await Promise.resolve();
    await Promise.resolve();

    expect(matching.disconnected).toBe(true);
    expect(other.disconnected).toBe(false);
  });

  it("ignores messages on unrelated channels", async () => {
    const socket = new FakeSocket("sess-1");
    const sub = setup({ "/chat": [socket] });

    sub.emit(
      "pmessage",
      "x",
      "unrelated:channel",
      JSON.stringify({ sessionId: "sess-1" })
    );
    await Promise.resolve();

    expect(socket.disconnected).toBe(false);
  });

  it("never throws on malformed JSON", () => {
    const sub = setup({});
    expect(() =>
      sub.emit(
        "pmessage",
        "session-revoke:*",
        "session-revoke:user-1",
        "{bad json"
      )
    ).not.toThrow();
  });
});
