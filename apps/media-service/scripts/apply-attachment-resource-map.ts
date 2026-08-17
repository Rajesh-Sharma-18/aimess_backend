/**
 * Step 2 of the AUDIT-112 backfill: bind group/community chat attachments to the
 * room they were posted in, so members other than the uploader can fetch them.
 *
 * Download authorization for `COMMUNITY_CHAT_ATTACHMENT` and
 * `GROUP_CHAT_ATTACHMENT` used to fall back to a check that only asserted the
 * object key started with the category prefix — something every key in the
 * category satisfies — so any authenticated caller who learned a key got a
 * presigned URL. That fallback now allows the UPLOADER only, because the key
 * (`{prefix}/{ownerId}/{fileId}.{ext}`) carries no room to check membership
 * against. Until the registry knows the `resourceId`, the other members of the
 * room can't fetch attachments they legitimately should.
 *
 * Two classes of object need fixing, and only the first used to be handled:
 *   1. A registry row exists with a null/empty `resourceId` — stamp it.
 *   2. NO registry row exists at all — the object predates the registry. The
 *      download guard falls into the same uploader-only fallback, so these must
 *      be REGISTERED, not skipped. They are created with `scanStatus: PENDING`
 *      and no `scannedAt`, which the download path treats as "unknown" and
 *      settles by running the full validation pipeline on first fetch — the
 *      same auto-confirm an unregistered object already got.
 *
 * Input is the JSON map produced by chat-service's
 * `export:attachment-resource-map` (the two services have separate databases,
 * which is why this is two steps).
 *
 * Never overwrites a `resourceId` the upload path recorded. Safe to re-run.
 *
 * Dry run (default, writes nothing):
 *   pnpm --filter @aimess/media-service migrate:attachment-resource-map ./attachment-resource-map.json
 * Apply:
 *   pnpm --filter @aimess/media-service migrate:attachment-resource-map ./attachment-resource-map.json -- --apply
 */
import { readFileSync } from "node:fs";

import { logger } from "@aimess/logger";

import { prisma } from "../src/config/prisma.js";
import { mediaFileRepository } from "../src/repositories/media-file.repository.js";
import {
  resolveResourceType,
  ownerTypeForResource,
} from "../src/lib/resource-type.js";
import {
  UPLOAD_CATEGORIES,
  type MediaCategoryKey,
} from "../src/config/uploads.js";

const APPLY = process.argv.includes("--apply");
const INPUT =
  process.argv.slice(2).find((a) => !a.startsWith("--")) ??
  "attachment-resource-map.json";

const CATEGORIES: MediaCategoryKey[] = [
  "COMMUNITY_CHAT_ATTACHMENT",
  "GROUP_CHAT_ATTACHMENT",
];

/** Map value. The old export wrote a bare resourceId string; both are accepted. */
interface AttachmentRef {
  resourceId: string;
  mime?: string | null;
  fileName?: string | null;
  size?: number | null;
}

function normalize(value: unknown): AttachmentRef | null {
  if (typeof value === "string") return value ? { resourceId: value } : null;
  const ref = value as AttachmentRef | null;
  return ref?.resourceId ? ref : null;
}

/** Which category a key belongs to, from its storage prefix. */
function categoryOf(objectKey: string): MediaCategoryKey | null {
  return (
    CATEGORIES.find((c) =>
      objectKey.startsWith(UPLOAD_CATEGORIES[c].keyPrefix + "/")
    ) ?? null
  );
}

/** `{prefix}/{ownerId}/{fileId}.{ext}` — the uploader is the second segment. */
function ownerIdOf(objectKey: string, category: MediaCategoryKey): string {
  return (
    objectKey
      .slice(UPLOAD_CATEGORIES[category].keyPrefix.length + 1)
      .split("/")[0] ?? ""
  );
}

async function applyMap(): Promise<void> {
  const raw = JSON.parse(readFileSync(INPUT, "utf8")) as Record<
    string,
    unknown
  >;
  const map = new Map<string, AttachmentRef>();
  for (const [key, value] of Object.entries(raw)) {
    const ref = normalize(value);
    if (ref) map.set(key, ref);
  }

  logger.info(
    `migrate(resource-map): ${String(map.size)} key(s) from ${INPUT}${
      APPLY ? "" : " — DRY RUN, pass --apply to write"
    }`
  );

  const existing = await prisma.mediaFile.findMany({
    where: { objectKey: { in: [...map.keys()] } },
    select: { id: true, objectKey: true, resourceId: true },
  });
  const byKey = new Map(existing.map((r) => [r.objectKey, r]));

  let filled = 0;
  let created = 0;
  let alreadyBound = 0;
  const skipped: string[] = [];

  for (const [objectKey, ref] of map) {
    const row = byKey.get(objectKey);

    if (row) {
      if (row.resourceId) {
        alreadyBound++;
        continue;
      }
      filled++;
      if (APPLY) {
        await prisma.mediaFile.update({
          where: { id: row.id },
          data: { resourceId: ref.resourceId },
        });
      }
      continue;
    }

    // No registry row: the object predates the registry. Register it now, or the
    // download guard keeps falling back to uploader-only for everyone else.
    const category = categoryOf(objectKey);
    const ownerId = category ? ownerIdOf(objectKey, category) : "";
    if (!category || !ownerId) {
      skipped.push(objectKey);
      continue;
    }

    const contentType = ref.mime ?? "application/octet-stream";
    const resourceType = resolveResourceType(category, contentType);
    created++;
    if (APPLY) {
      await mediaFileRepository.register({
        objectKey,
        bucket: UPLOAD_CATEGORIES[category].bucket,
        uploadCategory: category,
        ownerType: ownerTypeForResource(resourceType),
        resourceType,
        ownerId,
        resourceId: ref.resourceId,
        fileName: ref.fileName ?? null,
        contentType,
        size: ref.size ?? null,
        scanStatus: "PENDING",
      });
    }
  }

  // Rows with no resourceId that the map could not explain at all — an object no
  // message references (abandoned upload, or its message was hard-deleted). It
  // stays uploader-only, which is correct: there is no room to grant access to.
  const unmatched = await prisma.mediaFile.count({
    where: {
      uploadCategory: { in: CATEGORIES },
      OR: [{ resourceId: null }, { resourceId: "" }],
      objectKey: { notIn: [...map.keys()] },
    },
  });

  logger.info(
    `migrate(resource-map): ${APPLY ? "filled" : "would fill"} ${String(filled)}, ` +
      `${APPLY ? "registered" : "would register"} ${String(created)}; ` +
      `${String(alreadyBound)} already bound; ${String(unmatched)} orphan row(s) left uploader-only`
  );

  if (skipped.length > 0) {
    logger.warn(
      `migrate(resource-map): ${String(skipped.length)} key(s) skipped — unrecognized prefix/owner: ` +
        skipped.slice(0, 10).join(", ")
    );
  }
}

applyMap()
  .catch((err) => {
    logger.error(`migrate(resource-map) failed: ${String(err)}`);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
