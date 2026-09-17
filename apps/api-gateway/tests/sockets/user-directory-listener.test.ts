/**
 * The relay that gets a Super Admin ban to an ordinary reader's open search.
 *
 * backoffice-service publishes on `broadcast:user-directory`; this listener is
 * what turns that into one `user:directory_changed` on /notify, which the
 * website answers by re-reading people discovery. Without it a banned account
 * kept rendering as discoverable in a search panel that was already open —
 * the backend excluded the row, but nothing told the client to ask again.
 *
 * Unit-tested against fakes rather than a live Socket.IO server, the same way
 * community-ban-eviction.test.ts tests its own relay: the contract here is
 * "which channel, which namespace, what payload", and all three are observable
 * without a socket.
 */
import { registerUserDirectoryListener } from "../../src/sockets/user-directory-listener.js";

type Emit = { event: string; data: unknown };

/** Records what each namespace was asked to broadcast. */
function fakeIo() {
  const emitsByNamespace = new Map<string, Emit[]>();
  const io = {
    of(namespace: string) {
      return {
        emit(event: string, data: unknown) {
          const list = emitsByNamespace.get(namespace) ?? [];
          list.push({ event, data });
          emitsByNamespace.set(namespace, list);
        },
      };
    },
  };
  return { io, emitsByNamespace };
}

/** The shared session-revoke PSUBSCRIBE connection, as this listener sees it. */
function fakeSub() {
  const handlers: ((p: string, channel: string, message: string) => void)[] = [];
  const patterns: string[] = [];
  return {
    sub: {
      on(event: string, handler: (typeof handlers)[number]) {
        if (event === "pmessage") handlers.push(handler);
      },
      psubscribe(pattern: string) {
        patterns.push(pattern);
        return Promise.resolve(1);
      },
    },
    patterns,
    deliver(channel: string, message = JSON.stringify({ data: {} })) {
      for (const handler of handlers) handler(channel, channel, message);
    },
  };
}

const register = (io: unknown, sub: unknown) =>
  registerUserDirectoryListener(io as any, sub as any);

describe("user-directory listener", () => {
  it("subscribes to the directory channel", () => {
    const { io } = fakeIo();
    const { sub, patterns } = fakeSub();

    register(io, sub);

    expect(patterns).toEqual(["broadcast:user-directory"]);
  });

  it("broadcasts one payload-free event on /notify", () => {
    const { io, emitsByNamespace } = fakeIo();
    const { sub, deliver } = fakeSub();
    register(io, sub);

    deliver("broadcast:user-directory");

    // Empty payload is the privacy contract: naming the moderated account would
    // tell every connected user who was just banned. "Re-read discovery" tells
    // them nothing they could not learn by searching.
    expect(emitsByNamespace.get("/notify")).toEqual([
      { event: "user:directory_changed", data: {} },
    ]);
  });

  it("reaches /notify and nothing else", () => {
    const { io, emitsByNamespace } = fakeIo();
    const { sub, deliver } = fakeSub();
    register(io, sub);

    deliver("broadcast:user-directory");

    expect([...emitsByNamespace.keys()]).toEqual(["/notify"]);
  });

  it("ignores every other channel on the shared connection", () => {
    // This handler sits on the SAME pmessage connection as the session-revoke
    // and session-created listeners: each receives every message and filters.
    // A prefix match here would fire on `broadcast:user-directory-anything`.
    const { io, emitsByNamespace } = fakeIo();
    const { sub, deliver } = fakeSub();
    register(io, sub);

    deliver("session-revoke:user-1", JSON.stringify({ sessionId: "s1" }));
    deliver("user-ban:user-1", JSON.stringify({ event: "user:banned" }));
    deliver("session-created:user-1", JSON.stringify({ session: {} }));
    deliver("broadcast:user-directory:extra");

    expect(emitsByNamespace.size).toBe(0);
  });

  it("emits once per published action, so a bulk ban is one refetch", () => {
    const { io, emitsByNamespace } = fakeIo();
    const { sub, deliver } = fakeSub();
    register(io, sub);

    deliver("broadcast:user-directory");
    deliver("broadcast:user-directory");

    expect(emitsByNamespace.get("/notify")).toHaveLength(2);
  });

  it("survives a malformed message — the payload is never read", () => {
    // The event carries no data, so there is nothing to parse and nothing a bad
    // publisher can do to stop the relay. A throw here would land on the shared
    // connection and take the session-revoke listeners with it.
    const { io, emitsByNamespace } = fakeIo();
    const { sub, deliver } = fakeSub();
    register(io, sub);

    expect(() => deliver("broadcast:user-directory", "{not json")).not.toThrow();
    expect(emitsByNamespace.get("/notify")).toHaveLength(1);
  });
});
