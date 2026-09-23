/**
 * One-off backfill: group SYSTEM rows written by a BACKOFFICE (platform-admin)
 * moderation action before the acting admin's name travelled with the gRPC call.
 *
 * Those rows were persisted with `actorId: null` AND `actorName: ""`, so every
 * member reads them as "Someone removed X" / "Someone banned X" forever — the
 * sentence is rebuilt from `systemData` on every read, so there is nothing to
 * re-resolve at render time. The acting admin's id IS still recoverable from the
 * membership row (`GroupMember.kickedBy` / `bannedBy`), but it belongs to
 * admin_db, which chat-service cannot read — so the id → name mapping must be
 * supplied by the operator, taken from the admin panel.
 *
 * SAFETY — nothing is guessed:
 *   - only rows that are BOTH actor-less (`actorId` null/absent) and nameless
 *     (`actorName` empty) are candidates; an in-group removal is never touched;
 *   - the actor id comes from the target's own membership row, not from the
 *     roster or the room;
 *   - an id absent from the supplied map is COUNTED AND SKIPPED, never filled
 *     with a placeholder — "Someone" is still the honest answer for an actor
 *     nobody can name;
 *   - `actorId` stays null. The admin is not a chat user: naming them must not
 *     make them "the actor" (no "You removed X", no profile link to a non-user).
 *
 * `content.text` is rewritten from the repaired `systemData` through the same
 * builder the live write path uses, so the stored English and the per-viewer
 * re-render can't disagree.
 *
 * Idempotent: a repaired row no longer matches the nameless filter.
 *
 * Usage (dry run prints the plan and changes nothing):
 *   pnpm --filter @aimess/chat-service exec tsx \
 *     scripts/backfill-platform-actor-names.ts \
 *     --actor 8038683b-ca52-4577-8a5b-785b9bbd2414="Super Admin"
 *   …same command plus --apply to write.
 */
import { buildGroupSystemFallbackText } from "@aimess/constants";

import { prisma } from "../src/config/prisma.js";

/** Events a platform admin can post actor-less. Nothing else is swept. */
const PLATFORM_EVENTS = [
  "MEMBER_REMOVED",
  "MEMBER_BANNED",
  "MEMBER_UNBANNED",
] as const;

/** `--actor <uuid>=<display name>` (repeatable) → map. `--apply` → write. */
function parseArgs(argv: string[]): {
  actors: Map<string, string>;
  apply: boolean;
} {
  const actors = new Map<string, string>();
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg !== "--actor") continue;
    const pair = argv[++i] ?? "";
    const split = pair.indexOf("=");
    if (split <= 0) continue;
    const id = pair.slice(0, split).trim();
    const name = pair.slice(split + 1).trim();
    if (id && name) actors.set(id, name);
  }
  return { actors, apply };
}

async function main(): Promise<void> {
  const { actors, apply } = parseArgs(process.argv.slice(2));
  if (actors.size === 0) {
    console.error(
      'No --actor <id>="<name>" pairs given; nothing can be resolved. Aborting.'
    );
    process.exitCode = 1;
    return;
  }

  const rows = await prisma.groupMessage.findMany({
    where: {
      systemEvent: { in: [...PLATFORM_EVENTS] },
      isDeleted: false,
    },
    select: {
      id: true,
      roomId: true,
      systemEvent: true,
      systemData: true,
      content: true,
    },
  });

  let repaired = 0;
  let unresolved = 0;
  let skipped = 0;

  for (const row of rows) {
    const systemData = (row.systemData ?? {}) as Record<string, unknown>;
    const hasActorId = Boolean(String(systemData.actorId ?? "").trim());
    const hasActorName = Boolean(String(systemData.actorName ?? "").trim());
    // Anything already attributable — an in-group actor, or a row a previous run
    // repaired — is left exactly as it is.
    if (hasActorId || hasActorName) {
      skipped++;
      continue;
    }

    const targetUserId = String(systemData.targetUserId ?? "").trim();
    if (!targetUserId) {
      unresolved++;
      continue;
    }

    // The membership row is the only surviving record of WHO acted.
    const member = await prisma.groupMember.findFirst({
      where: { roomId: row.roomId, userId: targetUserId },
      select: { kickedBy: true, bannedBy: true },
    });
    const adminId = String(member?.kickedBy ?? member?.bannedBy ?? "").trim();
    const actorName = adminId ? actors.get(adminId) : undefined;
    if (!actorName) {
      unresolved++;
      continue;
    }

    const nextSystemData = { ...systemData, actorName };
    const text = buildGroupSystemFallbackText(
      row.systemEvent ?? "",
      nextSystemData
    );
    const content = (row.content ?? {}) as Record<string, unknown>;

    console.log(
      `${apply ? "repair" : "would repair"} ${row.id} (${row.systemEvent}) → "${text}"`
    );
    if (apply) {
      await prisma.groupMessage.update({
        where: { id: row.id },
        data: { systemData: nextSystemData, content: { ...content, text } },
      });
    }
    repaired++;
  }

  console.log(
    `\n${apply ? "Repaired" : "Would repair"} ${repaired}; unresolved ${unresolved}; already attributed ${skipped}.`
  );
  if (!apply) console.log("Dry run — re-run with --apply to write.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
