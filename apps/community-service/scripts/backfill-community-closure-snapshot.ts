/**
 * One-off backfill: Super Admin closure snapshots for communities closed BEFORE
 * Community.memberCountAtClosure / CommunityMember.closureRosterAt existed.
 *
 * Without it, a legacy closed community reads the live rule in the admin
 * panel — and the old close marked every ACTIVE member LEFT, so its count and
 * roster would read as empty.
 *
 * The closure instant T is the earliest of `statusClosedAt` (owner close) and
 * `closedAt` (platform suspend). CommunityMember rows are never deleted, so the
 * roster at T is rebuilt from them:
 *   ACTIVE / BANNED                      → still on the roster
 *   LEFT with updatedAt >= T - tolerance → ended at or after the closure (the
 *                                          old close flipped them all at T)
 * The count is the roster minus rows that were BANNED at T (still BANNED, or
 * unbanned at/after T). ponytail: LEFT has no leftAt, so updatedAt stands in —
 * a pre-close leaver whose row was rewritten after T is counted; add a leftAt
 * column if that ever matters.
 *
 * A community with neither timestamp is reported and left on the live rule.
 * Idempotent: only communities with a null memberCountAtClosure are touched.
 *
 * Dry run (default, writes nothing):
 *   pnpm --filter @aimess/community-service db:backfill:closure-snapshot
 * Apply:
 *   pnpm --filter @aimess/community-service db:backfill:closure-snapshot -- --apply
 */
import { prisma } from "../src/config/prisma.js";
import {
  CommunityMemberStatus,
  type CommunityMember,
} from "../src/generated/prisma/index.js";

const APPLY = process.argv.includes("--apply");
const TOLERANCE_MS = 60_000;

function wasOnRosterAt(m: CommunityMember, t: Date): boolean {
  if (m.joinedAt > t) return false;
  if (m.status === CommunityMemberStatus.ACTIVE) return true;
  if (m.status === CommunityMemberStatus.BANNED) return true;
  if (m.status === CommunityMemberStatus.LEFT) {
    return m.updatedAt.getTime() >= t.getTime() - TOLERANCE_MS;
  }
  return false;
}

function wasBannedAt(m: CommunityMember, t: Date): boolean {
  return (
    m.status === CommunityMemberStatus.BANNED ||
    (!!m.unbannedAt && m.unbannedAt >= t)
  );
}

async function main(): Promise<void> {
  const communities = await prisma.community.findMany({
    where: {
      deletedAt: { isSet: false },
      OR: [{ status: "CLOSED" }, { moderationStatus: "SUSPENDED" }],
    },
    select: {
      id: true,
      name: true,
      memberCountAtClosure: true,
      statusClosedAt: true,
      closedAt: true,
    },
  });

  let done = 0;
  for (const c of communities) {
    if (c.memberCountAtClosure != null) continue;
    const times = [c.statusClosedAt, c.closedAt].filter(
      (d): d is Date => d instanceof Date
    );
    if (times.length === 0) {
      console.log(`skip  ${c.id} ${c.name} — no closure timestamp`);
      continue;
    }
    const t = new Date(Math.min(...times.map((d) => d.getTime())));

    const rows = await prisma.communityMember.findMany({
      where: { communityId: c.id },
    });
    const roster = rows.filter((m) => wasOnRosterAt(m, t));
    const count = roster.filter((m) => !wasBannedAt(m, t)).length;
    console.log(
      `${APPLY ? "apply" : "dry  "} ${c.id} ${c.name} — closedAt=${t.toISOString()} roster=${roster.length} count=${count} (rows=${rows.length})`
    );

    if (APPLY) {
      await prisma.communityMember.updateMany({
        where: { id: { in: roster.map((m) => m.id) } },
        data: { closureRosterAt: t },
      });
      await prisma.community.update({
        where: { id: c.id },
        data: { memberCountAtClosure: count },
      });
    }
    done += 1;
  }

  console.log(
    `\n${communities.length} closed communities, ${done} ${APPLY ? "backfilled" : "to backfill (re-run with --apply)"}`
  );
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
