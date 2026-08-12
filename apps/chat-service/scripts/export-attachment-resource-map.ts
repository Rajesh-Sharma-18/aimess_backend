/**
 * Step 1 of the AUDIT-112 backfill: emit the `objectKey -> resourceId` mapping
 * for every group/community chat attachment chat-service knows about.
 *
 * Download authorization for those two categories is membership-based, and the
 * ONLY thing that can answer "may this user fetch this file" is the media
 * registry's `resourceId` — the object key is `{prefix}/{ownerId}/{fileId}.{ext}`
 * and carries the uploader, not the room. Rows written before `resourceId`
 * became mandatory have none, so they are now downloadable by their uploader
 * only. This recovers the missing value from the message that carries the key.
 *
 * Two steps because the data lives in two databases: chat-service owns the
 * messages, media-service owns the registry. This one only READS and writes a
 * JSON file; `apply-attachment-resource-map.ts` in media-service consumes it.
 *
 * Private chat (`CHAT_ATTACHMENT`) is deliberately excluded: its legacy rule was
 * already an owner check, so nothing regressed there and there is nothing to
 * recover.
 *
 *   pnpm --filter @aimess/chat-service export:attachment-resource-map
 *   # → apps/chat-service/attachment-resource-map.json
 */
import { writeFileSync } from "node:fs";

import { logger } from "@aimess/logger";

import { prisma } from "../src/config/prisma.js";

const OUT = process.argv[2] ?? "attachment-resource-map.json";
const PAGE = 1000;

/** The prefixes whose downloads are membership-gated (see media config/uploads.ts). */
const MEMBERSHIP_PREFIXES = ["group-chat-uploads/", "community-chat-uploads/"];

function keysFrom(content: unknown): string[] {
  const files = (content as { files?: unknown[] } | null)?.files;
  if (!Array.isArray(files)) return [];
  return files
    .map((f) => {
      const file = f as { objectKey?: unknown; url?: unknown };
      return typeof file.objectKey === "string"
        ? file.objectKey
        : typeof file.url === "string"
          ? file.url
          : "";
    })
    .filter((k) => MEMBERSHIP_PREFIXES.some((p) => k.startsWith(p)));
}

/**
 * Page a message collection and collect every membership-scoped attachment key
 * against the room it was posted in. Later rows win on a duplicate key, which
 * cannot happen in practice — a key is minted per upload.
 */
async function collect(
  label: string,
  fetchPage: (
    skip: number
  ) => Promise<Array<{ roomId: string; content: unknown }>>,
  into: Record<string, string>
): Promise<void> {
  let skip = 0;
  let found = 0;
  for (;;) {
    const rows = await fetchPage(skip);
    if (rows.length === 0) break;
    for (const row of rows) {
      for (const key of keysFrom(row.content)) {
        into[key] = row.roomId;
        found++;
      }
    }
    skip += rows.length;
    if (rows.length < PAGE) break;
  }
  logger.info(
    `export(resource-map): ${label} — ${String(found)} attachment(s)`
  );
}

async function exportMap(): Promise<void> {
  const map: Record<string, string> = {};

  await collect(
    "group",
    (skip) =>
      prisma.groupMessage.findMany({
        select: { roomId: true, content: true },
        orderBy: { id: "asc" },
        skip,
        take: PAGE,
      }),
    map
  );

  await collect(
    "community",
    (skip) =>
      prisma.generalRoomMessage.findMany({
        select: { roomId: true, content: true },
        orderBy: { id: "asc" },
        skip,
        take: PAGE,
      }),
    map
  );

  writeFileSync(OUT, JSON.stringify(map, null, 2), "utf8");
  logger.info(
    `export(resource-map): wrote ${String(Object.keys(map).length)} unique key(s) to ${OUT}`
  );
}

exportMap()
  .catch((err) => {
    logger.error(`export(resource-map) failed: ${String(err)}`);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
