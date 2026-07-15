/**
 * registerSessionCreatedListener — relays auth-service's `session-created:<userId>`
 * Redis signal to the user's every live device as the existing
 * `session:list_updated` event (action "created"), emitted on `/notify` only,
 * so linked-device lists refresh without polling. Pure fan-out logic; fakes
 * stand in for Socket.IO + the Redis subscriber (no network).
 */
import { EventEmitter } from "node:events";
import type { Server as SocketIOServer } from "socket.io";
import type { Redis } from "ioredis";

import { registerSessionCreatedListener } from "../../src/sockets/session-created-listener.js";

type Emit = { room: string; event: string; payload: unknown };

function makeIo() {
  const emits: Emit[] = [];
  const namespaces: string[] = [];
  const io = {
    of(ns: string) {
      namespaces.push(ns);
      return {
        to(room: string) {
          return {
            emit(event: string, payload: unknown) {
              emits.push({ room, event, payload });
            },
          };
        },
      };
    },
  } as unknown as SocketIOServer;
  return { io, emits, namespaces };
}

function makeSub() {
  const ee = new EventEmitter();
  const patterns: string[] = [];
  const sub = Object.assign(ee, {
    psubscribe: (p: string) => {
      patterns.push(p);
      return Promise.resolve(1);
    },
  }) as unknown as Redis;
  return { sub, patterns, fire: ee };
}

const SESSION = { sessionId: "sess-9", deviceName: "iOS", isCurrent: false };

describe("registerSessionCreatedListener", () => {
  it("emits session:list_updated to user:<id> on /notify only", () => {
    const { io, emits, namespaces } = makeIo();
    const { sub, patterns, fire } = makeSub();

    registerSessionCreatedListener(io, sub);
    expect(patterns).toContain("session-created:*");

    fire.emit(
      "pmessage",
      "session-created:*",
      "session-created:user-1",
      JSON.stringify({ session: SESSION })
    );

    expect(emits).toHaveLength(1);
    expect(namespaces).toEqual(["/notify"]);
    expect(emits[0]).toEqual({
      room: "user:user-1",
      event: "session:list_updated",
      payload: { action: "created", session: SESSION },
    });
  });

  it("ignores messages on unrelated channels", () => {
    const { io, emits } = makeIo();
    const { sub, fire } = makeSub();
    registerSessionCreatedListener(io, sub);

    fire.emit(
      "pmessage",
      "session-revoke:*",
      "session-revoke:user-1",
      JSON.stringify({ sessionId: "x" })
    );

    expect(emits).toHaveLength(0);
  });

  it("swallows malformed JSON without emitting", () => {
    const { io, emits } = makeIo();
    const { sub, fire } = makeSub();
    registerSessionCreatedListener(io, sub);

    fire.emit(
      "pmessage",
      "session-created:*",
      "session-created:user-1",
      "{not json"
    );

    expect(emits).toHaveLength(0);
  });
});
