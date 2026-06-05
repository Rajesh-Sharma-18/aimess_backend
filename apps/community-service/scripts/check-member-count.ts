/**
 * Diagnostic: compare each community's stored `memberCount` against the real
 * CommunityMember rows, broken down by status. Reveals whether a "wrong member
 * count" is data drift (stored != ACTIVE rows) or just a definition mismatch
 * (memberCount counts ACTIVE only — PENDING/BANNED/LEFT are excluded).
 *
 *   pnpm --filter @aimess/community-service exec tsx scripts/check-member-count.ts
 *
 * Optional: CHECK_COMMUNITY_ID=<id> to inspect a single community.
 *           FIX=1 to rewrite stored memberCount to the live ACTIVE count.
 */
import { prisma } from "../src/config/prisma.js";
import { CommunityMemberStatus } from "../src/generated/prisma/index.js";

async function main(): Promise<void> {
  const onlyId = process.env.CHECK_COMMUNITY_ID;
  const fix = process.env.FIX === "1";

  const communities = await prisma.community.findMany({
    where: {
      deletedAt: { isSet: false },
      ...(onlyId ? { id: onlyId } : {}),
    },
    select: { id: true, name: true, handle: true, memberCount: true },
    orderBy: { id: "desc" },
  });

  if (communities.length === 0) {
    console.log("No (non-deleted) communities found.");
    return;
  }

  let drifted = 0;
  for (const c of communities) {
    // Group this community's member rows by status.
    const grouped = await prisma.communityMember.groupBy({
      by: ["status"],
      where: { communityId: c.id },
      _count: { _all: true },
    });
    const byStatus: Record<string, number> = {};
    for (const g of grouped) byStatus[String(g.status)] = g._count._all;

    const active = byStatus[CommunityMemberStatus.ACTIVE] ?? 0;
    const drift = c.memberCount !== active;
    if (drift) drifted++;

    console.log(
      `${drift ? "✗ DRIFT" : "✓ ok   "}  ${c.name} (${c.handle})  ` +
        `stored=${c.memberCount}  activeRows=${active}  ` +
        `breakdown=${JSON.stringify(byStatus)}`
    );

    if (drift && fix) {
      await prisma.community.update({
        where: { id: c.id },
        data: { memberCount: active },
      });
      console.log(`   ↳ fixed: memberCount ${c.memberCount} → ${active}`);
    }
  }

  console.log(
    `\n${communities.length} communities checked, ${drifted} drifted` +
      (fix ? " (fixed)" : drifted ? " — re-run with FIX=1 to repair" : "")
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
