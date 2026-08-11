/**
 * Read-only probe (real Mongo, no mocks): where does a message's auto-delete
 * deadline come from when the chat's gear menu says "Off"?
 *
 * Dumps the per-chat `autoDeleteBy` map of the rooms that actually have armed
 * messages, so a stamped TTL can be traced to a per-chat setting (self or peer)
 * or — when every map is empty — to the sender's account-wide default.
 *
 *   MONGO_DATABASE_URL=mongodb://localhost:27018/aimess_chat?directConnection=true \
 *   pnpm exec tsx scripts/probe-auto-delete-source.ts
 */
import { PrismaClient } from "../src/generated/prisma/index.js";

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const armed = await prisma.privateMessage.findMany({
      where: { AND: [{ autoDeleteAt: { not: null } }, { isDeleted: false }] },
      select: {
        id: true,
        roomId: true,
        senderId: true,
        createdAt: true,
        autoDeleteAt: true,
        autoDeleteAfterView: true,
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const roomIds = [...new Set(armed.map((m) => m.roomId))];
    const rooms = await prisma.privateRoom.findMany({
      where: { roomId: { in: roomIds } },
      select: { roomId: true, participants: true, autoDeleteBy: true },
    });
    console.log(`armed=${armed.length} rooms=${rooms.length}`);
    for (const r of rooms) {
      console.log(
        `  ${r.roomId} participants=${JSON.stringify(r.participants)} autoDeleteBy=${JSON.stringify(r.autoDeleteBy)}`
      );
    }
    const bySender = new Map<string, number[]>();
    for (const m of armed) {
      const ttl = Math.round(
        (m.autoDeleteAt!.getTime() - m.createdAt.getTime()) / 1000
      );
      bySender.set(m.senderId!, [...(bySender.get(m.senderId!) ?? []), ttl]);
    }
    for (const [senderId, ttls] of bySender) {
      console.log(
        `  sender=${senderId} ttls=${JSON.stringify([...new Set(ttls)])}`
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main();
