/**
 * Reply-quote sender identity: what does the wire actually carry?
 *
 * Builds the reported chain in private, group and community:
 *   A: M1        B: M2 (reply to M1)        A: M3 (reply to M2)
 * and prints the `quoteData` every participant receives (live socket frame AND
 * REST history), so the reply preview's sender can be judged from the wire
 * instead of from a client's rendering.
 *
 * Usage (from apps/api-gateway):
 *   JWT_ACCESS_SECRET=<dev secret> USER_A=<uuid> USER_B=<uuid> \
 *   ROOM=prv_x GROUP=grp_x COMMUNITY=<id> \
 *   pnpm exec tsx scripts/probe-reply-quote-identity.ts
 */
import { randomUUID } from "node:crypto";

import { signAccessToken } from "@aimess/auth-jwt";
import { io, type Socket } from "socket.io-client";

const GW = process.env.GATEWAY_WS ?? "http://localhost:3000";
const SECRET = process.env.JWT_ACCESS_SECRET ?? "";
const A = process.env.USER_A ?? "";
const B = process.env.USER_B ?? "";
/** Optional third participant, for the group/community "C replies to B" case. */
const C = process.env.USER_C ?? "";
const ROOM = process.env.ROOM ?? "";
const GROUP = process.env.GROUP ?? "";
const COMMUNITY = process.env.COMMUNITY ?? "";

if (!SECRET || !A || !B) {
  console.error("JWT_ACCESS_SECRET, USER_A and USER_B are required.");
  process.exit(2);
}

const token = (userId: string): string =>
  signAccessToken({
    userId,
    sessionId: randomUUID(),
    secret: SECRET,
    expiresInSeconds: 3600,
  });

const TOK: Record<string, string> = {
  A: token(A),
  B: token(B),
  ...(C ? { C: token(C) } : {}),
};

/** Everyone whose view of the room this run reads back. */
const VIEWERS = (C ? ["A", "B", "C"] : ["A", "B"]) as Array<"A" | "B" | "C">;

interface Frame {
  event: string;
  payload: Record<string, unknown>;
}

async function connect(who: "A" | "B" | "C", ns: "chat" | "community") {
  const socket: Socket = io(`${GW}/${ns}`, {
    transports: ["websocket"],
    auth: { token: TOK[who] },
    forceNew: true,
  });
  const frames: Frame[] = [];
  socket.onAny((event: string, payload: unknown) => {
    frames.push({ event, payload: (payload ?? {}) as Record<string, unknown> });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", (e: Error) => reject(e));
    setTimeout(() => reject(new Error(`${who}/${ns} connect timeout`)), 10_000);
  });
  await new Promise((r) => setTimeout(r, 800));
  return { socket, frames };
}

function emitAck(socket: Socket, event: string, payload: unknown) {
  return new Promise<Record<string, unknown>>((resolve) => {
    socket.emit(event, payload, (ack: unknown) =>
      resolve((ack ?? {}) as Record<string, unknown>)
    );
    setTimeout(() => resolve({ timeout: true }), 15_000);
  });
}

const messageIdOf = (ack: Record<string, unknown>): string => {
  const d = ack.data as { messageId?: string; id?: string } | undefined;
  return String(d?.messageId ?? d?.id ?? "");
};

const textOf = (m: Record<string, unknown>): string => {
  const c = m.content as { text?: string } | undefined;
  return String(c?.text ?? m.message ?? "");
};

const quoteOf = (m: Record<string, unknown>): string => {
  const q = m.quoteData as Record<string, unknown> | null | undefined;
  if (!q) return "quoteData=null";
  const preview = q.preview ?? q.message ?? q.text ?? "";
  return [
    "quoteData{",
    `senderId=${String(q.senderId ?? "")}`,
    `senderName=${JSON.stringify(q.senderName ?? "")}`,
    `messageId=${String(q.messageId ?? "")}`,
    `preview=${JSON.stringify(preview)}`,
    "}",
  ].join(" ");
};

async function rest(
  who: "A" | "B" | "C",
  path: string
): Promise<Record<string, unknown>[]> {
  const res = await fetch(`http://localhost:3000/api/v1${path}`, {
    headers: { Authorization: `Bearer ${TOK[who]}` },
  });
  const json = (await res.json()) as Record<string, unknown>;
  const data = json.data as Record<string, unknown> | undefined;
  const inner = (data?.data ?? data?.items ?? data) as unknown;
  if (!Array.isArray(inner)) {
    console.log(`  (${who}) unexpected shape: ${JSON.stringify(json).slice(0, 200)}`);
    return [];
  }
  return inner as Record<string, unknown>[];
}

function reportFrames(
  label: string,
  sets: ReadonlyArray<readonly [string, Frame[]]>,
  stamp: number
): void {
  console.log(`\n-- live ${label} frames --`);
  for (const [who, frames] of sets) {
    for (const f of frames) {
      if (!f.event.includes("message:new")) continue;
      const m = (f.payload.data ?? f.payload) as Record<string, unknown>;
      const text = textOf(m);
      if (!text.includes(String(stamp))) continue;
      console.log(
        `${who} <- id=${String(m.id ?? m.messageId ?? "")} sender=${String(
          m.senderId ?? m.sentBy ?? ""
        )} senderName=${JSON.stringify(m.senderName ?? "")} text=${JSON.stringify(
          text.slice(0, 44)
        )} ${quoteOf(m)}`
      );
    }
  }
}

async function reportRest(path: string, stamp: number): Promise<void> {
  console.log("\n-- REST history --");
  for (const who of VIEWERS) {
    const rows = await rest(who, path);
    for (const m of rows) {
      const text = textOf(m);
      if (!text.includes(String(stamp))) continue;
      console.log(
        `${who} GET id=${String(m.id ?? "")} sender=${String(
          m.senderId ?? m.sentBy ?? ""
        )} senderName=${JSON.stringify(m.senderName ?? "")} text=${JSON.stringify(
          text.slice(0, 44)
        )} ${quoteOf(m)}`
      );
    }
  }
}

async function runChat(kind: "private" | "group", roomId: string) {
  console.log(`\n================ ${kind.toUpperCase()} (${roomId}) ================`);
  const a = await connect("A", "chat");
  const b = await connect("B", "chat");
  const stamp = Date.now();

  const send = (
    who: { socket: Socket },
    message: string,
    parentMessageId?: string
  ) =>
    emitAck(who.socket, "message:send", {
      roomId,
      contentType: "TEXT",
      message,
      clientMessageId: `probe-reply-${stamp}-${Math.random().toString(36).slice(2, 8)}`,
      ...(parentMessageId ? { parentMessageId } : {}),
    });

  const ack1 = await send(a, `M1 from A ${stamp}`);
  const m1 = messageIdOf(ack1);
  console.log(`M1 (A) = ${m1 || JSON.stringify(ack1).slice(0, 200)}`);
  await new Promise((r) => setTimeout(r, 700));

  const ack2 = await send(b, `M2 from B reply to M1 ${stamp}`, m1);
  const m2 = messageIdOf(ack2);
  console.log(`M2 (B, replies M1) = ${m2 || JSON.stringify(ack2).slice(0, 200)}`);
  await new Promise((r) => setTimeout(r, 700));

  const ack3 = await send(a, `M3 from A reply to M2 ${stamp}`, m2);
  const m3 = messageIdOf(ack3);
  console.log(`M3 (A, replies M2) = ${m3 || JSON.stringify(ack3).slice(0, 200)}`);
  await new Promise((r) => setTimeout(r, 700));

  // Third party: C references B's M2, so C must see B's name — never A's,
  // whose M1 is what M2 itself quotes.
  const c = kind === "group" && C ? await connect("C", "chat") : null;
  if (c) {
    const ack4 = await send(c, `M4 from C reply to M2 ${stamp}`, m2);
    console.log(
      `M4 (C, replies M2) = ${messageIdOf(ack4) || JSON.stringify(ack4).slice(0, 200)}`
    );
  }
  await new Promise((r) => setTimeout(r, 2000));

  console.log("\n-- ACK payloads (the sender's own echo) --");
  console.log(`M2 ack (B): ${quoteOf((ack2.data ?? {}) as Record<string, unknown>)}`);
  console.log(`M3 ack (A): ${quoteOf((ack3.data ?? {}) as Record<string, unknown>)}`);

  reportFrames(
    "message:new",
    [
      ["A", a.frames],
      ["B", b.frames],
      ...(c ? ([["C", c.frames]] as const) : []),
    ],
    stamp
  );

  await reportRest(
    kind === "private"
      ? `/chat/private/rooms/${roomId}/messages?limit=10`
      : `/chat/groups/rooms/${roomId}/messages?limit=10`,
    stamp
  );

  a.socket.close();
  b.socket.close();
  c?.socket.close();
}

async function runCommunity(communityId: string) {
  console.log(`\n================ COMMUNITY (${communityId}) ================`);
  const a = await connect("A", "community");
  const b = await connect("B", "community");
  const stamp = Date.now();

  const send = (
    who: { socket: Socket },
    message: string,
    parentMessageId?: string
  ) =>
    emitAck(who.socket, "community:message:send", {
      communityId,
      contentType: "TEXT",
      message,
      clientMessageId: `probe-reply-${stamp}-${Math.random().toString(36).slice(2, 8)}`,
      ...(parentMessageId ? { parentMessageId } : {}),
    });

  const ack1 = await send(a, `M1 from A ${stamp}`);
  const m1 = messageIdOf(ack1);
  console.log(`M1 (A) = ${m1 || JSON.stringify(ack1).slice(0, 200)}`);
  await new Promise((r) => setTimeout(r, 700));

  const ack2 = await send(b, `M2 from B reply to M1 ${stamp}`, m1);
  const m2 = messageIdOf(ack2);
  console.log(`M2 (B, replies M1) = ${m2 || JSON.stringify(ack2).slice(0, 200)}`);
  await new Promise((r) => setTimeout(r, 700));

  const ack3 = await send(a, `M3 from A reply to M2 ${stamp}`, m2);
  console.log(
    `M3 (A, replies M2) = ${messageIdOf(ack3) || JSON.stringify(ack3).slice(0, 200)}`
  );
  await new Promise((r) => setTimeout(r, 700));

  const c = C ? await connect("C", "community") : null;
  if (c) {
    const ack4 = await send(c, `M4 from C reply to M2 ${stamp}`, m2);
    console.log(
      `M4 (C, replies M2) = ${messageIdOf(ack4) || JSON.stringify(ack4).slice(0, 200)}`
    );
  }
  await new Promise((r) => setTimeout(r, 2000));

  console.log("\n-- ACK payloads (the sender's own echo) --");
  console.log(`M2 ack (B): ${quoteOf((ack2.data ?? {}) as Record<string, unknown>)}`);
  console.log(`M3 ack (A): ${quoteOf((ack3.data ?? {}) as Record<string, unknown>)}`);

  reportFrames(
    "community message:new",
    [
      ["A", a.frames],
      ["B", b.frames],
      ...(c ? ([["C", c.frames]] as const) : []),
    ],
    stamp
  );

  await reportRest(`/chat/community/rooms/${communityId}/messages?limit=10`, stamp);

  a.socket.close();
  b.socket.close();
  c?.socket.close();
}

async function main(): Promise<void> {
  if (ROOM) await runChat("private", ROOM);
  if (GROUP) await runChat("group", GROUP);
  if (COMMUNITY) await runCommunity(COMMUNITY);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
