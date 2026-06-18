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

import type { MediaFile } from "../generated/prisma/index.js";
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

  /** Persist a terminal/interim scan verdict (durable, survives Redis TTL). */
  async setScanStatus(
    objectKey: string,
    scanStatus: MediaScanStatus,
    scanDetail?: string | null
  ): Promise<void> {
    await prisma.mediaFile.updateMany({
      where: { objectKey },
      data: {
        scanStatus,
        scanDetail: scanDetail ?? null,
        scannedAt: new Date(),
      },
    });
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
