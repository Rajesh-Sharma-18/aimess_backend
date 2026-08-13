/**
 * Replays abuse reports into the audit log as `report.submitted` rows.
 *
 * admin_db.Report already holds every report community-service and chat-service ever
 * ingested, so this runs entirely inside backoffice-service — no queue, no cross-service
 * Mongo client, and it is the smallest possible blast radius for proving the AuditLog
 * write path before the other backfills start pushing through RabbitMQ.
 *
 * Idempotent: `eventId` is unique and the insert uses skipDuplicates.
 * DRY RUN by default — pass `--apply` to write.
 *
 * Usage: pnpm --filter @aimess/backoffice-service exec tsx scripts/backfill-audit-activity-reports.ts [--apply] [--until=<ISO>]
 */
import { backfillEventId, USER_AUDIT_ACTIONS } from "@aimess/messaging";

import { prisma } from "../src/config/prisma.js";

const APPLY = process.argv.includes("--apply");
const BATCH = 500;

// chat-service and community-service publish report.submitted live now, so anything
// filed after the pipeline went live is already here under a different eventId. Pass the
// deploy timestamp to keep the replay strictly historical.
const untilArg = process.argv
  .find((a) => a.startsWith("--until="))
  ?.slice("--until=".length);
const UNTIL = untilArg ? new Date(untilArg) : null;
if (untilArg && Number.isNaN(UNTIL?.getTime())) {
  throw new Error(`--until is not a valid date: ${untilArg}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  let cursor: string | undefined;
  let planned = 0;
  let written = 0;

  for (;;) {
    const rows = await prisma.report.findMany({
      where: UNTIL ? { createdAt: { lt: UNTIL } } : {},
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: {
        id: true,
        type: true,
        targetId: true,
        reporterId: true,
        reason: true,
        reportedUserId: true,
        createdAt: true,
      },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    // targetType mirrors the live publisher (the report's own `type`), so historical and
    // live rows share the [targetType, targetId] index instead of splitting it.
    const data = rows.map((r) => ({
      actorId: UUID.test(r.reporterId) ? r.reporterId : null,
      actorType: UUID.test(r.reporterId)
        ? ("USER" as const)
        : ("SYSTEM" as const),
      action: USER_AUDIT_ACTIONS.REPORT_SUBMITTED,
      targetType: r.type,
      targetId: r.targetId,
      after: {
        reason: r.reason,
        reportedUserId: r.reportedUserId ?? null,
      },
      eventId: backfillEventId("admin-report", r.id),
      createdAt: r.createdAt,
    }));

    planned += data.length;
    if (APPLY) {
      const result = await prisma.auditLog.createMany({
        data,
        skipDuplicates: true,
      });
      written += result.count;
    }
  }

  console.log(APPLY ? "PUBLISHED" : "DRY RUN — would write");
  console.log(
    `  ${planned}  ${USER_AUDIT_ACTIONS.REPORT_SUBMITTED}${APPLY ? ` inserted=${written} (skipped duplicates=${planned - written})` : ""}`
  );
  if (!APPLY) console.log("Re-run with --apply to write.");

  await prisma.$disconnect();
}

await main();
