/**
 * System Messages v2 §3 — groups are leader (ADMIN) + members only.
 *
 *   MODERATOR → MEMBER, moderation mutes cleared, BANNED → KICKED (re-addable;
 *   the ban stamps move to the kick columns). Posts no system lines.
 *   The closed-group roster snapshots (group_closure_members) get the same
 *   role/status mapping, so the admin panel never lists a group MODERATOR/BANNED.
 *
 * Idempotent: every step only matches rows not yet migrated.
 *
 * Dry run (default, writes nothing):
 *   pnpm --filter @aimess/chat-service migrate:group-leader-members
 * Apply:
 *   pnpm --filter @aimess/chat-service migrate:group-leader-members -- --apply
 */
import { logger } from "@aimess/logger";

import { prisma } from "../src/config/prisma.js";

export const MODERATOR_WHERE = { role: "MODERATOR" };
export const MODERATOR_DATA = { role: "MEMBER" };
export const MUTED_WHERE = {
  OR: [
    { moderationMuted: true },
    { moderationMutedUntil: { not: null } },
    { moderationMutedBy: { not: null } },
  ],
};
export const MUTED_DATA = {
  moderationMuted: false,
  moderationMutedUntil: null,
  moderationMutedBy: null,
};
export const BANNED_WHERE = { status: "BANNED" };
export const CLOSURE_BANNED_DATA = { status: "KICKED", bannedAt: null };

export function bannedToKicked(row: {
  bannedAt: Date | null;
  bannedBy: string | null;
  updatedAt: Date;
}): Record<string, unknown> {
  return {
    status: "KICKED",
    kickedAt: row.bannedAt ?? row.updatedAt,
    kickedBy: row.bannedBy,
    bannedAt: null,
    bannedBy: null,
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const tag = apply ? "" : " (DRY RUN, pass --apply to write)";

  const moderators = apply
    ? (
        await prisma.groupMember.updateMany({
          where: MODERATOR_WHERE,
          data: MODERATOR_DATA,
        })
      ).count
    : await prisma.groupMember.count({ where: MODERATOR_WHERE });

  const muted = apply
    ? (await prisma.groupMember.updateMany({ where: MUTED_WHERE, data: MUTED_DATA }))
        .count
    : await prisma.groupMember.count({ where: MUTED_WHERE });

  const banned = await prisma.groupMember.findMany({
    where: BANNED_WHERE,
    select: { id: true, bannedAt: true, bannedBy: true, updatedAt: true },
  });
  if (apply) {
    for (const row of banned) {
      await prisma.groupMember.updateMany({
        where: { id: row.id, ...BANNED_WHERE },
        data: bannedToKicked(row),
      });
    }
  }

  const closureModerators = apply
    ? (
        await prisma.groupClosureMember.updateMany({
          where: MODERATOR_WHERE,
          data: MODERATOR_DATA,
        })
      ).count
    : await prisma.groupClosureMember.count({ where: MODERATOR_WHERE });
  const closureBanned = apply
    ? (
        await prisma.groupClosureMember.updateMany({
          where: BANNED_WHERE,
          data: CLOSURE_BANNED_DATA,
        })
      ).count
    : await prisma.groupClosureMember.count({ where: BANNED_WHERE });

  logger.info(
    `migrate(group-leader-members)${tag}: MODERATOR→MEMBER ${String(moderators)}, mutes cleared ${String(muted)}, BANNED→KICKED ${String(banned.length)}; closure snapshots MODERATOR→MEMBER ${String(closureModerators)}, BANNED→KICKED ${String(closureBanned)}`
  );
}

if (process.argv[1]?.includes("migrate-group-leader-members")) {
  main()
    .catch((err) => {
      logger.error(`migrate(group-leader-members) failed: ${String(err)}`);
      process.exit(1);
    })
    .finally(() => void prisma.$disconnect());
}
