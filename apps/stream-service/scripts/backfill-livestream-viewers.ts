/**
 * Builds the per-user `livestream_viewers` participation records from the
 * per-device `livestream_viewer_sessions` history, for sessions recorded before
 * participation tracking existed. Without it, those streams' admin viewer lists
 * are empty.
 *
 * Only creates records that are missing — a user who already has one (written
 * by the live path) is left alone. Overlapping sessions of the same user are
 * summed, so a legacy multi-device duration can read high.
 *
 * DRY RUN by default — pass `--apply` to write.
 *
 * Usage: pnpm --filter @aimess/stream-service db:backfill:livestream-viewers [--apply]
 */
import { prisma } from "../src/config/prisma.js";

const APPLY = process.argv.includes("--apply");

type Participation = {
  livestreamId: string;
  userId: string;
  activeSessions: number;
  joinedAt: Date;
  lastJoinedAt: Date | null;
  leftAt: Date | null;
  endReason: "LEFT" | "ENDED" | null;
  watchDurationSeconds: number;
  lastClosedAt: number;
};

async function main(): Promise<void> {
  const sessions = await prisma.livestreamViewerSession.findMany({
    select: {
      livestreamId: true,
      userId: true,
      joinedAt: true,
      leftAt: true,
      endReason: true,
      watchDurationSeconds: true,
    },
  });

  const endedAt = new Map(
    (
      await prisma.livestream.findMany({
        where: { endedAt: { not: null } },
        select: { id: true, endedAt: true },
      })
    ).map((l) => [l.id, l.endedAt?.getTime()])
  );

  const byUser = new Map<string, Participation>();
  for (const s of sessions) {
    const key = `${s.livestreamId}:${s.userId}`;
    const p = byUser.get(key) ?? {
      livestreamId: s.livestreamId,
      userId: s.userId,
      activeSessions: 0,
      joinedAt: s.joinedAt,
      lastJoinedAt: null,
      leftAt: null,
      endReason: null,
      watchDurationSeconds: 0,
      lastClosedAt: 0,
    };
    if (s.joinedAt < p.joinedAt) p.joinedAt = s.joinedAt;
    if (!s.leftAt) {
      p.activeSessions += 1;
      if (!p.lastJoinedAt || s.joinedAt < p.lastJoinedAt) {
        p.lastJoinedAt = s.joinedAt;
      }
    } else {
      p.watchDurationSeconds += s.watchDurationSeconds ?? 0;
      if (s.leftAt.getTime() > p.lastClosedAt) {
        p.lastClosedAt = s.leftAt.getTime();
        p.leftAt = s.leftAt;
        // ENDED only when the stream's end closed it — older sessions carry no
        // reason, but the end close-out stamped exactly the stream's endedAt.
        const streamEnd = endedAt.get(s.livestreamId);
        p.endReason =
          s.endReason === "STREAM_ENDED" ||
          (!s.endReason && streamEnd === s.leftAt.getTime())
            ? "ENDED"
            : "LEFT";
      }
    }
    byUser.set(key, p);
  }

  const existing = new Set(
    (
      await prisma.livestreamViewer.findMany({
        select: { livestreamId: true, userId: true },
      })
    ).map((v) => `${v.livestreamId}:${v.userId}`)
  );
  const missing = [...byUser.entries()].filter(([key]) => !existing.has(key));

  console.log(
    `${sessions.length} sessions → ${byUser.size} participations, ${missing.length} missing`
  );
  if (!APPLY || missing.length === 0) {
    if (!APPLY) console.log("Dry run — pass --apply to write.");
    return;
  }

  for (const [, p] of missing) {
    const active = p.activeSessions > 0;
    await prisma.livestreamViewer.create({
      data: {
        livestreamId: p.livestreamId,
        userId: p.userId,
        activeSessions: p.activeSessions,
        joinedAt: p.joinedAt,
        watchDurationSeconds: p.watchDurationSeconds,
        ...(active
          ? { lastJoinedAt: p.lastJoinedAt ?? p.joinedAt }
          : { leftAt: p.leftAt ?? p.joinedAt, endReason: p.endReason ?? "LEFT" }),
      },
    });
  }
  console.log(`Created ${missing.length} participation records.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
