/**
 * REAL Socket.IO (no mocks, in-memory adapter) coverage for
 * `dropDuplicateNamespaceConnect`.
 *
 * The bug: socket.io-client sends a second CONNECT for a namespace when
 * `socket.connect()` is called while the transport is open but the first
 * CONNECT is still in (slow) auth middleware. The server turned each CONNECT
 * into its own socket; all of them joined `user:<id>` and wrote into the SAME
 * connection, so one browser tab received every room broadcast N times.
 */
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as SocketIOServer, type Namespace } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

import { dropDuplicateNamespaceConnect } from "../../src/sockets/duplicate-connect-guard.js";

const USER = "user-dup-1";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Harness {
  http: HttpServer;
  io: SocketIOServer;
  ns: Namespace;
  url: string;
  connections: number;
}

async function startServer(guarded: boolean): Promise<Harness> {
  const http = createServer();
  const io = new SocketIOServer(http);
  const ns = io.of("/chat");
  const h = { http, io, ns, url: "", connections: 0 };
  if (guarded) ns.use(dropDuplicateNamespaceConnect);
  // Stands in for the session-check auth middleware: slow enough that a
  // second connect() lands while the first CONNECT is still pending.
  ns.use((_socket, next) => {
    setTimeout(() => next(), 150);
  });
  ns.on("connection", (socket) => {
    h.connections += 1;
    void socket.join(`user:${USER}`);
    socket.on("ping:me", (ack: (v: string) => void) => ack(socket.id!));
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  h.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return h;
}

function framesOf(client: ClientSocket): string[] {
  const got: string[] = [];
  client.on("typing:start", (p: { n: string }) => got.push(p.n));
  return got;
}

/** Exactly what the web client did: connect(), then connect() again from another hook while the first CONNECT is pending. */
async function connectTwiceWhilePending(url: string): Promise<ClientSocket> {
  const client = ioClient(`${url}/chat`, {
    transports: ["websocket"],
    autoConnect: false,
    forceNew: true,
  });
  await new Promise<void>((resolve) => {
    client.io.once("open", () => {
      // Transport open, CONNECT in middleware, not yet `connected`.
      expect(client.connected).toBe(false);
      client.connect();
      client.connect();
      resolve();
    });
    client.connect();
  });
  await new Promise<void>((r) => (client.connected ? r() : client.once("connect", () => r())));
  await wait(400); // let every pending CONNECT finish on the server
  return client;
}

describe("dropDuplicateNamespaceConnect (real Socket.IO)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });
  const track = (h: Harness, ...clients: ClientSocket[]) =>
    cleanups.push(() => {
      clients.forEach((c) => c.disconnect());
      void h.io.close();
    });

  it("REPRO without the guard: repeated connect() leaves extra sockets and duplicate frames", async () => {
    const h = await startServer(false);
    const client = await connectTwiceWhilePending(h.url);
    track(h, client);
    const got = framesOf(client);

    h.ns.to(`user:${USER}`).emit("typing:start", { n: "one" });
    await wait(150);

    expect(h.connections).toBe(3);
    expect(got).toEqual(["one", "one", "one"]);
  });

  it("one server socket and one frame per broadcast when connect() repeats mid-handshake", async () => {
    const h = await startServer(true);
    const client = await connectTwiceWhilePending(h.url);
    track(h, client);
    const got = framesOf(client);

    h.ns.to(`user:${USER}`).emit("typing:start", { n: "one" });
    await wait(150);

    expect(h.connections).toBe(1);
    expect(h.ns.sockets.size).toBe(1);
    expect(got).toEqual(["one"]);
    // The kept socket is the one the client believes it has, and it still answers.
    const serverId = await client.timeout(2000).emitWithAck("ping:me");
    expect(serverId).toBe(client.id);
  });

  it("does not affect a second tab/device: separate connections both connect and both receive", async () => {
    const h = await startServer(true);
    const a = ioClient(`${h.url}/chat`, { transports: ["websocket"], forceNew: true });
    const b = ioClient(`${h.url}/chat`, { transports: ["websocket"], forceNew: true });
    track(h, a, b);
    await Promise.all(
      [a, b].map((c) => new Promise<void>((r) => c.once("connect", () => r())))
    );
    const gotA = framesOf(a);
    const gotB = framesOf(b);

    h.ns.to(`user:${USER}`).emit("typing:start", { n: "both" });
    await wait(150);

    expect(h.connections).toBe(2);
    expect(gotA).toEqual(["both"]);
    expect(gotB).toEqual(["both"]);
  });

  it("a reconnect after a real disconnect still connects (not mistaken for a duplicate)", async () => {
    const h = await startServer(true);
    const client = ioClient(`${h.url}/chat`, { transports: ["websocket"], forceNew: true });
    track(h, client);
    await new Promise<void>((r) => client.once("connect", () => r()));
    client.disconnect();
    await wait(100);
    client.connect();
    await new Promise<void>((r) => client.once("connect", () => r()));

    expect(h.connections).toBe(2);
    expect(h.ns.sockets.size).toBe(1);
  });
});
