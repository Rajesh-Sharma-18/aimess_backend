/**
 * One-off cleanup: before one-row-per-session, a livestream wrote TWO inbox rows
 * per recipient — `livestream:<id>:community.livestream_started` and
 * `livestream:<id>:community.livestream_ended`. This folds them into the single
 * row the current code keeps, `livestream:<id>`:
 *
 *  - the keeper is the oldest row of the (user, stream) pair, so the row stays
 *    where the user first saw it and keeps its read state (an end never
 *    re-badges, same as live);
 *  - when the pair has an ended row, the keeper takes on its type, payload,
 *    actor and entity — the final state is always "ended";
 *  - every other row of the pair is soft-deleted (`isDeleted`, version bump), so
 *    delta sync hands clients a tombstone and they drop it;
 *  - a lone legacy-keyed row is only re-keyed.
 *
 * DRY-RUN by default: reads only and prints counts. Pass `--apply` to write.
 * Idempotent: a re-run finds nothing left to merge.
 *
 * Usage: pnpm --filter @aimess/chat-service exec tsx scripts/merge-livestream-notification-rows.ts [--apply]
 */
import { prisma } from "../src/config/prisma.js";

const APPLY = process.argv.includes("--apply");
const ENDED = "community.livestream_ended";
const KEY = /^livestream:([^:]+)(?::.*)?$/;

type Row = {
  id: string;
  userId: string;
  type: string;
  groupKey: string | null;
  payload: unknown;
  actorId: string;
  actorSnapshot: unknown;
  entity: unknown;
  createdAt: Date;
};

async function main(): Promise<void> {
  const rows = (await prisma.notification.findMany({
    where: { isDeleted: false, groupKey: { startsWith: "livestream:" } },
    select: {
      id: true,
      userId: true,
      type: true,
      groupKey: true,
      payload: true,
      actorId: true,
      actorSnapshot: true,
      entity: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  })) as Row[];

  const pairs = new Map<string, Row[]>();
  for (const row of rows) {
    const streamId = KEY.exec(row.groupKey ?? "")?.[1];
    if (!streamId) continue;
    const k = `${row.userId}|${streamId}`;
    pairs.set(k, [...(pairs.get(k) ?? []), row]);
  }

  let merged = 0;
  let rekeyed = 0;
  let deleted = 0;
  for (const [k, group] of pairs) {
    const groupKey = `livestream:${k.split("|")[1]}`;
    const [keeper, ...rest] = group;
    const ended = [...group].reverse().find((r) => r.type === ENDED);
    if (rest.length === 0 && keeper.groupKey === groupKey) continue;

    if (rest.length > 0) merged++;
    else rekeyed++;
    deleted += rest.length;
    if (!APPLY) continue;

    await prisma.notification.update({
      where: { id: keeper.id },
      data: {
        groupKey,
        version: { increment: 1 },
        ...(ended && ended.id !== keeper.id
          ? {
              type: ended.type,
              payload: ended.payload as object,
              actorId: ended.actorId,
              actorSnapshot: ended.actorSnapshot as object,
              entity: ended.entity as object,
            }
          : {}),
      },
    });
    if (rest.length > 0) {
      await prisma.notification.updateMany({
        where: { id: { in: rest.map((r) => r.id) } },
        data: {
          isDeleted: true,
          deletedAt: new Date(),
          version: { increment: 1 },
        },
      });
    }
  }

  console.log(
    `${APPLY ? "APPLIED" : "DRY-RUN"}: ${rows.length} livestream row(s) scanned, ` +
      `${pairs.size} (user, stream) pair(s); ` +
      `${merged} pair(s) merged, ${deleted} duplicate row(s) ${APPLY ? "deleted" : "to delete"}, ` +
      `${rekeyed} lone row(s) ${APPLY ? "re-keyed" : "to re-key"}.`
  );
}

main()
  .catch((err) => {
    console.error("Merge failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
