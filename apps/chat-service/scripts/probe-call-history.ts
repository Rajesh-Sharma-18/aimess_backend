/**
 * Manual probe: run the REAL CallHistoryService against the REAL database.
 *
 * Exercises the same repository query + aggregation the REST endpoint uses, so
 * grouping, filters and cursor paging can be verified against production-shaped
 * rows without a browser session. Identity is stubbed (that layer is gRPC and is
 * not what this probe is testing).
 *
 * Usage: pnpm --filter @aimess/chat-service exec tsx scripts/probe-call-history.ts [userId]
 * With no userId it picks the participant with the most call rows.
 */
import path from "node:path";

import dotenv from "dotenv";

import { PrismaClient } from "../src/generated/prisma/index.js";
import { CallRepository } from "../src/repositories/call.repository.js";
import {
  CallHistoryService,
  type CallHistoryContact,
} from "../src/services/call-history.service.js";
import { resolveCallDirection } from "@aimess/constants";

// Same composition prisma.config.ts does — the repo keeps the MONGO_* parts in
// the root .env rather than a ready-made URL.
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

const stubContacts = async (ids: string[]) =>
  new Map<string, CallHistoryContact>(
    ids.map((id) => [
      id,
      { id, name: id.slice(0, 8), avatarUrl: "", isDeleted: false },
    ])
  );

async function pickBusiestUser(): Promise<string | null> {
  const rows = await prisma.call.findMany({
    where: { groupId: null },
    orderBy: { initiatedAt: "desc" },
    take: 500,
  });
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const id of [row.callerId, row.calleeId]) {
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] ?? null;
}

async function main(): Promise<void> {
  const userId = process.argv[2] ?? (await pickBusiestUser());
  if (!userId) {
    console.log("No 1:1 call rows found.");
    return;
  }

  const repo = new CallRepository(prisma);
  const service = new CallHistoryService(repo, stubContacts);

  const raw = await prisma.call.findMany({
    where: {
      groupId: null,
      OR: [{ callerId: userId }, { calleeId: userId }],
    },
    orderBy: { initiatedAt: "desc" },
    take: 25,
  });

  console.log(`\nviewer=${userId}  (raw 1:1 rows, newest first)\n`);
  console.log("  status        answered  type   dir       initiatedAt");
  for (const row of raw) {
    console.log(
      `  ${row.status.padEnd(12)}  ${row.answeredAt ? "yes     " : "no      "}  ` +
        `${row.type.padEnd(5)}  ${resolveCallDirection(row, userId).padEnd(8)}  ` +
        `${row.initiatedAt.toISOString()}`
    );
  }

  for (const filter of ["all", "incoming", "outgoing", "missed"] as const) {
    const page = await service.getHistory({ userId, filter, limit: 20 });
    console.log(
      `\n--- filter=${filter}  (${page.items.length} rows, hasMore=${String(page.hasMore)}) ---`
    );
    for (const item of page.items) {
      const count = item.attemptCount > 1 ? ` (${item.attemptCount})` : "";
      console.log(
        `  ${item.contact.name}${count}`.padEnd(22) +
          `${item.direction.padEnd(9)} ${item.result.padEnd(10)} ` +
          `${item.callType.padEnd(6)} ${new Date(item.lastCallAt).toISOString()} ` +
          `latest=${item.latestCallId.slice(0, 8)}`
      );
    }
  }

  // Cursor paging: one group per page must reproduce the `all` list exactly,
  // with no duplicated and no dropped group.
  const whole = await service.getHistory({ userId, filter: "all", limit: 50 });
  const paged: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const page: Awaited<ReturnType<typeof service.getHistory>> =
      await service.getHistory({
        userId,
        filter: "all",
        limit: 1,
        cursor,
      });
    for (const item of page.items) {
      paged.push(`${item.latestCallId}:${String(item.attemptCount)}`);
    }
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const expected = whole.items.map(
    (i) => `${i.latestCallId}:${String(i.attemptCount)}`
  );
  const same =
    paged.length === expected.length &&
    paged.every((v, i) => v === expected[i]);
  console.log(
    `\n--- paging limit=1 vs limit=50 --- ${same ? "MATCH" : "MISMATCH"}`
  );
  if (!same) {
    console.log(`  limit=50: ${expected.join(" | ")}`);
    console.log(`  limit=1 : ${paged.join(" | ")}`);
  }
  console.log(
    `  groups: ${String(expected.length)}, duplicates: ${String(paged.length - new Set(paged).size)}`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
