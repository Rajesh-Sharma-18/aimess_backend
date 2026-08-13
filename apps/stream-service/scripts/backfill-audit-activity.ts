/**
 * Replays livestream history into the admin panel's audit log.
 *
 * The live pipeline only records broadcasts that start after it was deployed, so every
 * stream ever run is missing from the Audit Logs screen. This publishes them through the
 * SAME queue the live path uses, so backoffice's consumer applies identical validation.
 *
 * Idempotent: deterministic `backfill:` eventIds, duplicates swallowed by the consumer.
 * DRY RUN by default — pass `--apply` to publish.
 *
 * Usage: pnpm --filter @aimess/stream-service exec tsx scripts/backfill-audit-activity.ts [--apply] [--until=<ISO>]
 */
import {
  backfillEventId,
  closeAdminActivityPublisher,
  publishAdminActivity,
  USER_AUDIT_ACTIONS,
} from "@aimess/messaging";

import { prisma } from "../src/config/prisma.js";

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
    targetType: "stream",
    targetId: input.targetId,
    after: input.after,
    eventAt: input.eventAt.toISOString(),
    eventId: input.eventId,
  });
  published++;
}

/**
 * `livedAt` is the only reliable "went live" marker. It also gates the ended facet:
 * the stale-PENDING sweeper stamps `endedAt` on streams that never went live at all,
 * and replaying those would invent a broadcast that never happened.
 */
async function backfillStreams(): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.livestream.findMany({
      where: { livedAt: { not: null } },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: {
        id: true,
        creatorId: true,
        communityId: true,
        title: true,
        sourceType: true,
        peakViewers: true,
        totalViews: true,
        livedAt: true,
        endedAt: true,
      },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      await emit({
        actorId: row.creatorId,
        action: USER_AUDIT_ACTIONS.STREAM_STARTED,
        targetId: row.id,
        eventId: backfillEventId("stream-livestream", row.id, "started"),
        eventAt: row.livedAt as Date,
        after: {
          communityId: row.communityId,
          title: row.title,
          sourceType: row.sourceType,
        },
      });

      if (row.endedAt) {
        const durationSeconds = Math.max(
          0,
          Math.round(
            (row.endedAt.getTime() - (row.livedAt as Date).getTime()) / 1000
          )
        );
        await emit({
          actorId: row.creatorId,
          action: USER_AUDIT_ACTIONS.STREAM_ENDED,
          targetId: row.id,
          eventId: backfillEventId("stream-livestream", row.id, "ended"),
          eventAt: row.endedAt,
          after: {
            communityId: row.communityId,
            durationSeconds,
            peakViewers: row.peakViewers,
            totalViews: row.totalViews,
          },
        });
      }
    }
  }
}

async function main(): Promise<void> {
  await backfillStreams();

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
