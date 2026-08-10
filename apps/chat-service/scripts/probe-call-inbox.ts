/**
 * Live probe (real Mongo, no mocks): does call activity alone create/activate a
 * private conversation in the unified inbox, and does it order correctly against
 * text messages?
 *
 * Exercises the REAL CallChatMessageService + PrivateRoomRepository against the
 * dev database, then reads the rooms back through the SAME query the unified
 * inbox uses (`getInboxConversations`). Cleans up everything it creates.
 *
 *   MONGO_DATABASE_URL=mongodb://localhost:27018/aimess_chat?directConnection=true \
 *   pnpm exec tsx scripts/probe-call-inbox.ts
 */
import { randomUUID } from "node:crypto";

import { PrismaClient } from "../src/generated/prisma/index.js";
import { PrivateRoomRepository } from "../src/repositories/private-room.repository.js";
import { PrivateMessageRepository } from "../src/repositories/private-message.repository.js";
import { CallChatMessageService } from "../src/services/call-chat-message.service.js";
import { buildParticipantsKey } from "../src/lib/room-id.js";

const fakeRedis = {
  publish: async () => 1,
  pipeline: () => ({
    publish() {
      return this;
    },
    exec: async () => [],
  }),
} as never;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`
  );
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const roomRepo = new PrivateRoomRepository(prisma);
  const messageRepo = new PrivateMessageRepository(prisma, roomRepo as never);
  const svc = new CallChatMessageService(messageRepo, roomRepo, fakeRedis);

  const A = randomUUID();
  const B = randomUUID();
  const createdRooms: string[] = [];

  const freshRoom = async (): Promise<string> => {
    const roomId = `prv_probe_${randomUUID().slice(0, 12)}`;
    await roomRepo.create({
      roomId,
      participants: [A, B].sort(),
      participantsKey: buildParticipantsKey(A, B) + roomId,
    });
    createdRooms.push(roomId);
    return roomId;
  };

  const inbox = async (userId: string) =>
    roomRepo.getInboxConversations({
      userId,
      direction: "before",
      ts: new Date(),
      limit: 50,
    });

  const call = (roomId: string, callId: string, callType: string) => ({
    callId,
    callerId: A,
    calleeId: B,
    privateRoomId: roomId,
    callType,
    endedBy: A,
  });

  // ---- 1. voice call only, no text ever ------------------------------------
  {
    const roomId = await freshRoom();
    check(
      "room with no activity is NOT in the inbox",
      !(await inbox(A)).some((r) => r.roomId === roomId)
    );

    const callId = randomUUID();
    await svc.post({
      ...call(roomId, callId, "AUDIO"),
      outcome: "RINGING",
      endedAt: new Date(),
    });
    const ringingSeen = (await inbox(B)).find((r) => r.roomId === roomId);
    check(
      "callee sees the conversation while it is still RINGING",
      !!ringingSeen
    );

    await svc.post({
      ...call(roomId, callId, "AUDIO"),
      outcome: "ENDED",
      durationSec: 42,
      endedAt: new Date(),
    });
    for (const [label, uid] of [
      ["caller", A],
      ["callee", B],
    ] as const) {
      const row = (await inbox(uid)).find((r) => r.roomId === roomId);
      const lm = row?.lastMessage as {
        messageType?: string;
        content?: { text?: string };
      } | null;
      check(
        `voice call only: ${label} inbox row present, typed VOICE_CALL`,
        !!row && lm?.messageType === "VOICE_CALL",
        `${lm?.messageType} "${lm?.content?.text}"`
      );
    }
    const rows = await prisma.privateMessage.findMany({ where: { roomId } });
    check(
      "one call === one row (no duplicate cards)",
      rows.length === 1,
      `${rows.length} rows`
    );
  }

  // ---- 2. video call only ---------------------------------------------------
  {
    const roomId = await freshRoom();
    const callId = randomUUID();
    await svc.post({
      ...call(roomId, callId, "VIDEO"),
      outcome: "RINGING",
      endedAt: new Date(),
    });
    await svc.post({
      ...call(roomId, callId, "VIDEO"),
      outcome: "ENDED",
      durationSec: 8,
      endedAt: new Date(),
    });
    const row = (await inbox(B)).find((r) => r.roomId === roomId);
    const lm = row?.lastMessage as { messageType?: string } | null;
    check(
      "video call only: inbox row typed VIDEO_CALL",
      lm?.messageType === "VIDEO_CALL",
      String(lm?.messageType)
    );
  }

  // ---- 3. missed + declined -------------------------------------------------
  for (const outcome of ["MISSED", "DECLINED"] as const) {
    const roomId = await freshRoom();
    const callId = randomUUID();
    await svc.post({
      ...call(roomId, callId, "AUDIO"),
      outcome: "RINGING",
      endedAt: new Date(),
    });
    await svc.post({
      ...call(roomId, callId, "AUDIO"),
      outcome,
      endedAt: new Date(),
    });
    const room = await roomRepo.findByRoomId(roomId);
    const unread = (room?.unreadCountByUser ?? {}) as Record<string, number>;
    check(
      `${outcome}: conversation present`,
      (await inbox(B)).some((r) => r.roomId === roomId)
    );
    check(
      `${outcome}: callee unread = ${outcome === "MISSED" ? 1 : 0}`,
      (unread[B] ?? 0) === (outcome === "MISSED" ? 1 : 0),
      String(unread[B] ?? 0)
    );
  }

  // ---- 4. ordering: call then text, text then call ---------------------------
  {
    const roomId = await freshRoom();
    const c1 = randomUUID();
    await svc.post({
      ...call(roomId, c1, "AUDIO"),
      outcome: "RINGING",
      endedAt: new Date(),
    });
    await svc.post({
      ...call(roomId, c1, "AUDIO"),
      outcome: "ENDED",
      durationSec: 5,
      endedAt: new Date(),
    });

    const text = await messageRepo.createMessage({
      roomId,
      senderId: A,
      receiverId: B,
      content: { text: "hello", urls: [], files: [] },
      messageType: "TEXT",
      sequenceNumber: await roomRepo.allocateSequence(roomId),
      createdAt: new Date(Date.now() + 1000),
    });
    await roomRepo.updateRoomOnNewMessage({
      roomId,
      message: {
        _id: text.id,
        content: text.content,
        senderId: A,
        messageType: "TEXT",
        createdAt: text.createdAt,
      },
      receiverId: B,
    });
    let lm = (await roomRepo.findByRoomId(roomId))?.lastMessage as {
      messageType?: string;
    } | null;
    check(
      "call then text: last activity is the TEXT",
      lm?.messageType === "TEXT",
      String(lm?.messageType)
    );

    const c2 = randomUUID();
    const later = new Date(Date.now() + 2000);
    await svc.post({
      ...call(roomId, c2, "VIDEO"),
      outcome: "RINGING",
      endedAt: later,
    });
    await svc.post({
      ...call(roomId, c2, "VIDEO"),
      outcome: "ENDED",
      durationSec: 3,
      endedAt: later,
    });
    lm = (await roomRepo.findByRoomId(roomId))?.lastMessage as {
      messageType?: string;
    } | null;
    check(
      "text then call: last activity is the VIDEO_CALL",
      lm?.messageType === "VIDEO_CALL",
      String(lm?.messageType)
    );
  }

  // ---- 5. multiple calls in one room ----------------------------------------
  {
    const roomId = await freshRoom();
    for (let i = 0; i < 3; i += 1) {
      const id = randomUUID();
      // Past offsets: the inbox query bounds on `lastMessageAt <= now`.
      const at = new Date(Date.now() - (3 - i) * 1000);
      await svc.post({
        ...call(roomId, id, i === 2 ? "VIDEO" : "AUDIO"),
        outcome: "RINGING",
        endedAt: at,
      });
      await svc.post({
        ...call(roomId, id, i === 2 ? "VIDEO" : "AUDIO"),
        outcome: "ENDED",
        durationSec: 4,
        endedAt: at,
      });
    }
    const rows = await prisma.privateMessage.findMany({ where: { roomId } });
    check(
      "3 calls => 3 rows, 1 room",
      rows.length === 3,
      `${rows.length} rows`
    );
    const hits = (await inbox(A)).filter((r) => r.roomId === roomId);
    check(
      "3 calls => exactly one inbox entry",
      hits.length === 1,
      `${hits.length} entries`
    );
  }

  // ---- cleanup --------------------------------------------------------------
  for (const roomId of createdRooms) {
    await prisma.privateMessage.deleteMany({ where: { roomId } });
    await prisma.privateRoom
      .delete({ where: { roomId } })
      .catch(() => undefined);
  }
  await prisma.$disconnect();
  console.log(
    failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
