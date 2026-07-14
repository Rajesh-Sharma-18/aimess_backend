/**
 * Session-revoke listener — logic-layer unit tests (same convention as
 * auth-ns.test.ts / community-typing.test.ts: fake `io`/namespace/socket
 * doubles, no real Socket.IO server).
 *
 * Verifies spec #7-#9: revoking a linked device (a) emits
 * `auth:session_terminated` to ONLY that device's `session:<id>` room,
 * (b) disconnects its LIVE socket immediately in whichever namespace(s) it's
 * connected to, and (c) emits `session:list_updated` to the user's other
 * devices (`user:<id>` room) so linked-device lists refresh without polling.
 */
import { EventEmitter } from "node:events";

import { registerSessionRevokeListener } from "../../src/sockets/session-revoke.js";

class FakeSocket {
  disconnected = false;
  disconnect(_close: boolean) {
    this.disconnected = true;
  }
}

type Emitted = { room: string; event: string; data: unknown };

class FakeNamespace {
  emitted: Emitted[] = [];
  constructor(private socketsByRoom: Record<string, FakeSocket[]>) {}
  to(room: string) {
    return {
      emit: (event: string, data: unknown) => {
        this.emitted.push({ room, event, data });
      },
    };
  }
  in(room: string) {
    return { fetchSockets: async () => this.socketsByRoom[room] ?? [] };
  }
}

class FakeRedis extends EventEmitter {
  psubscribed: string[] = [];
  psubscribe(pattern: string) {
    this.psubscribed.push(pattern);
    return Promise.resolve();
  }
}

function setup(nsRooms: Record<string, Record<string, FakeSocket[]>>) {
  const namespaces: Record<string, FakeNamespace> = {};
  const io = {
    of: (name: string) => {
      namespaces[name] ??= new FakeNamespace(nsRooms[name] ?? {});
      return namespaces[name];
    },
  } as unknown as Parameters<typeof registerSessionRevokeListener>[0];
  const sub = new FakeRedis() as unknown as Parameters<
    typeof registerSessionRevokeListener
  >[1];

  registerSessionRevokeListener(io, sub);
  return { sub: sub as unknown as FakeRedis, namespaces };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("session-revoke listener", () => {
  it("PSUBSCRIBEs to session-revoke:* once (durable, not per-user)", () => {
    const { sub } = setup({});
    expect(sub.psubscribed).toContain("session-revoke:*");
  });

  it("disconnects sockets in the terminated session's room, leaves other sessions' sockets alone", async () => {
    const revokedSocket = new FakeSocket();
    const otherSocket = new FakeSocket();
    const { sub, namespaces } = setup({
      "/chat": {
        "session:sess-revoked": [revokedSocket],
        "session:sess-other-device": [otherSocket],
      },
      "/community": {},
      "/notify": { "session:sess-revoked": [revokedSocket] },
      "/stream": {},
    });

    sub.emit(
      "pmessage",
      "session-revoke:*",
      "session-revoke:user-1",
      JSON.stringify({ sessionId: "sess-revoked" })
    );
    await flush();

    expect(revokedSocket.disconnected).toBe(true);
    expect(otherSocket.disconnected).toBe(false);
    void namespaces;
  });

  it("emits auth:session_terminated to the terminated session's room only, in every live namespace", async () => {
    const { sub, namespaces } = setup({
      "/chat": {},
      "/community": {},
      "/notify": {},
      "/stream": {},
    });

    sub.emit(
      "pmessage",
      "session-revoke:*",
      "session-revoke:user-1",
      JSON.stringify({ sessionId: "sess-revoked" })
    );
    await flush();

    for (const nsName of ["/chat", "/community", "/notify", "/stream"]) {
      const terminated = namespaces[nsName].emitted.find(
        (e) => e.event === "auth:session_terminated"
      );
      expect(terminated).toEqual({
        room: "session:sess-revoked",
        event: "auth:session_terminated",
        data: {
          sessionId: "sess-revoked",
          reason: "terminated",
          message: "Your session has been terminated.",
        },
      });
    }
  });

  it("emits session:list_updated to the user's room in every live namespace", async () => {
    const { sub, namespaces } = setup({
      "/chat": {},
      "/community": {},
      "/notify": {},
      "/stream": {},
    });

    sub.emit(
      "pmessage",
      "session-revoke:*",
      "session-revoke:user-1",
      JSON.stringify({ sessionId: "sess-revoked" })
    );
    await flush();

    for (const nsName of ["/chat", "/community", "/notify", "/stream"]) {
      const listUpdated = namespaces[nsName].emitted.find(
        (e) => e.event === "session:list_updated"
      );
      expect(listUpdated).toEqual({
        room: "user:user-1",
        event: "session:list_updated",
        data: { action: "terminated", sessionId: "sess-revoked" },
      });
    }
  });

  it("ignores messages on unrelated channels", async () => {
    const socket = new FakeSocket();
    const { sub } = setup({ "/chat": { "session:sess-1": [socket] } });

    sub.emit(
      "pmessage",
      "x",
      "unrelated:channel",
      JSON.stringify({ sessionId: "sess-1" })
    );
    await flush();

    expect(socket.disconnected).toBe(false);
  });

  it("never throws on malformed JSON", () => {
    const { sub } = setup({});
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
