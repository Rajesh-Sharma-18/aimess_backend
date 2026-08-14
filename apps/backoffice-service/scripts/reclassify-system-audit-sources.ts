/**
 * Repairs audit rows the old pipeline stamped SYSTEM even though a person acted.
 *
 * Before the source was resolved at the choke point, a publish that ran without an
 * ambient request context fell through to SYSTEM. That made a user's action read as
 * "the platform did this" — the one thing the Source column exists to rule out. The
 * publisher no longer does that; this repairs the rows already written.
 *
 * Deliberately narrow. It touches ONLY rows where SYSTEM is provably wrong:
 *
 *   actorType = 'USER'   → a person acted, so a client was involved. The stored
 *                          user-agent names it; with none, WEB is the honest default
 *                          (the platform has no non-web end-user client that leaves
 *                          no user-agent).
 *   actorType = 'ADMIN'  → the admin panel is the only client that can produce an
 *                          admin actor, so the row is ADMIN_PANEL.
 *
 * Rows with actorType = 'SYSTEM' are left exactly as they are: those are sweepers and
 * tripwires, and SYSTEM is the true answer for them. Nothing is deleted and no other
 * column is touched, so the historical trail stays intact.
 *
 * DRY RUN by default — pass `--apply` to write.
 *
 * Usage: pnpm --filter @aimess/backoffice-service exec tsx scripts/reclassify-system-audit-sources.ts [--apply]
 */
import { resolveAuditSource } from "@aimess/constants";

import { prisma } from "../src/config/prisma.js";

const APPLY = process.argv.includes("--apply");
const BATCH = 500;

type Repairable = {
  id: string;
  actorType: "USER" | "ADMIN";
  userAgent: string | null;
};

/** The source a mis-stamped row should have carried. */
function repairedSource(
  row: Repairable
): "WEB" | "ANDROID" | "IOS" | "ADMIN_PANEL" {
  if (row.actorType === "ADMIN") return "ADMIN_PANEL";
  if (!row.userAgent) return "WEB";
  const sniffed = resolveAuditSource({ "user-agent": row.userAgent });
  // resolveAuditSource only ever returns ANDROID / IOS / WEB from a user-agent,
  // but narrow explicitly rather than trust that from a distance.
  return sniffed === "ANDROID" || sniffed === "IOS" ? sniffed : "WEB";
}

async function main(): Promise<void> {
  const rows = (await prisma.auditLog.findMany({
    where: { source: "SYSTEM", actorType: { in: ["USER", "ADMIN"] } },
    select: { id: true, actorType: true, userAgent: true },
    orderBy: { createdAt: "asc" },
  })) as Repairable[];

  if (rows.length === 0) {
    console.log("No SYSTEM-sourced user/admin rows found — nothing to repair.");
    return;
  }

  const buckets = new Map<string, string[]>();
  for (const row of rows) {
    const target = repairedSource(row);
    const ids = buckets.get(target) ?? [];
    ids.push(row.id);
    buckets.set(target, ids);
  }

  console.log(`Found ${String(rows.length)} row(s) to reclassify:`);
  for (const [source, ids] of buckets) {
    console.log(`  SYSTEM → ${source}: ${String(ids.length)}`);
  }

  if (!APPLY) {
    console.log("\nDRY RUN — re-run with --apply to write.");
    return;
  }

  let updated = 0;
  for (const [source, ids] of buckets) {
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      const result = await prisma.auditLog.updateMany({
        // Re-assert source=SYSTEM so a row already repaired by a concurrent run
        // is skipped rather than overwritten.
        where: { id: { in: slice }, source: "SYSTEM" },
        data: { source: source as "WEB" },
      });
      updated += result.count;
    }
  }
  console.log(`\nReclassified ${String(updated)} row(s).`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
