/**
 * Cross-user Socket.IO isolation on /chat — REAL namespace, REAL socket.io-client.
 *
 * Two leaks are locked down here, both found by driving four authenticated
 * sessions against a running gateway and reading their raw `onAny` streams:
 *
 *  1. `presence:subscribe` used to put the WATCHER's socket into the peer's
 *     `user:<peerId>` room — the same room chat-service publishes every event
 *     addressed to that person on. Watching a peer's online dot therefore
 *     delivered their `message:new` (body, sender, media), `message:delivered`,
 *     `message:read` / `read_sync`, and typing to a complete stranger. The web
 *     client subscribes to every inbox peer, so this fired constantly.
 *     Watchers now join `presence:<peerId>`, which carries `presence:status`
 *     and nothing else.
 *
 *  2. `conv:join` was membership-gated for GROUP but not for PRIVATE, and the
 *     conversation id is client-supplied — so any authenticated socket could
 *     emit `conv:join {conversationId: "<someone else's room>"}` and receive
 *     that room's live broadcasts. Both kinds are gated now.
 *
 * The whole namespace is registered for real; only the gRPC clients and Redis
 * handles are fakes, so the room wiring under test is the shipped wiring.
 */
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as SocketIOServer } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

import { registerChatNamespace } from "../../src/sockets/namespaces/chat.ns.js";
import { makeAccessToken } from "../helpers/auth.js";

const ALICE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"; // sender
const BOB = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"; // recipient
const EVE = "eeeeeeee-3333-4333-8333-eeeeeeeeeeee"; // uninvolved watcher
const ROOM = "prv_alice_bob";

/** Redis stand-in: captures the pmessage handler so tests can inject events. */
function fakeRedis(): {
  redis: unknown;
  emitPmessage: (pattern: string, channel: string, payload: unknown) => void;
} {
  let handler:
    | ((pattern: string, channel: string, message: string) => void)
    | undefined;
  const redis = {
    psubscribe: () => Promise.resolve(),
    subscribe: () => Promise.resolve(),
    on: (event: string, cb: unknown) => {
      if (event === "pmessage")
        handler = cb as (p: string, c: string, m: string) => void;
      return redis;
    },
    // `getActiveSessionFromCache` reads through this; rejecting makes the
    // middleware fail open, which is its documented Redis-hiccup behaviour.
    get: () => Promise.reject(new Error("no redis in test")),
    set: () => Promise.resolve("OK"),
    del: () => Promise.resolve(1),
    exists: () => Promise.resolve(0),
    incr: () => Promise.resolve(1),
    expire: () => Promise.resolve(1),
    publish: () => Promise.resolve(1),
  };
  return {
    redis,
    emitPmessage: (pattern, channel, payload) =>
      handler?.(pattern, channel, JSON.stringify(payload)),
  };
}

const messagingClient = {
  // Only ALICE and BOB are in ROOM. Anything else resolves to an empty roster.
  getRoomParticipantIds: ({ conversationId }: { conversationId: string }) =>
    Promise.resolve({
      userIds: conversationId === ROOM ? [ALICE, BOB] : [],
      mutedUserIds: [],
    }),
  presenceConnect: () => Promise.resolve({}),
  presenceDisconnect: () => Promise.resolve({}),
  presenceHeartbeat: () => Promise.resolve({}),
} as never;

const userClient = {
  // Everyone may see everyone's presence — the permissive case, so a pass here
  // is not an artefact of presence being denied.
  filterVisiblePresence: (_viewer: string, peerIds: string[]) =>
    Promise.resolve(peerIds),
  bulkGetUserSnapshots: () => Promise.resolve([]),
} as never;

const mediaClient = {
  generateDownloadUrl: () => Promise.resolve(null),
} as never;

function connect(port: number, userId: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const s = ioClient(`http://127.0.0.1:${String(port)}/chat`, {
      auth: { token: makeAccessToken({ userId, sessionId: `sess-${userId}` }) },
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
  });
}

const ack = (s: ClientSocket, event: string, payload: unknown): Promise<any> =>
  new Promise((resolve) => {
    let done = false;
    s.emit(event, payload, (res: unknown) => {
      done = true;
      resolve(res);
    });
    setTimeout(() => !done && resolve({ timeout: true }), 2000);
  });

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 150));

describe("/chat cross-user room isolation", () => {
  let httpServer: HttpServer;
  let io: SocketIOServer;
  let port: number;
  let emitPmessage: (p: string, c: string, payload: unknown) => void;
  let alice: ClientSocket;
  let bob: ClientSocket;
  let eve: ClientSocket;
  let eveEvents: Array<{ event: string; payload: unknown }>;
  let bobEvents: Array<{ event: string; payload: unknown }>;

  beforeAll(async () => {
    httpServer = createServer();
    io = new SocketIOServer(httpServer);
    const sub = fakeRedis();
    const pub = fakeRedis();
    emitPmessage = sub.emitPmessage;
    registerChatNamespace(
      io,
      messagingClient,
      sub.redis as never,
      pub.redis as never,
      userClient,
      mediaClient
    );
    port = await new Promise((resolve) =>
      httpServer.listen(0, "127.0.0.1", () =>
        resolve((httpServer.address() as AddressInfo).port)
      )
    );

    [alice, bob, eve] = await Promise.all([
      connect(port, ALICE),
      connect(port, BOB),
      connect(port, EVE),
    ]);
    eveEvents = [];
    bobEvents = [];
    eve.onAny((event, payload) => eveEvents.push({ event, payload }));
    bob.onAny((event, payload) => bobEvents.push({ event, payload }));

    // Eve watches Bob's presence — exactly what the web client does for every
    // row in the inbox, and the move that used to open the leak.
    await ack(eve, "presence:subscribe", { peerIds: [BOB] });
    await settle();
  });

  afterAll(async () => {
    for (const s of [alice, bob, eve]) s?.disconnect();
    io.close();
    await new Promise((r) => httpServer.close(() => r(undefined)));
  });

  beforeEach(() => {
    eveEvents.length = 0;
    bobEvents.length = 0;
  });

  it("a presence watcher receives presence:status for the peer they watch", async () => {
    emitPmessage("user:*", `user:${BOB}`, {
      event: "presence:status",
      data: { userId: BOB, isOnline: true },
    });
    await settle();
    expect(eveEvents.map((e) => e.event)).toContain("presence:status");
  });

  it.each([
    ["message:new", { id: "m1", roomId: ROOM, contentText: "secret" }],
    ["message:delivered", { conversationId: ROOM, recipientId: BOB }],
    ["message:read", { conversationId: ROOM, readerId: BOB }],
    ["read_sync", { conversationId: ROOM, readerId: BOB }],
    ["conv:updated", { roomId: ROOM, lastMessage: { text: "secret" } }],
    ["chat:unread_summary", { total: 7 }],
  ])(
    "a presence watcher receives NOTHING else from the peer's user:<id> channel — %s",
    async (event, data) => {
      emitPmessage("user:*", `user:${BOB}`, { event, data });
      await settle();
      expect(eveEvents).toEqual([]);
      // …and the owner still gets their own copy.
      expect(bobEvents.map((e) => e.event)).toContain(event);
    }
  );

  it("rejects conv:join for a private room the caller is not a participant of", async () => {
    const res = await ack(eve, "conv:join", { conversationId: ROOM });
    expect(res.success).toBe(false);
    expect(res.error).toBe("FORBIDDEN");
  });

  it("rejects conv:join for a room id the caller invented", async () => {
    const res = await ack(eve, "conv:join", {
      conversationId: "prv_made_up",
      conversationType: "private",
    });
    expect(res.success).toBe(false);
  });

  it("still admits an actual participant (typed and untyped)", async () => {
    // The shipped web client omits conversationType on DM joins.
    await expect(
      ack(alice, "conv:join", { conversationId: ROOM })
    ).resolves.toMatchObject({ success: true });
    await expect(
      ack(bob, "conv:join", {
        conversationId: ROOM,
        conversationType: "private",
      })
    ).resolves.toMatchObject({ success: true });
  });

  it("does not deliver conv:<room> broadcasts to a socket that was refused the join", async () => {
    await ack(eve, "conv:join", { conversationId: ROOM });
    await ack(alice, "conv:join", { conversationId: ROOM });
    eveEvents.length = 0;
    emitPmessage("conv:*", `conv:${ROOM}`, {
      event: "message:new",
      data: {
        id: "m2",
        roomId: ROOM,
        contentText: "PRIVATE_TEST_MESSAGE_12345",
      },
    });
    await settle();
    expect(JSON.stringify(eveEvents)).not.toContain(
      "PRIVATE_TEST_MESSAGE_12345"
    );
  });

  it("presence:list reports watched peers, and unsubscribe_all clears them", async () => {
    await expect(ack(eve, "presence:list", {})).resolves.toMatchObject({
      data: { peerIds: [BOB] },
    });
    await ack(eve, "presence:unsubscribe_all", {});
    await expect(ack(eve, "presence:list", {})).resolves.toMatchObject({
      data: { peerIds: [] },
    });
    // Re-arm for any later test / repeat runs.
    await ack(eve, "presence:subscribe", { peerIds: [BOB] });
  });
});
