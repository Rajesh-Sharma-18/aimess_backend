/**
 * One-off: mark every already-DISMISSED banned community read for its member.
 *
 * The Community nav badge now counts BANNED rows (their pre-ban unread, the
 * same number the row shows), and dismissing a banned row marks it read so it
 * leaves the badge with the list. Rows dismissed BEFORE that change were never
 * read, so their pre-ban unread would surface as a badge with no row to clear
 * it. This reads each one up to the ban through the same chat-service call the
 * dismiss now makes. Idempotent; dry-run unless `--apply`.
 *
 * Usage: pnpm --filter @aimess/community-service exec tsx scripts/backfill-dismissed-ban-read.ts [--apply]
 */
import { prisma } from "../src/config/prisma.js";
import { getChatClient } from "../src/grpc/chat.client.js";

async function backfillDismissedBanRead() {
  const apply = process.argv.includes("--apply");
  const rows = await prisma.communityMember.findMany({
    where: { status: "BANNED", dismissedAt: { isSet: true } },
    select: { communityId: true, userId: true },
  });

  if (!apply) {
    console.log(
      `${rows.length} dismissed banned membership(s). Dry run — re-run with --apply.`
    );
    return;
  }

  let done = 0;
  for (const r of rows) {
    await getChatClient().bulkMarkCommunityRead({
      userId: r.userId,
      communityIds: [r.communityId],
    });
    done++;
  }
  console.log(`Done — marked ${done} dismissed banned membership(s) read.`);
}

backfillDismissedBanRead()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
