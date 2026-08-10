/**
 * Live probe (real Mongo + real Redis, real gRPC handler): does a SECOND friend
 * request — sent after the pair unfriended, on the SAME recycled friendship id —
 * arrive as `notification:new`?
 *
 * Drives `createNotificationImpl().createNotification` with the real
 * NotificationRepository and captures what is published on `notify:<userId>`.
 * Cleans up every row it writes.
 *
 *   MONGO_DATABASE_URL=... pnpm exec tsx scripts/probe-friend-request-notification.ts
 */
import { randomUUID } from "node:crypto";

import Redis from "ioredis";

import { PrismaClient } from "../src/generated/prisma/index.js";
import { NotificationRepository } from "../src/repositories/notification.repository.js";
import { createNotificationImpl } from "../src/grpc/service-impl.js";
import { redis } from "../src/config/redis.js";

type Handler = (
  call: { request: unknown },
  cb: (err: unknown, res?: unknown) => void
) => void;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`
  );
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const notificationRepo = new NotificationRepository(prisma);
  const handler = createNotificationImpl({
    notificationRepo,
  } as never).createNotification as Handler;

  const A = randomUUID(); // addressee — the user under test
  const B = randomUUID(); // requester
  const friendshipId = randomUUID(); // recycled across both cycles

  // Capture what user A's `/notify` socket would receive.
  const sub = new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number(process.env.REDIS_PORT ?? 6379),
  });
  const events: Array<{ event: string; id: string }> = [];
  await sub.subscribe(`notify:${A}`);
  sub.on("message", (_channel, raw) => {
    try {
      const parsed = JSON.parse(raw) as {
        event?: string;
        data?: { notificationId?: string };
      };
      if (parsed.event?.startsWith("notification:")) {
        events.push({
          event: parsed.event,
          id: parsed.data?.notificationId ?? "",
        });
      }
    } catch {
      /* ignore */
    }
  });

  const invoke = (request: unknown): Promise<{ id: string }> =>
    new Promise((resolve, reject) => {
      handler({ request }, (err, res) =>
        err ? reject(new Error(String(err))) : resolve(res as { id: string })
      );
    });
  const settle = () => new Promise((r) => setTimeout(r, 400));

  const requestEvent = {
    userId: A,
    actorId: B,
    type: "friend.requested",
    title: "Friend request",
    body: "User B wants to be your friend",
    data: { friendshipId, requesterId: B },
  };

  // ---- cycle 1: request -> accept ------------------------------------------
  const first = await invoke(requestEvent);
  await settle();
  check(
    "cycle 1 request => notification:new",
    events.some((e) => e.event === "notification:new" && e.id === first.id)
  );

  await invoke({
    userId: A,
    actorId: B,
    type: "friend.accepted",
    title: "Accepted",
    body: "You are now friends",
    data: { friendshipId, requesterId: B, resurface: "false" },
  });
  await settle();
  check(
    "accept resolves the SAME card in place (notification:updated)",
    events.some((e) => e.event === "notification:updated" && e.id === first.id)
  );
  check(
    "accept created no second row",
    (await prisma.notification.count({ where: { userId: A } })) === 1
  );

  // ---- unfriend (silent, no notification event) then request AGAIN ----------
  events.length = 0;
  const second = await invoke(requestEvent);
  await settle();

  check(
    "re-request after unfriend => a NEW row",
    second.id !== first.id,
    `${first.id} -> ${second.id}`
  );
  check(
    "re-request after unfriend => notification:new (not :updated)",
    events.some((e) => e.event === "notification:new" && e.id === second.id) &&
      !events.some((e) => e.event === "notification:updated"),
    events.map((e) => e.event).join(", ") || "<nothing published>"
  );
  check(
    "unread count_update still fires",
    events.some((e) => e.event === "notification:count_update")
  );

  const rows = await prisma.notification.findMany({
    where: { userId: A },
    orderBy: { createdAt: "desc" },
  });
  check(
    "two cards total (old outcome kept as history)",
    rows.length === 2,
    `${rows.length}`
  );
  check(
    "newest card is the pending request and is unread",
    rows[0]?.type === "friend.requested" && rows[0]?.isRead === false,
    `${rows[0]?.type} isRead=${rows[0]?.isRead}`
  );
  check(
    "accepting the NEW request resolves the NEW card",
    (await (async () => {
      await invoke({
        userId: A,
        actorId: B,
        type: "friend.accepted",
        title: "Accepted",
        body: "You are now friends",
        data: { friendshipId, requesterId: B, resurface: "false" },
      });
      const after = await prisma.notification.findUnique({
        where: { id: second.id },
      });
      return after?.type;
    })()) === "friend.accepted"
  );

  await prisma.notification.deleteMany({ where: { userId: A } });
  await sub.quit();
  await prisma.$disconnect();
  await redis.quit().catch(() => undefined);
  console.log(
    failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
