/**
 * One-off backfill: Group's role model collapsed from 4 tiers
 * (OWNER/ADMIN/MODERATOR/MEMBER) to 3 (ADMIN/MODERATOR/MEMBER), matching
 * Community. Every pre-existing GroupMember row with role="OWNER" must
 * become role="ADMIN" — the app code no longer recognizes "OWNER" at all,
 * so an un-migrated row reads as an unranked outsider (loses every
 * permission) instead of the group's sole admin.
 *
 * Safe to re-run — idempotent, only touches rows still holding "OWNER".
 *
 * Usage: pnpm --filter @aimess/chat-service db:backfill:group-owner-to-admin
 */
import { prisma } from "../src/config/prisma.js";

async function backfillGroupOwnerToAdmin() {
  const result = await prisma.groupMember.updateMany({
    where: { role: "OWNER" },
    data: { role: "ADMIN" },
  });

  console.log(
    `Done — updated ${result.count} GroupMember row(s) OWNER -> ADMIN.`
  );
}

backfillGroupOwnerToAdmin()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
