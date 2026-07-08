import dotenv from "dotenv";

import { PrismaClient } from "../src/generated/prisma/index.js";

dotenv.config();

/**
 * One-off repair for legacy duplicate member-targeted community reports.
 *
 * The service now enforces one report per (communityId, reporterId,
 * targetUserId), but old data can block MongoDB from building the partial
 * unique index. This script keeps the oldest report in each duplicate set and
 * deletes the newer rows. Direct file execution is a dry run unless --apply is
 * passed.
 *
 * Run:
 *   pnpm --filter @aimess/community-service db:repair:report-duplicates
 * Dry run:
 *   pnpm --filter @aimess/community-service exec tsx scripts/repair-community-report-duplicates.ts
 */

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");

async function main(): Promise<void> {
  const groups = await prisma.communityReport.groupBy({
    by: ["communityId", "reporterId", "targetUserId"],
    where: { targetUserId: { not: null } },
    _count: { _all: true },
  });

  const duplicateGroups = groups.filter(
    (group) => group.targetUserId && group._count._all > 1
  );

  let reportsScanned = 0;
  let reportsDeleted = 0;

  for (const group of duplicateGroups) {
    if (!group.targetUserId) continue;

    const reports = await prisma.communityReport.findMany({
      where: {
        communityId: group.communityId,
        reporterId: group.reporterId,
        targetUserId: group.targetUserId,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, createdAt: true, status: true },
    });

    reportsScanned += reports.length;
    const keep = reports[0];
    if (!keep || reports.length < 2) continue;

    const duplicateIds = reports.slice(1).map((report) => report.id);
    reportsDeleted += duplicateIds.length;

    console.log(
      [
        apply ? "repair" : "dry-run",
        `community=${group.communityId}`,
        `reporter=${group.reporterId}`,
        `target=${group.targetUserId}`,
        `keep=${keep.id}`,
        `delete=${duplicateIds.join(",")}`,
      ].join(" ")
    );

    if (apply && duplicateIds.length > 0) {
      await prisma.communityReport.deleteMany({
        where: { id: { in: duplicateIds } },
      });
    }
  }

  if (apply) {
    await prisma.$runCommandRaw({
      createIndexes: "community_reports",
      indexes: [
        {
          key: { communityId: 1, reporterId: 1, targetUserId: 1 },
          name: "community_reports_reporter_target_unique",
          unique: true,
          partialFilterExpression: { targetUserId: { $type: "string" } },
        },
      ],
    });
  }

  console.log(
    `${apply ? "Done" : "Dry run complete"}. Duplicate groups=${String(
      duplicateGroups.length
    )}, reports scanned=${String(reportsScanned)}, reports ${
      apply ? "deleted" : "that would be deleted"
    }=${String(reportsDeleted)}.`
  );

  if (!apply && reportsDeleted > 0) {
    console.log("Re-run with --apply to delete the duplicate rows.");
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
