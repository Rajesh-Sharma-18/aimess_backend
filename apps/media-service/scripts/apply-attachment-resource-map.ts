/**
 * Step 2 of the AUDIT-112 backfill: stamp `resourceId` onto registry rows that
 * were written without one.
 *
 * Download authorization for `COMMUNITY_CHAT_ATTACHMENT` and
 * `GROUP_CHAT_ATTACHMENT` used to fall back to a check that only asserted the
 * object key started with the category prefix — something every key in the
 * category satisfies — so any authenticated caller who learned a key got a
 * presigned URL. That fallback now allows the UPLOADER only, because the key
 * (`{prefix}/{ownerId}/{fileId}.{ext}`) carries no room to check membership
 * against. Until `resourceId` is filled in, the other members of the room can't
 * fetch attachments they legitimately should.
 *
 * Input is the JSON map produced by chat-service's
 * `export:attachment-resource-map` (the two services have separate databases,
 * which is why this is two steps).
 *
 * Only fills rows where `resourceId` is missing — never overwrites a value the
 * upload path recorded. Safe to re-run.
 *
 * Dry run (default, writes nothing):
 *   pnpm --filter @aimess/media-service migrate:attachment-resource-map ./attachment-resource-map.json
 * Apply:
 *   pnpm --filter @aimess/media-service migrate:attachment-resource-map ./attachment-resource-map.json -- --apply
 */
import { readFileSync } from "node:fs";

import { logger } from "@aimess/logger";

import { prisma } from "../src/config/prisma.js";

const APPLY = process.argv.includes("--apply");
const INPUT =
  process.argv.slice(2).find((a) => !a.startsWith("--")) ??
  "attachment-resource-map.json";

const CATEGORIES = ["COMMUNITY_CHAT_ATTACHMENT", "GROUP_CHAT_ATTACHMENT"];

async function applyMap(): Promise<void> {
  const map = JSON.parse(readFileSync(INPUT, "utf8")) as Record<string, string>;
  logger.info(
    `migrate(resource-map): ${String(Object.keys(map).length)} key(s) from ${INPUT}${
      APPLY ? "" : " — DRY RUN, pass --apply to write"
    }`
  );

  const orphaned = await prisma.mediaFile.findMany({
    where: {
      uploadCategory: { in: CATEGORIES },
      OR: [{ resourceId: null }, { resourceId: "" }],
    },
    select: { id: true, objectKey: true },
  });

  logger.info(
    `migrate(resource-map): ${String(orphaned.length)} registry row(s) with no resourceId`
  );

  let filled = 0;
  const unmatched: string[] = [];

  for (const row of orphaned) {
    const resourceId = map[row.objectKey];
    if (!resourceId) {
      unmatched.push(row.objectKey);
      continue;
    }
    filled++;
    if (APPLY) {
      await prisma.mediaFile.update({
        where: { id: row.id },
        data: { resourceId },
      });
    }
  }

  logger.info(
    `migrate(resource-map): ${APPLY ? "filled" : "would fill"} ${String(filled)}; ` +
      `${String(unmatched.length)} still unmatched`
  );

  if (unmatched.length > 0) {
    // An unmatched row is an object no message references — an abandoned upload,
    // or one whose message was hard-deleted. It stays uploader-only, which is
    // correct: there is no room to grant access to. Listed so the count can be
    // sanity-checked rather than silently written off.
    logger.warn(
      `migrate(resource-map): unmatched sample — ${unmatched.slice(0, 10).join(", ")}`
    );
  }
}

applyMap()
  .catch((err) => {
    logger.error(`migrate(resource-map) failed: ${String(err)}`);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
