/**
 * Replays this service's existing history into the admin panel's audit log.
 *
 * The live pipeline (communityService.recordAudit -> publishAdminActivitySafe) only
 * records what happens AFTER it was deployed, so the Audit Logs screen shows no
 * community activity until someone acts. This script publishes the community history
 * that is already persisted here through the SAME queue the live path uses, so the
 * consumer in backoffice-service writes it with the same shape and validation.
 *
 * Idempotent: every row carries a deterministic `backfill:` eventId, and the consumer
 * swallows the duplicate insert, so re-running changes nothing.
 *
 * DRY RUN by default — prints what it would publish. Pass `--apply` to publish.
 *
 * Usage: pnpm --filter @aimess/community-service exec tsx scripts/backfill-audit-activity.ts [--apply]
 */
import {
  backfillEventId,
  closeAdminActivityPublisher,
  publishAdminActivity,
  USER_AUDIT_ACTIONS,
} from "@aimess/messaging";

import { prisma } from "../src/config/prisma.js";
import { ADMIN_ACTIVITY_BY_COMMUNITY_ACTION } from "../src/services/community.service.js";
import type { CommunityAuditAction } from "../src/types/community.types.js";

const APPLY = process.argv.includes("--apply");
const BATCH = 500;

/**
 * Replay only what happened BEFORE the live pipeline started publishing, otherwise a
 * row recorded live and the same row replayed here both land (they carry different
 * eventIds, so the unique index cannot collapse them). Pass the deploy timestamp:
 * `--until=2026-08-13T06:25:00.000Z`. Default: everything.
 */
const untilArg = process.argv
  .find((a) => a.startsWith("--until="))
  ?.slice("--until=".length);
const UNTIL = untilArg ? new Date(untilArg) : null;
if (untilArg && Number.isNaN(UNTIL?.getTime())) {
  throw new Error(`--until is not a valid date: ${untilArg}`);
}

// admin_db.AuditLog.actorId is a uuid column. Non-uuid actors are real — the auto-unmute
// sweeper and backoffice close/reopen both write actorId "system" — so they are recorded
// as SYSTEM rather than dropped, which is what the live mirror now does too.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const counts = new Map<string, number>();
let published = 0;
let systemActors = 0;

async function emit(input: {
  actorId: string;
  action: string;
  targetId: string;
  eventId: string;
  eventAt: Date;
  after: Record<string, unknown>;
}): Promise<void> {
  if (UNTIL && input.eventAt >= UNTIL) return;
  const isUserActor = UUID.test(input.actorId);
  if (!isUserActor) systemActors++;
  counts.set(input.action, (counts.get(input.action) ?? 0) + 1);
  if (!APPLY) return;
  await publishAdminActivity({
    actorId: isUserActor ? input.actorId : null,
    actorType: isUserActor ? "USER" : "SYSTEM",
    action: input.action,
    targetType: "community",
    targetId: input.targetId,
    after: isUserActor
      ? input.after
      : { ...input.after, systemActor: input.actorId },
    eventAt: input.eventAt.toISOString(),
    eventId: input.eventId,
  });
  published++;
}

// 1. Moderation trail — the same map the live mirror uses, so history and new rows
//    can never disagree about which community action maps to which audit action.
async function backfillAuditLog(): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.communityAuditLog.findMany({
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      const action =
        ADMIN_ACTIVITY_BY_COMMUNITY_ACTION[row.action as CommunityAuditAction];
      if (!action) continue;
      await emit({
        actorId: row.actorId,
        action,
        targetId: row.communityId,
        eventId: backfillEventId("community-audit", row.id),
        eventAt: row.createdAt,
        after: {
          communityAction: row.action,
          targetUserId: row.targetUserId ?? null,
          ...(row.reason ? { reason: row.reason } : {}),
        },
      });
    }
  }
}

// 2. Community creation — never went through the moderation trail, so it has to come
//    from the row itself. `creatorId` is the original creator, not the current admin.
async function backfillCreations(): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.community.findMany({
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: {
        id: true,
        name: true,
        handle: true,
        type: true,
        creatorId: true,
        createdAt: true,
      },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      await emit({
        actorId: row.creatorId,
        action: USER_AUDIT_ACTIONS.COMMUNITY_CREATED,
        targetId: row.id,
        eventId: backfillEventId("community-created", row.id),
        eventAt: row.createdAt,
        after: { name: row.name, handle: row.handle, type: row.type },
      });
    }
  }
}

async function main(): Promise<void> {
  await backfillAuditLog();
  await backfillCreations();

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
