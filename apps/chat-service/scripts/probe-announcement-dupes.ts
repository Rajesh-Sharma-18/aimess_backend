/**
 * Read-only diagnostic: are there duplicate Notification rows for one
 * Super-Admin announcement? Groups every ANNOUNCEMENT/MAINTENANCE/
 * UPDATE_REQUIRED row of the last N days by (userId, announcementId) and
 * prints any pair with more than one row, plus the unread totals per user.
 *
 *   pnpm --filter @aimess/chat-service exec tsx scripts/probe-announcement-dupes.ts
 */
import { prisma } from "../src/config/prisma.js";

const DAYS = Number(process.argv[2] ?? 14);

async function main(): Promise<void> {
  const since = new Date(Date.now() - DAYS * 86_400_000);
  const rows = await prisma.notification.findMany({
    where: {
      type: { in: ["ANNOUNCEMENT", "MAINTENANCE", "UPDATE_REQUIRED"] },
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`ANNOUNCEMENT-ish rows in last ${DAYS}d: ${rows.length}`);

  const byPair = new Map<string, typeof rows>();
  for (const r of rows) {
    const payload = (r.payload ?? {}) as { data?: Record<string, string> };
    const annId = payload.data?.announcementId ?? "(none)";
    const key = `${r.userId}|${annId}`;
    const list = byPair.get(key) ?? [];
    list.push(r);
    byPair.set(key, list);
  }

  let dupes = 0;
  for (const [key, list] of byPair) {
    if (list.length > 1) {
      dupes++;
      console.log(
        `DUPE ${key} count=${list.length} ids=${list.map((r) => r.id).join(",")} createdAt=${list
          .map((r) => r.createdAt.toISOString())
          .join(",")} isRead=${list.map((r) => String(r.isRead)).join(",")}`
      );
    }
  }
  console.log(`(userId,announcementId) pairs=${byPair.size} duplicated=${dupes}`);

  // Announcement ids seen, newest first, with recipient counts.
  const byAnn = new Map<string, Set<string>>();
  for (const r of rows) {
    const payload = (r.payload ?? {}) as { data?: Record<string, string> };
    const annId = payload.data?.announcementId ?? "(none)";
    const set = byAnn.get(annId) ?? new Set<string>();
    set.add(r.userId);
    byAnn.set(annId, set);
  }
  console.log("\nper announcement: rows / distinct recipients");
  for (const [annId, users] of byAnn) {
    const rowCount = rows.filter((r) => {
      const p = (r.payload ?? {}) as { data?: Record<string, string> };
      return (p.data?.announcementId ?? "(none)") === annId;
    }).length;
    console.log(`  ${annId}: rows=${rowCount} recipients=${users.size}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
