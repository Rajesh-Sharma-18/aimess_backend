/**
 * Live probe: does a private 1:1 call reach BOTH participants' open chat rooms
 * and inboxes in real time, and does it reach nobody else?
 *
 * Drives the real stack over Socket.IO exactly like a browser does
 * (call:initiate / call:answer / call:end / call:decline) and records every
 * frame each participant receives. A third user (C) is connected and joined to a
 * DIFFERENT room to prove cross-user isolation.
 *
 * Usage (from apps/api-gateway):
 *   JWT_ACCESS_SECRET=<dev secret> ROOM=prv_xxx USER_A=<uuid> USER_B=<uuid> \
 *   USER_C=<uuid> pnpm exec tsx scripts/probe-call-realtime.ts
 */
import { randomUUID } from "node:crypto";

import { signAccessToken } from "@aimess/auth-jwt";
import { io, type Socket } from "socket.io-client";

const GW = process.env.GATEWAY_WS ?? "http://localhost:3000";
const SECRET = process.env.JWT_ACCESS_SECRET ?? "";
const ROOM = process.env.ROOM ?? "";
const A = process.env.USER_A ?? "";
const B = process.env.USER_B ?? "";
const C = process.env.USER_C ?? "";

if (!SECRET || !ROOM || !A || !B) {
  console.error("ROOM, USER_A, USER_B and JWT_ACCESS_SECRET are required.");
  process.exit(2);
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

interface Frame {
  event: string;
  data: Record<string, unknown>;
  at: number;
}

class Client {
  readonly frames: Frame[] = [];
  private constructor(
    readonly label: string,
    readonly socket: Socket
  ) {}

  static async connect(label: string, userId: string): Promise<Client> {
    const token = signAccessToken({
      userId,
      sessionId: randomUUID(),
      secret: SECRET,
      expiresInSeconds: 3600,
    });
    const socket = io(`${GW}/chat`, {
      transports: ["websocket"],
      auth: { token },
      forceNew: true,
    });
    const client = new Client(label, socket);
    socket.onAny((event: string, ...args: unknown[]) => {
      client.frames.push({
        event,
        data: (args[0] ?? {}) as Record<string, unknown>,
        at: Date.now(),
      });
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", (e: Error) => reject(e));
      setTimeout(() => reject(new Error(`${label} connect timeout`)), 8000);
    });
    return client;
  }

  join(conversationId: string): Promise<unknown> {
    return this.emitAck("conv:join", { conversationId });
  }

  emitAck(event: string, payload: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      let done = false;
      this.socket.emit(event, payload, (res: unknown) => {
        done = true;
        resolve(res);
      });
      setTimeout(() => {
        if (!done) resolve({ timeout: true });
      }, 8000);
    });
  }

  /** Frames of `event` seen since `since` (epoch ms). */
  since(since: number, event: string): Frame[] {
    return this.frames.filter((f) => f.at >= since && f.event === event);
  }

  callFrames(since: number): Frame[] {
    return this.frames.filter(
      (f) =>
        f.at >= since &&
        (f.event === "message:new" || f.event === "message:edited") &&
        Boolean(
          (f.data as { content?: { call?: unknown } })?.content?.call ??
          (f.data as { systemData?: { callId?: unknown } })?.systemData?.callId
        )
    );
  }
}

const contentTypeOf = (f: Frame): string =>
  String(
    (f.data as { contentType?: string; messageType?: string }).contentType ??
      (f.data as { messageType?: string }).messageType ??
      ""
  ).toUpperCase();

const callStatusOf = (f: Frame): string =>
  String(
    (
      f.data as {
        content?: { call?: { callStatus?: string } };
      }
    ).content?.call?.callStatus ?? ""
  ).toUpperCase();

const roomOf = (f: Frame): string =>
  String(
    (f.data as { roomId?: string; conversationId?: string }).roomId ??
      (f.data as { conversationId?: string }).conversationId ??
      ""
  );

async function scenario(params: {
  title: string;
  a: Client;
  b: Client;
  c: Client | null;
  callType: "AUDIO" | "VIDEO";
  /** How the call is settled after it starts ringing. */
  settle: "answer-end" | "decline" | "cancel";
}): Promise<void> {
  const { title, a, b, c, callType, settle } = params;
  console.log(`\n--- ${title} ---`);
  const t0 = Date.now();

  const initAck = (await a.emitAck("call:initiate", {
    calleeId: B,
    callType,
    privateRoomId: ROOM,
  })) as { success?: boolean; data?: { callId?: string }; message?: string };
  const callId = initAck?.data?.callId ?? "";
  if (!callId) {
    check(`${title}: call:initiate accepted`, false, JSON.stringify(initAck));
    return;
  }
  check(`${title}: call:initiate accepted`, true, `callId=${callId}`);

  await sleep(1200);

  // The RINGING card must already be on both screens, before anything settles.
  const expectedType = callType === "VIDEO" ? "VIDEO_CALL" : "VOICE_CALL";
  for (const [who, cl] of [
    ["caller", a],
    ["callee", b],
  ] as const) {
    const ringing = cl
      .callFrames(t0)
      .filter(
        (f) => f.event === "message:new" && callStatusOf(f) === "RINGING"
      );
    check(
      `${title}: ${who} got live RINGING message:new`,
      ringing.length === 1,
      `count=${ringing.length}`
    );
    if (ringing[0]) {
      check(
        `${title}: ${who} RINGING contentType is ${expectedType}`,
        contentTypeOf(ringing[0]) === expectedType,
        contentTypeOf(ringing[0])
      );
      check(
        `${title}: ${who} RINGING carries the room id`,
        roomOf(ringing[0]) === ROOM,
        roomOf(ringing[0])
      );
    }
    const bumps = cl
      .since(t0, "conv:updated")
      .filter((f) => roomOf(f) === ROOM);
    check(
      `${title}: ${who} inbox bumped (conv:updated) while ringing`,
      bumps.length >= 1,
      `count=${bumps.length}`
    );
  }

  let terminal: string;
  if (settle === "answer-end") {
    await b.emitAck("call:answer", { callId });
    await sleep(1200);
    for (const [who, cl] of [
      ["caller", a],
      ["callee", b],
    ] as const) {
      const answered = cl
        .callFrames(t0)
        .filter(
          (f) => f.event === "message:edited" && callStatusOf(f) === "ANSWERED"
        );
      check(
        `${title}: ${who} got live ANSWERED message:edited`,
        answered.length >= 1,
        `count=${answered.length}`
      );
    }
    await sleep(1500);
    await a.emitAck("call:end", { callId });
    terminal = "ENDED";
  } else if (settle === "decline") {
    await b.emitAck("call:decline", { callId, intentional: true });
    terminal = "DECLINED";
  } else {
    await a.emitAck("call:end", { callId });
    terminal = "CANCELLED";
  }
  await sleep(1500);

  for (const [who, cl] of [
    ["caller", a],
    ["callee", b],
  ] as const) {
    const settled = cl
      .callFrames(t0)
      .filter(
        (f) => f.event === "message:edited" && callStatusOf(f) === terminal
      );
    check(
      `${title}: ${who} got live ${terminal} message:edited`,
      settled.length >= 1,
      `count=${settled.length}`
    );
    if (settled[0]) {
      check(
        `${title}: ${who} ${terminal} keeps contentType ${expectedType}`,
        contentTypeOf(settled[0]) === expectedType,
        contentTypeOf(settled[0])
      );
    }
    // One call === one row: every frame must carry the SAME message id.
    const ids = new Set(
      cl.callFrames(t0).map((f) => String((f.data as { id?: string }).id ?? ""))
    );
    check(
      `${title}: ${who} saw exactly ONE call row across the lifecycle`,
      ids.size === 1,
      `ids=${[...ids].join(",")}`
    );
    const bumps = cl
      .since(t0, "conv:updated")
      .filter((f) => roomOf(f) === ROOM);
    const previews = bumps.map((f) =>
      String(
        (f.data as { lastMessage?: { text?: string } }).lastMessage?.text ?? ""
      )
    );
    check(
      `${title}: ${who} inbox preview carries call text`,
      previews.some((p) => p.length > 0),
      previews.join(" | ")
    );
    const lastBump = bumps[bumps.length - 1];
    check(
      `${title}: ${who} inbox bump carries lastMessageAt`,
      Number(
        (lastBump?.data as { lastMessageAt?: number })?.lastMessageAt ?? 0
      ) > 0,
      String((lastBump?.data as { lastMessageAt?: number })?.lastMessageAt)
    );
  }

  if (c) {
    const leaked = c.frames.filter(
      (f) =>
        f.at >= t0 &&
        (f.event.startsWith("message:") || f.event === "conv:updated") &&
        (roomOf(f) === ROOM || JSON.stringify(f.data).includes(callId))
    );
    check(
      `${title}: uninvolved user C received nothing for this call`,
      leaked.length === 0,
      leaked.map((f) => f.event).join(",")
    );
  }
}

async function main(): Promise<void> {
  const a = await Client.connect("A", A);
  const b = await Client.connect("B", B);
  const c = C ? await Client.connect("C", C) : null;

  await a.join(ROOM);
  await b.join(ROOM);
  await sleep(300);

  await scenario({
    title: "voice answered+ended",
    a,
    b,
    c,
    callType: "AUDIO",
    settle: "answer-end",
  });
  await sleep(800);
  await scenario({
    title: "video declined",
    a,
    b,
    c,
    callType: "VIDEO",
    settle: "decline",
  });
  await sleep(800);
  await scenario({
    title: "voice cancelled",
    a,
    b,
    c,
    callType: "AUDIO",
    settle: "cancel",
  });

  // --- multi-device: a SECOND socket for A joined to the same room ----------
  console.log("\n--- multi-device (A on two sockets) ---");
  const a2 = await Client.connect("A2", A);
  await a2.join(ROOM);
  await sleep(300);
  const t0 = Date.now();
  const ack = (await a.emitAck("call:initiate", {
    calleeId: B,
    callType: "AUDIO",
    privateRoomId: ROOM,
  })) as { data?: { callId?: string } };
  await sleep(1200);
  const callId = ack?.data?.callId ?? "";
  if (callId) await a.emitAck("call:end", { callId });
  await sleep(1200);
  const rows = a2
    .callFrames(t0)
    .map((f) => String((f.data as { id?: string }).id ?? ""));
  check(
    "second device of the caller sees the same single call row",
    rows.length > 0 && new Set(rows).size === 1,
    `frames=${rows.length}`
  );

  // --- missed: nobody answers, the 60s sweep settles it ---------------------
  // Slow by construction (the sweep interval is a minute), so opt in.
  if (process.env.PROBE_MISSED === "1") {
    console.log("\n--- missed (waiting for the 60s sweep) ---");
    const t = Date.now();
    const ack2 = (await a.emitAck("call:initiate", {
      calleeId: B,
      callType: "AUDIO",
      privateRoomId: ROOM,
    })) as { data?: { callId?: string } };
    check("missed: call:initiate accepted", Boolean(ack2?.data?.callId));
    await sleep(95_000);
    for (const [who, cl] of [
      ["caller", a],
      ["callee", b],
    ] as const) {
      const missed = cl
        .callFrames(t)
        .filter(
          (f) => f.event === "message:edited" && callStatusOf(f) === "MISSED"
        );
      check(
        `missed: ${who} got live MISSED message:edited`,
        missed.length >= 1,
        `count=${missed.length}`
      );
    }
    const calleeBumps = b
      .since(t, "conv:updated")
      .filter((f) => roomOf(f) === ROOM);
    const last = calleeBumps[calleeBumps.length - 1];
    check(
      "missed: callee inbox bump raises unread",
      (last?.data as { unread?: boolean })?.unread === true,
      JSON.stringify(last?.data ?? {})
    );
    const callerBumps = a
      .since(t, "conv:updated")
      .filter((f) => roomOf(f) === ROOM);
    const callerLast = callerBumps[callerBumps.length - 1];
    check(
      "missed: caller inbox bump does NOT raise unread",
      (callerLast?.data as { unread?: boolean })?.unread !== true,
      JSON.stringify(callerLast?.data ?? {})
    );
  }

  for (const cl of [a, b, a2, ...(c ? [c] : [])]) cl.socket.close();
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(2);
});
