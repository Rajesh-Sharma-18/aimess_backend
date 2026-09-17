/**
 * Re-sends every moderated account's status to user-service.
 *
 * `mirrorProfileStatus` is fire-and-forget by design — the ban has already
 * landed in auth-service and must not be rolled back because user-service
 * blipped — so a lost gRPC call leaves `UserProfile.status` stuck on whatever
 * it was before, with nothing to notice. That was invisible while user-service
 * did nothing with the column; now that people discovery excludes BANNED rows,
 * a stale mirror means a banned account stays searchable to normal users.
 *
 * Accounts banned before `mirrorProfileStatus` existed at all have the same
 * signature, so this is also the one-time repair for them.
 *
 * admin_db's `UserIndex` is the authoritative moderation status (see
 * `resolveModerationStatus`), so the whole replay reads from this service's own
 * database and writes through the same `AdminSetProfileStatus` RPC a live ban
 * uses — no second code path to keep in step.
 *
 * Idempotent: the RPC is an `updateMany` to a fixed value, so re-running writes
 * the same status again. DRY RUN by default — pass `--apply` to write.
 *
 * Usage: pnpm --filter @aimess/backoffice-service exec tsx scripts/resync-profile-status-mirror.ts [--apply]
 */
import { prisma } from "../src/config/prisma.js";
import { userClient } from "../src/grpc/user.client.js";

const APPLY = process.argv.includes("--apply");
const BATCH = 500;

/**
 * `UserIndex.status` as user-service's `ProfileStatus` mirror.
 *
 * DELETED is skipped rather than mapped: deletion has its own pipeline
 * (`user.deleted` / `user.purged`), the profile status is terminal there, and
 * `adminSetStatus` refuses to write it anyway.
 */
const MIRRORED = {
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
  BANNED: "BANNED",
} as const;

/**
 * `UserProfile.userId` is `@db.Uuid`, so a non-UUID id cannot match a profile —
 * it can only make Prisma throw inside user-service. The dev seed writes
 * `UserIndex` rows with synthetic ids like `u_seed_32`, and without this guard
 * each one is a gRPC INTERNAL that counts against the circuit breaker until it
 * opens and fails every REAL user still queued behind them.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  let cursor: string | undefined;
  const counts = { ACTIVE: 0, SUSPENDED: 0, BANNED: 0 };
  let skipped = 0;
  let failed = 0;

  for (;;) {
    const rows = await prisma.userIndex.findMany({
      where: {
        status: { in: Object.keys(MIRRORED) as (keyof typeof MIRRORED)[] },
      },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { userId: cursor } } : {}),
      orderBy: { userId: "asc" },
      select: { userId: true, status: true },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.userId;

    for (const row of rows) {
      if (!UUID.test(row.userId)) {
        skipped++;
        continue;
      }
      const status = MIRRORED[row.status as keyof typeof MIRRORED];
      counts[status]++;
      if (!APPLY) continue;
      // Sequential on purpose: this is a repair, not a hot path, and fanning
      // hundreds of gRPC calls at user-service to save a few seconds is how a
      // backfill takes down the service it is repairing.
      try {
        await userClient.adminSetProfileStatus(row.userId, status);
      } catch (err) {
        failed++;
        console.error(`  ${row.userId} (${status}): ${String(err)}`);
      }
    }
  }

  console.log(APPLY ? "RESYNCED" : "DRY RUN — would resync");
  for (const [status, count] of Object.entries(counts)) {
    console.log(`  ${status.padEnd(9)} ${count}`);
  }
  if (skipped > 0) {
    console.log(`  ${skipped} skipped (id is not a profile UUID)`);
  }
  if (APPLY && failed > 0) {
    console.log(`  ${failed} failed — safe to re-run.`);
  }
  if (!APPLY) console.log("Re-run with --apply to write.");

  await prisma.$disconnect();
}

await main();
