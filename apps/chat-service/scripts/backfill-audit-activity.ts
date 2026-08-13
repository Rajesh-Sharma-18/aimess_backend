/**
 * Replays group lifecycle history into the admin panel's audit log.
 *
 * Group lifecycle is persisted as SYSTEM messages on the room ("X added Y", "X changed
 * the role of Z", …), so those rows ARE the history. They are replayed through the SAME
 * queue the live mirror uses, reusing the live map so the two can never disagree.
 * Ordinary chat messages are never touched — only rows carrying a `systemEvent`.
 *
 * Idempotent: deterministic `backfill:` eventIds, duplicates swallowed by the consumer.
 * DRY RUN by default — pass `--apply` to publish.
 *
 * Usage: pnpm --filter @aimess/chat-service exec tsx scripts/backfill-audit-activity.ts [--apply] [--until=<ISO>]
 */
import {
  backfillEventId,
  closeAdminActivityPublisher,
  publishAdminActivity,
  USER_AUDIT_ACTIONS,
} from "@aimess/messaging";

import { prisma } from "../src/config/prisma.js";
import { ADMIN_ACTIVITY_BY_SYSTEM_EVENT } from "../src/services/group-system-message.service.js";
import type { SystemEvent } from "../src/types/enums.js";

const APPLY = process.argv.includes("--apply");
const BATCH = 500;

// Replay only what predates the live pipeline — see the auth/community scripts.
const untilArg = process.argv
  .find((a) => a.startsWith("--until="))
  ?.slice("--until=".length);
const UNTIL = untilArg ? new Date(untilArg) : null;
if (untilArg && Number.isNaN(UNTIL?.getTime())) {
  throw new Error(`--until is not a valid date: ${untilArg}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIRRORED_EVENTS = Object.keys(ADMIN_ACTIVITY_BY_SYSTEM_EVENT);

const counts = new Map<string, number>();
let published = 0;
let systemActors = 0;

async function emit(input: {
  actorId: string | null;
  action: string;
  targetId: string;
  eventId: string;
  eventAt: Date;
  after: Record<string, unknown>;
}): Promise<void> {
  if (UNTIL && input.eventAt >= UNTIL) return;
  // senderId is null on platform-admin actions (kick/disband as admin) — those are the
  // platform acting, not a member, so they travel as SYSTEM.
  const isUserActor = !!input.actorId && UUID.test(input.actorId);
  if (!isUserActor) systemActors++;
  counts.set(input.action, (counts.get(input.action) ?? 0) + 1);
  if (!APPLY) return;
  await publishAdminActivity({
    actorId: isUserActor ? input.actorId : null,
    actorType: isUserActor ? "USER" : "SYSTEM",
    action: input.action,
    targetType: "group",
    targetId: input.targetId,
    after: input.after,
    eventAt: input.eventAt.toISOString(),
    eventId: input.eventId,
  });
  published++;
}

// 1. Lifecycle system messages, mapped through the live mirror's own table.
async function backfillSystemMessages(): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.groupMessage.findMany({
      where: { systemEvent: { in: MIRRORED_EVENTS } },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: {
        id: true,
        roomId: true,
        senderId: true,
        systemEvent: true,
        systemData: true,
        createdAt: true,
      },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      const action =
        ADMIN_ACTIVITY_BY_SYSTEM_EVENT[row.systemEvent as SystemEvent];
      if (!action) continue;
      const data = (row.systemData ?? {}) as Record<string, unknown>;
      const targetUserIds = Array.isArray(data.targetUserIds)
        ? data.targetUserIds.map(String)
        : typeof data.targetUserId === "string"
          ? [data.targetUserId]
          : [];
      await emit({
        actorId: row.senderId,
        action,
        targetId: row.roomId,
        eventId: backfillEventId("chat-sysmsg", row.id),
        eventAt: row.createdAt,
        after: { systemEvent: row.systemEvent, targetUserIds },
      });
    }
  }
}

// 2. Disband posts no system message, so it comes from the room row itself.
async function backfillDisbands(): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.groupRoom.findMany({
      where: { disbandedAt: { not: null } },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: {
        id: true,
        name: true,
        disbandedAt: true,
        disbandedBy: true,
      },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      await emit({
        actorId: row.disbandedBy,
        action: USER_AUDIT_ACTIONS.GROUP_DISBANDED,
        targetId: row.id,
        eventId: backfillEventId("chat-group-room", row.id, "disbanded"),
        eventAt: row.disbandedAt as Date,
        after: { name: row.name },
      });
    }
  }
}

async function main(): Promise<void> {
  await backfillSystemMessages();
  await backfillDisbands();

  const planned = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log(APPLY ? "PUBLISHED" : "DRY RUN — would publish");
  for (const [action, n] of planned)
    console.log(`  ${n.toString().padStart(6)}  ${action}`);
  console.log(
    `  total=${planned.reduce((sum, [, n]) => sum + n, 0)} systemActorRows=${systemActors}${APPLY ? ` publishedToBroker=${published}` : ""}`
  );
  if (!APPLY) console.log("Re-run with --apply to publish.");

  await closeAdminActivityPublisher();
  await prisma.$disconnect();
}

await main();
