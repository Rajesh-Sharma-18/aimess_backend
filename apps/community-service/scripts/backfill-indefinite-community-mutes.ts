/**
 * One-off migration helper for the community notification-mute model change.
 *
 * BEFORE: `CommunityMuteSetting.mutedUntil === null` on an existing row meant
 * "muted indefinitely", and that global flag suppressed every notification kind
 * regardless of the three category toggles — so it also silenced any member who
 * had merely touched a toggle (the row that creates carries `mutedUntil = null`),
 * permanently, with no way to re-enable.
 *
 * AFTER: `mutedUntil` is a TIMED mute only; an indefinite mute is stored as all
 * three category toggles off.
 *
 * The old schema CANNOT reliably tell a genuine indefinite mute from a
 * preferences row: both are `mutedUntil = null`, and a member who switched a
 * category off and back on again lands on all-three-true too. So this script is
 * DRY-RUN by default — it only counts the ambiguous rows. Without `--apply`
 * nothing is written and those rows read as un-muted after deploy, which is the
 * fail-safe direction (notifications resume; re-muting is one tap).
 *
 * Pass `--apply` to re-express every ambiguous row as an indefinite mute
 * (all three toggles off). Choose this only if preserving old mutes matters
 * more than the members whose switches were genuinely on. Idempotent either way.
 *
 * Usage: pnpm --filter @aimess/community-service exec tsx scripts/backfill-indefinite-community-mutes.ts [--apply]
 */
import { prisma } from "../src/config/prisma.js";

const AMBIGUOUS = {
  mutedUntil: null,
  streamEnabled: true,
  chatEnabled: true,
  announcementEnabled: true,
} as const;

async function backfillIndefiniteCommunityMutes() {
  const apply = process.argv.includes("--apply");
  const count = await prisma.communityMuteSetting.count({ where: AMBIGUOUS });

  if (!apply) {
    console.log(
      `${count} legacy row(s) are ambiguous (no timed mute, all categories on).\n` +
        `Dry run — nothing written. They will read as UN-muted after deploy.\n` +
        `Re-run with --apply to convert them into indefinite mutes instead.`
    );
    return;
  }

  const result = await prisma.communityMuteSetting.updateMany({
    where: AMBIGUOUS,
    data: {
      streamEnabled: false,
      chatEnabled: false,
      announcementEnabled: false,
    },
  });
  console.log(
    `Done — converted ${result.count} legacy row(s) to all-categories-off.`
  );
}

backfillIndefiniteCommunityMutes()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
