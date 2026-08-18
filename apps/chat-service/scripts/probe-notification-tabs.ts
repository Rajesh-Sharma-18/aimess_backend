/**
 * Manual probe: per-tab notification filtering + unread counts against the REAL
 * database, using the same `categoryWhere` fragments the REST endpoint uses.
 *
 * Checks the invariant the tabs depend on: the non-ALL buckets are DISJOINT and
 * sum to ALL, so a row is listed and counted in exactly one tab.
 *
 * Usage: pnpm --filter @aimess/chat-service exec tsx scripts/probe-notification-tabs.ts [userId]
 */
import path from "node:path";

import dotenv from "dotenv";

import { PrismaClient } from "../src/generated/prisma/index.js";
import {
  categorize,
  categoryWhere,
  type NotificationCategory,
} from "../src/lib/notification-category.js";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
if (!process.env.MONGO_DATABASE_URL) {
  const user = encodeURIComponent(process.env.MONGO_ROOT_USERNAME ?? "");
  const pass = encodeURIComponent(process.env.MONGO_ROOT_PASSWORD ?? "");
  const host = process.env.MONGO_HOST ?? "localhost";
  const port = process.env.MONGODB_PORT ?? "27017";
  const dbName = process.env.MONGO_DB_NAME ?? "aimess_chat";
  const authSource = process.env.MONGO_DATABASE ?? "admin";
  process.env.MONGO_DATABASE_URL =
    `mongodb://${user}:${pass}@${host}:${port}/${dbName}` +
    `?authSource=${authSource}&directConnection=true`;
}

const prisma = new PrismaClient();

const TABS: NotificationCategory[] = [
  "FRIENDS",
  "COMMUNITIES",
  "MENTIONS",
  "CALLS",
  "SYSTEM",
];

async function busiestUser(): Promise<string | null> {
  const rows = await prisma.notification.findMany({
    where: { isDeleted: false },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.userId, (counts.get(row.userId) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

async function main(): Promise<void> {
  const userId = process.argv[2] ?? (await busiestUser());
  if (!userId) {
    console.log("No notifications found.");
    return;
  }
  const base = { userId, isDeleted: false };

  console.log(`\nviewer=${userId}\n`);
  console.log("  tab           rows   unread");
  const all = await prisma.notification.count({ where: base });
  const allUnread = await prisma.notification.count({
    where: { ...base, isRead: false },
  });
  console.log(
    `  ${"ALL".padEnd(12)}  ${String(all).padStart(4)}   ${String(allUnread).padStart(4)}`
  );

  let sum = 0;
  let sumUnread = 0;
  for (const tab of TABS) {
    const where = { ...base, ...categoryWhere(tab) };
    const rows = await prisma.notification.count({ where });
    const unread = await prisma.notification.count({
      where: { ...where, isRead: false },
    });
    sum += rows;
    sumUnread += unread;
    console.log(
      `  ${tab.padEnd(12)}  ${String(rows).padStart(4)}   ${String(unread).padStart(4)}`
    );
  }
  console.log(
    `\n  buckets sum to ALL? rows ${String(sum === all)} (${String(sum)}/${String(all)}), ` +
      `unread ${String(sumUnread === allUnread)} (${String(sumUnread)}/${String(allUnread)})`
  );

  // The CALLS page itself: what the tab actually lists.
  const callRows = await prisma.notification.findMany({
    where: { ...base, ...categoryWhere("CALLS") },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  console.log(
    `\n--- CALLS tab, newest 10 of ${String(callRows.length)} shown ---`
  );
  for (const row of callRows) {
    const data =
      (row.payload as { data?: Record<string, unknown> } | null)?.data ?? {};
    console.log(
      `  ${row.type.padEnd(14)} ${String(data.callDirection ?? "").padEnd(9)} ` +
        `${String(data.callStatus ?? "").padEnd(10)} ${String(data.callType ?? "").padEnd(6)} ` +
        `read=${String(row.isRead)} ${row.createdAt.toISOString()}`
    );
  }

  // Nothing call-shaped may still be sitting in FRIENDS.
  const strays = await prisma.notification.count({
    where: { ...base, ...categoryWhere("FRIENDS") },
  });
  const friendRows = await prisma.notification.findMany({
    where: { ...base, ...categoryWhere("FRIENDS") },
    take: 200,
  });
  const misfiled = friendRows.filter((r) => categorize(r.type) !== "FRIENDS");
  console.log(
    `\n  FRIENDS rows=${String(strays)}, call-shaped strays in FRIENDS=${String(misfiled.length)}`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
