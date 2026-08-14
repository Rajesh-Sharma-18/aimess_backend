/**
 * MediaFile registry repository — the only module that touches the media_db
 * `media_files` collection. Keyed by the unique storage objectKey.
 *
 * Inputs are typed against the shared @aimess/constants classification enums so
 * a caller cannot persist an out-of-vocabulary owner/resource/scan value.
 */
import type {
  MediaOwnerType,
  MediaResourceType,
  MediaScanStatus,
  MediaUsageStatus,
} from "@aimess/constants";

import type { MediaFile, Prisma } from "../generated/prisma/index.js";
import { prisma } from "../config/prisma.js";

export interface RegisterMediaInput {
  objectKey: string;
  bucket: string;
  uploadCategory: string;
  ownerType: MediaOwnerType;
  resourceType: MediaResourceType;
  ownerId: string;
  resourceId?: string | null;
  fileName?: string | null;
  contentType: string;
  size?: number | null;
  scanStatus?: MediaScanStatus;
}

export const mediaFileRepository = {
  /**
   * Idempotent registry write. Confirm may be retried (or auto-confirm may race
   * a manual confirm), so this upserts on the unique objectKey rather than
   * insert. The immutable storage identity (objectKey) is never updated.
   */
  async register(input: RegisterMediaInput): Promise<MediaFile> {
    const fields = {
      bucket: input.bucket,
      uploadCategory: input.uploadCategory,
      ownerType: input.ownerType,
      resourceType: input.resourceType,
      ownerId: input.ownerId,
      resourceId: input.resourceId ?? null,
      fileName: input.fileName ?? null,
      contentType: input.contentType,
      size: input.size ?? null,
      scanStatus: input.scanStatus ?? "PENDING",
    };
    return prisma.mediaFile.upsert({
      where: { objectKey: input.objectKey },
      create: { objectKey: input.objectKey, ...fields },
      update: fields,
    });
  },

  /** Lookup for download authorization (resourceType + resourceId binding). */
  async findByObjectKey(objectKey: string): Promise<MediaFile | null> {
    return prisma.mediaFile.findUnique({ where: { objectKey } });
  },

  /**
   * Batch lookup, for callers that must check many keys at once — the
   * message-send gate in chat-service verifies every attachment on a message in
   * a single round trip rather than one call per file.
   */
  async findByObjectKeys(objectKeys: string[]): Promise<MediaFile[]> {
    if (objectKeys.length === 0) return [];
    return prisma.mediaFile.findMany({
      where: { objectKey: { in: objectKeys } },
    });
  },

  /**
   * Persist a terminal/interim scan verdict (durable, survives Redis TTL).
   *
   * This is the durable half of the verdict; Redis holds the hot copy under
   * `SCAN_STATUS_TTL_SECONDS`. The download gate reads Redis first and falls
   * back here, so an expired or flushed cache no longer loses the fact that an
   * object was rejected (and no longer stampedes the scanner re-validating the
   * entire corpus).
   */
  async setScanStatus(
    objectKey: string,
    scanStatus: MediaScanStatus,
    scanDetail?: string | null,
    fileHash?: string | null
  ): Promise<void> {
    await prisma.mediaFile.updateMany({
      where: { objectKey },
      data: {
        scanStatus,
        scanDetail: scanDetail ?? null,
        scannedAt: new Date(),
        ...(fileHash ? { fileHash } : {}),
      },
    });
  },

  /** Record the real, MinIO-reported size once it is known (at confirm time). */
  async setVerifiedSize(objectKey: string, size: number): Promise<void> {
    await prisma.mediaFile.updateMany({
      where: { objectKey },
      data: { size },
    });
  },

  /**
   * Sum verified upload bytes for one user in a time window, grouped by the raw
   * MIME type. Backs GET /media/usage/me.
   *
   * Grouped by `contentType` (~30 distinct MIMEs) rather than by a derived
   * VIDEO/IMAGE/AUDIO/DOCUMENT bucket, so the MIME→kind mapping stays in
   * `contentTypeFromMime` (@aimess/constants) instead of being re-typed as a
   * `$switch` of `$regexMatch` stages that would then drift from it.
   *
   * `scannedAt: { $ne: null }` is load-bearing: it is the only signal that
   * separates "bytes actually landed in MinIO and were HEAD-verified" from "a
   * presigned URL was minted and the client never PUT anything". Rows in the
   * latter state stay PENDING forever — there is no orphan sweep — so without
   * this filter an abandoned upload dialog inflates the meter.
   */
  async sumVerifiedBytesByMime(
    ownerId: string,
    since: Date
  ): Promise<Array<{ contentType: string; bytes: number }>> {
    const rows = (await prisma.mediaFile.aggregateRaw({
      pipeline: [
        {
          $match: {
            ownerId,
            createdAt: { $gte: { $date: since.toISOString() } },
            scannedAt: { $ne: null },
            size: { $gt: 0 },
          },
        },
        { $group: { _id: "$contentType", bytes: { $sum: "$size" } } },
      ] as unknown as Prisma.InputJsonValue[],
    })) as unknown as Array<{ _id: string | null; bytes: number }>;

    return rows.map((row) => ({
      contentType: row._id ?? "",
      bytes: row.bytes ?? 0,
    }));
  },

  /** Lifecycle transition (ACTIVE -> UNUSED on dereference, -> DELETED on purge). */
  async setUsage(
    objectKey: string,
    usageStatus: MediaUsageStatus
  ): Promise<void> {
    await prisma.mediaFile.updateMany({
      where: { objectKey },
      data: {
        usageStatus,
        ...(usageStatus === "UNUSED" ? { unusedAt: new Date() } : {}),
        ...(usageStatus === "DELETED" ? { deletedAt: new Date() } : {}),
      },
    });
  },
};
