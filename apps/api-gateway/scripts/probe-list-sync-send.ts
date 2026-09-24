/**
 * Minimal sender for the "chat room works, sidebar has no row" reproduction.
 *
 * Sends N messages as USER_A into a community, a group or a private room, and
 * prints the `community:updated` / `conv:updated` frame a SECOND session of the
 * receiver sees for each one — the same bump the website's list handler gets.
 * The browser session under test is the real receiver; this only supplies the
 * traffic and an independent wire-level record of what was fanned out.
 *
 * Usage (from apps/api-gateway):
 *   JWT_ACCESS_SECRET=<dev secret> USER_A=<sender uuid> USER_B=<receiver uuid> \
 *   COMMUNITY=<id> [GROUP=grp_x] [ROOM=prv_x] [COUNT=1] [TEXT="hi"] \
 *   pnpm exec tsx scripts/probe-list-sync-send.ts
 */
import { randomUUID } from "node:crypto";

import { signAccessToken } from "@aimess/auth-jwt";
import { io, type Socket } from "socket.io-client";

const GW = process.env.GATEWAY_WS ?? "http://localhost:3000";
const SECRET = process.env.JWT_ACCESS_SECRET ?? "";
const A = process.env.USER_A ?? "";
const B = process.env.USER_B ?? "";
const COMMUNITY = process.env.COMMUNITY ?? "";
const GROUP = process.env.GROUP ?? "";
const ROOM = process.env.ROOM ?? "";
const COUNT = Number(process.env.COUNT ?? "1");
const TEXT = process.env.TEXT ?? "list-sync probe";

if (!SECRET || !A || !B || (!COMMUNITY && !GROUP && !ROOM)) {
  console.error(
    "JWT_ACCESS_SECRET, USER_A, USER_B and one of COMMUNITY/GROUP/ROOM are required."
  );
  process.exit(2);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const token = (userId: string): string =>
  signAccessToken({
    userId,
    sessionId: randomUUID(),
    secret: SECRET,
    expiresInSeconds: 3600,
  });

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

async function connect(
  label: string,
  userId: string,
  namespace: "chat" | "community"
): Promise<{ label: string; socket: Socket; frames: Frame[] }> {
  const frames: Frame[] = [];
  const socket: Socket = io(`${GW}/${namespace}`, {
    transports: ["websocket"],
    auth: { token: token(userId) },
    forceNew: true,
  });
  socket.onAny((event: string, data: unknown) => {
    frames.push({ event, data: (data ?? {}) as Record<string, unknown> });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", (e: Error) => reject(e));
    setTimeout(() => reject(new Error(`${label} connect timeout`)), 10_000);
  });
  return { label, socket, frames };
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
    setTimeout(() => resolve({ timeout: true }), 10_000);
  });
}

function report(frames: Frame[], event: string, since: number): void {
  const bumps = frames.slice(since).filter((f) => f.event === event);
  if (bumps.length === 0) {
    console.log(`   (no ${event} reached the mirror session)`);
    return;
  }
  for (const b of bumps) {
    const last = (b.data.lastMessage ?? {}) as Record<string, unknown>;
    console.log(
      `   ${event} id=${String(b.data.communityId ?? b.data.roomId)} at=${String(
        b.data.lastMessageAt
      )} preview=${JSON.stringify(last.text ?? "")} unread=${String(b.data.unread)}`
    );
  }
}

async function main(): Promise<void> {
  if (COMMUNITY) {
    const sender = await connect("A/community", A, "community");
    // A second receiver session, so the wire record does not depend on the
    // browser tab under test.
    const mirror = await connect("B/community", B, "community");
    await sleep(500);
    for (let i = 0; i < COUNT; i += 1) {
      const mark = mirror.frames.length;
      console.log(`\n[community ${COMMUNITY}] send #${i + 1}`);
      const ack = await emitAck(sender.socket, "community:message:send", {
        communityId: COMMUNITY,
        contentType: "TEXT",
        message: `${TEXT} #${i + 1} ${new Date().toISOString()}`,
        clientMessageId: `probe-list-${Date.now()}-${i}`,
      });
      console.log(`   ack=${JSON.stringify(ack).slice(0, 180)}`);
      await sleep(1200);
      report(mirror.frames, "community:updated", mark);
    }
    sender.socket.close();
    mirror.socket.close();
  }

  for (const [roomId, kind] of [
    [GROUP, "group"],
    [ROOM, "private"],
  ] as const) {
    if (!roomId) continue;
    const sender = await connect(`A/chat:${kind}`, A, "chat");
    const mirror = await connect(`B/chat:${kind}`, B, "chat");
    await sleep(500);
    for (let i = 0; i < COUNT; i += 1) {
      const mark = mirror.frames.length;
      console.log(`\n[${kind} ${roomId}] send #${i + 1}`);
      const ack = await emitAck(sender.socket, "message:send", {
        roomId,
        contentType: "TEXT",
        message: `${TEXT} #${i + 1} ${new Date().toISOString()}`,
        clientMessageId: `probe-list-${Date.now()}-${i}`,
      });
      console.log(`   ack=${JSON.stringify(ack).slice(0, 180)}`);
      await sleep(1200);
      report(mirror.frames, "conv:updated", mark);
    }
    sender.socket.close();
    mirror.socket.close();
  }

  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
