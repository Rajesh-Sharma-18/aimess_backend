/**
 * Live probe (real Mongo + the running chat-service, no mocks): is the private
 * auto-delete setting really per (conversation, user)?
 *
 * Creates a throwaway private room between two synthetic users, drives the REAL
 * REST endpoints with minted access tokens, and asserts that neither user's
 * timer ever moves because of the other's. Also re-reads a real room to prove an
 * unconfigured chat reports OFF regardless of anyone's account-wide setting.
 * Deletes everything it created.
 *
 *   MONGO_DATABASE_URL=mongodb://localhost:27018/aimess_chat?directConnection=true \
 *   JWT_ACCESS_SECRET=<dev secret> BASE=http://localhost:3004 \
 *   pnpm exec tsx scripts/probe-auto-delete-source.ts [existingRoomId]
 */
import { randomUUID } from "node:crypto";

import { signAccessToken } from "@aimess/auth-jwt";

import { PrismaClient } from "../src/generated/prisma/index.js";
import { buildParticipantsKey, generateRoomId } from "../src/lib/room-id.js";

const BASE = process.env.BASE ?? "http://localhost:3004";
const SECRET = process.env.JWT_ACCESS_SECRET ?? "";
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

async function main(): Promise<void> {
  if (!SECRET) throw new Error("JWT_ACCESS_SECRET is required");
  const prisma = new PrismaClient();
  const A = randomUUID();
  const B = randomUUID();
  const roomId = generateRoomId("prv");
  const [TA, TB] = [mint(A), mint(B)];

  try {
    await prisma.privateRoom.create({
      data: {
        roomId,
        participants: [A, B].sort(),
        participantsKey: buildParticipantsKey(A, B),
      },
    });

    // A brand-new conversation: Off on both sides, nothing inherited.
    check("new room: A = OFF", (await api(TA, roomId, "GET")).mode === "OFF");
    check("new room: B = OFF", (await api(TB, roomId, "GET")).mode === "OFF");

    // A turns it on. B must not move.
    await api(TA, roomId, "PUT", { mode: "TIMER", ttlSeconds: 604800 });
    const a1 = await api(TA, roomId, "GET");
    const b1 = await api(TB, roomId, "GET");
    check("A set 7d: A = 604800", a1.ttlSeconds === 604800, JSON.stringify(a1));
    check("A set 7d: B still OFF", b1.mode === "OFF", JSON.stringify(b1));
    check("payload carries no peer block", b1.peer === undefined);

    // B picks its own, different timer. A must not move.
    await api(TB, roomId, "PUT", { mode: "TIMER", ttlSeconds: 86400 });
    const a2 = await api(TA, roomId, "GET");
    const b2 = await api(TB, roomId, "GET");
    check("B set 24h: A still 604800", a2.ttlSeconds === 604800);
    check("B set 24h: B = 86400", b2.ttlSeconds === 86400);

    // A body-supplied userId must never write the other participant's entry.
    await api(TA, roomId, "PUT", {
      mode: "TIMER",
      ttlSeconds: 3600,
      userId: B,
    });
    const a3 = await api(TA, roomId, "GET");
    const b3 = await api(TB, roomId, "GET");
    check("spoofed userId: A changed to 3600", a3.ttlSeconds === 3600);
    check("spoofed userId: B untouched at 86400", b3.ttlSeconds === 86400);

    // A turns it back off; B keeps its own timer.
    await api(TA, roomId, "PUT", { mode: "OFF" });
    check("A off: A = OFF", (await api(TA, roomId, "GET")).mode === "OFF");
    check(
      "A off: B still 86400",
      (await api(TB, roomId, "GET")).ttlSeconds === 86400
    );

    const stored = await prisma.privateRoom.findUnique({
      where: { roomId },
      select: { autoDeleteBy: true },
    });
    console.log(`stored map: ${JSON.stringify(stored?.autoDeleteBy)}`);

    if (EXISTING_ROOM) {
      const room = await prisma.privateRoom.findUnique({
        where: { roomId: EXISTING_ROOM },
        select: { participants: true, autoDeleteBy: true },
      });
      const viewer = room?.participants?.[0] ?? "";
      const wire = await api(mint(viewer), EXISTING_ROOM, "GET");
      check(
        `${EXISTING_ROOM}: unconfigured chat reports OFF`,
        wire.mode === "OFF",
        `map=${JSON.stringify(room?.autoDeleteBy)} wire=${JSON.stringify(wire)}`
      );
    }
  } finally {
    await prisma.privateMessage.deleteMany({ where: { roomId } });
    await prisma.privateRoom.deleteMany({ where: { roomId } });
    await prisma.$disconnect();
  }

  console.log(failed ? `\n${failed} FAILED` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}

void main();
