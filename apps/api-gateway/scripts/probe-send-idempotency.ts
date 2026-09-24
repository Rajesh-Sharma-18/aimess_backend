/**
 * A lost ack must not cost a duplicate.
 *
 * The website's outbox is strict FIFO per conversation and never fails a send it
 * cannot prove was rejected: on a missing ack it re-emits the SAME
 * `clientMessageId`. That is only safe if the server treats the replay as the
 * message it already stored — which is what this checks, by emitting one
 * clientMessageId twice and counting what the room actually holds.
 *
 * Usage (from apps/api-gateway):
 *   JWT_ACCESS_SECRET=<dev secret> USER_A=<sender uuid> \
 *   COMMUNITY=<id> [GROUP=grp_x] [ROOM=prv_x] \
 *   pnpm exec tsx scripts/probe-send-idempotency.ts
 */
import { randomUUID } from "node:crypto";

import { signAccessToken } from "@aimess/auth-jwt";
import { io, type Socket } from "socket.io-client";

const GW = process.env.GATEWAY_WS ?? "http://localhost:3000";
const SECRET = process.env.JWT_ACCESS_SECRET ?? "";
const A = process.env.USER_A ?? "";
const COMMUNITY = process.env.COMMUNITY ?? "";
const GROUP = process.env.GROUP ?? "";
const ROOM = process.env.ROOM ?? "";

if (!SECRET || !A || (!COMMUNITY && !GROUP && !ROOM)) {
  console.error(
    "JWT_ACCESS_SECRET, USER_A and one of COMMUNITY/GROUP/ROOM are required."
  );
  process.exit(2);
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const tok = signAccessToken({
  userId: A,
  sessionId: randomUUID(),
  secret: SECRET,
  expiresInSeconds: 3600,
});

async function connect(ns: "chat" | "community"): Promise<Socket> {
  const socket: Socket = io(`${GW}/${ns}`, {
    transports: ["websocket"],
    auth: { token: tok },
    forceNew: true,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", (e: Error) => reject(e));
    setTimeout(() => reject(new Error(`${ns} connect timeout`)), 10_000);
  });
  // The gateway joins the socket to its rooms after the handshake; sending into
  // that window comes back SERVICE_ERROR.
  await new Promise((r) => setTimeout(r, 600));
  return socket;
}

function emitAck(
  socket: Socket,
  event: string,
  payload: unknown
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (ack: unknown) =>
      resolve((ack ?? {}) as Record<string, unknown>)
    );
    setTimeout(() => resolve({ timeout: true }), 15_000);
  });
}

const messageIdOf = (ack: Record<string, unknown>): string =>
  String((ack.data as { messageId?: string } | undefined)?.messageId ?? "");

async function replay(
  label: string,
  socket: Socket,
  event: string,
  payload: Record<string, unknown>
): Promise<void> {
  const clientMessageId = `probe-idem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const body = { ...payload, clientMessageId };

  const first = await emitAck(socket, event, body);
  // Exactly what the outbox does when an ack never arrives: the same key, again.
  const second = await emitAck(socket, event, body);

  const a = messageIdOf(first);
  const b = messageIdOf(second);
  check(`${label}: first send stored a message`, !!a, a || JSON.stringify(first).slice(0, 160));
  check(
    `${label}: the replay resolves to the SAME message, not a second one`,
    !!b && a === b,
    `first=${a} replay=${b}`
  );
}

async function main(): Promise<void> {
  if (COMMUNITY) {
    const socket = await connect("community");
    await replay("community", socket, "community:message:send", {
      communityId: COMMUNITY,
      contentType: "TEXT",
      message: `idempotency probe ${new Date().toISOString()}`,
    });
    socket.close();
  }

  for (const [roomId, label] of [
    [GROUP, "group"],
    [ROOM, "private"],
  ] as const) {
    if (!roomId) continue;
    const socket = await connect("chat");
    await replay(label, socket, "message:send", {
      roomId,
      contentType: "TEXT",
      message: `idempotency probe ${new Date().toISOString()}`,
    });
    socket.close();
  }

  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
