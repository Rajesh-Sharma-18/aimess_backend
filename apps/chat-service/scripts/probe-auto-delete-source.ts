/**
 * Live probe (real Mongo, real Redis, the running chat-service — no mocks):
 * does a private chat's auto-delete timer belong to the CONVERSATION and reach
 * BOTH participants in real time?
 *
 * Creates throwaway rooms between synthetic users, drives the REAL REST
 * endpoints with minted access tokens, and listens on the `user:<id>` Redis
 * channels the socket gateway fans out from. Deletes everything it creates.
 *
 *   MONGO_DATABASE_URL=mongodb://localhost:27018/aimess_chat?directConnection=true \
 *   JWT_ACCESS_SECRET=<dev secret> REDIS_URL=redis://localhost:6379 \
 *   BASE=http://localhost:3004 \
 *   pnpm exec tsx scripts/probe-auto-delete-source.ts [existingRoomId]
 */
import { randomUUID } from "node:crypto";

import Redis from "ioredis";

import { signAccessToken } from "@aimess/auth-jwt";

import { PrismaClient } from "../src/generated/prisma/index.js";
import { buildParticipantsKey, generateRoomId } from "../src/lib/room-id.js";

const BASE = process.env.BASE ?? "http://localhost:3004";
const SECRET = process.env.JWT_ACCESS_SECRET ?? "";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const EXISTING_ROOM = process.argv[2] ?? "";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`
  );
}

const mint = (userId: string): string =>
  signAccessToken({
    userId,
    sessionId: randomUUID(),
    secret: SECRET,
    expiresInSeconds: 900,
  });

async function api(
  token: string,
  roomId: string,
  method: "GET" | "PUT",
  body?: unknown
): Promise<Record<string, unknown>> {
  const res = await fetch(
    `${BASE}/api/chat/private/rooms/${roomId}/auto-delete`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }
  );
  const json = (await res.json()) as { data: Record<string, unknown> };
  if (res.status !== 200)
    throw new Error(
      `${method} ${roomId} -> ${res.status} ${JSON.stringify(json)}`
    );
  return json.data;
}

/** Everything published to `user:<id>` while the probe runs, per user. */
type Inbox = Map<string, Record<string, unknown>[]>;

async function main(): Promise<void> {
  if (!SECRET) throw new Error("JWT_ACCESS_SECRET is required");
  const prisma = new PrismaClient();
  const sub = new Redis(REDIS_URL);

  const A = randomUUID();
  const B = randomUUID();
  const C = randomUUID();
  const [TA, TB] = [mint(A), mint(B)];
  const roomAB = generateRoomId("prv");
  const roomAC = generateRoomId("prv");

  const inbox: Inbox = new Map([
    [A, []],
    [B, []],
  ]);
  sub.on("message", (channel: string, raw: string) => {
    const userId = channel.slice("user:".length);
    const parsed = JSON.parse(raw) as { event: string; data: unknown };
    if (parsed.event !== "conv:auto_delete:updated") return;
    inbox.get(userId)?.push(parsed.data as Record<string, unknown>);
  });
  await sub.subscribe(`user:${A}`, `user:${B}`);

  /** Wait for the fan-out to land — it is published after the HTTP reply. */
  const settle = () => new Promise((r) => setTimeout(r, 400));
  const drain = () => {
    const snapshot = {
      A: [...(inbox.get(A) ?? [])],
      B: [...(inbox.get(B) ?? [])],
    };
    inbox.set(A, []);
    inbox.set(B, []);
    return snapshot;
  };

  try {
    for (const [roomId, peer] of [
      [roomAB, B],
      [roomAC, C],
    ] as const) {
      await prisma.privateRoom.create({
        data: {
          roomId,
          participants: [A, peer].sort(),
          participantsKey: buildParticipantsKey(A, peer),
        },
      });
    }

    // A brand-new conversation: Off for both, nothing inherited or initialized.
    check("new room: A = OFF", (await api(TA, roomAB, "GET")).mode === "OFF");
    check("new room: B = OFF", (await api(TB, roomAB, "GET")).mode === "OFF");
    drain();

    // Off -> 7 Days, set by A.
    await api(TA, roomAB, "PUT", { mode: "TIMER", ttlSeconds: 604800 });
    await settle();
    let events = drain();
    check(
      "A sets 7d: A notified",
      events.A.length === 1,
      JSON.stringify(events.A)
    );
    check(
      "A sets 7d: B notified",
      events.B.length === 1,
      JSON.stringify(events.B)
    );
    check(
      "A sets 7d: both got the same payload",
      JSON.stringify(events.A[0]) === JSON.stringify(events.B[0])
    );
    check("A sets 7d: event carries roomId", events.B[0]?.roomId === roomAB);
    check("A sets 7d: event carries ttl", events.B[0]?.ttlSeconds === 604800);
    check(
      "A sets 7d: B READS 7d",
      (await api(TB, roomAB, "GET")).ttlSeconds === 604800
    );

    // The other direction: B changes it, A must be told.
    await api(TB, roomAB, "PUT", { mode: "TIMER", ttlSeconds: 86400 });
    await settle();
    events = drain();
    check("B sets 24h: A notified", events.A[0]?.ttlSeconds === 86400);
    check("B sets 24h: setBy is B", events.A[0]?.setBy === B);
    check(
      "B sets 24h: A READS 24h",
      (await api(TA, roomAB, "GET")).ttlSeconds === 86400
    );

    // 7 Days -> Off.
    await api(TA, roomAB, "PUT", { mode: "OFF" });
    await settle();
    events = drain();
    check("A sets Off: B notified", events.B[0]?.mode === "OFF");
    check("A sets Off: isEnabled false", events.B[0]?.isEnabled === false);
    check(
      "A sets Off: B READS Off",
      (await api(TB, roomAB, "GET")).mode === "OFF"
    );

    // A repeat of the value in force must not wake either client.
    await api(TA, roomAB, "PUT", { mode: "OFF" });
    await settle();
    events = drain();
    check(
      "no-op change publishes nothing",
      events.A.length === 0 && events.B.length === 0
    );

    // Scoped: an unrelated conversation of the same user is untouched.
    await api(TA, roomAB, "PUT", { mode: "TIMER", ttlSeconds: 604800 });
    await settle();
    drain();
    check(
      "unrelated room A-C still OFF",
      (await api(mint(A), roomAC, "GET")).mode === "OFF"
    );

    const stored = await prisma.privateRoom.findUnique({
      where: { roomId: roomAB },
      select: { autoDelete: true, autoDeleteBy: true },
    });
    check(
      "stored as ONE conversation record",
      JSON.stringify(stored?.autoDeleteBy) === "{}",
      JSON.stringify(stored)
    );

    if (EXISTING_ROOM) {
      const room = await prisma.privateRoom.findUnique({
        where: { roomId: EXISTING_ROOM },
        select: { participants: true, autoDelete: true, autoDeleteBy: true },
      });
      const wires = await Promise.all(
        (room?.participants ?? []).map((id) =>
          api(mint(id), EXISTING_ROOM, "GET")
        )
      );
      check(
        `${EXISTING_ROOM}: both participants read the same timer`,
        wires.length === 2 && wires[0].mode === wires[1].mode,
        `stored=${JSON.stringify(room?.autoDelete)} wires=${JSON.stringify(wires)}`
      );
    }
  } finally {
    await sub.quit();
    for (const roomId of [roomAB, roomAC]) {
      await prisma.privateMessage.deleteMany({ where: { roomId } });
      await prisma.privateRoom.deleteMany({ where: { roomId } });
    }
    await prisma.$disconnect();
  }

  console.log(failed ? `\n${failed} FAILED` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}

void main();
