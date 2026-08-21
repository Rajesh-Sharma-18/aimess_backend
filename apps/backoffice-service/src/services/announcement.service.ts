import { ConflictError, NotFoundError } from "@aimess/errors";

import { AUDIT_ACTIONS } from "../constants/index.js";
import { communityClient } from "../grpc/community.client.js";
import { enqueueAnnouncementDeliverySafe } from "../messaging/publish-announcement-delivery.js";
import { announcementRepository } from "../repositories/index.js";
import type {
  AnnouncementDetail,
  AnnouncementListItem,
  AnnouncementStatus,
  CreateAnnouncementInput,
  ListAnnouncementsQuery,
  Paginated,
  UpdateAnnouncementInput,
} from "../types/announcement.types.js";
import { auditService } from "./audit.service.js";

const DELIVERY_BATCH_LIMIT = 100;

export const announcementService = {
  async createAnnouncement(
    input: CreateAnnouncementInput,
    createdById: string
  ): Promise<AnnouncementDetail> {
    if (input.target === "COMMUNITY") {
      const community = await communityClient.adminGetCommunity(
        input.communityId as string
      );
      if (!community.found) {
        throw new NotFoundError("COMMUNITY_NOT_FOUND");
      }
    }

    // The validator already strips scheduledAt from an IMMEDIATE request and
    // requires it on a SCHEDULED one, so its presence is the single source of
    // truth here for both the new announcementType clients and the older ones.
    const status: AnnouncementStatus = input.scheduledAt
      ? "SCHEDULED"
      : "PROCESSING";
    const row = await announcementRepository.create(input, createdById, status);

    await auditService.record({
      actorId: createdById,
      action: AUDIT_ACTIONS.ANNOUNCEMENT_CREATED,
      targetType: "announcement",
      targetId: row.id,
      after: {
        title: row.title,
        target: row.target,
        deviceType: row.deviceType,
        communityId: row.communityId,
        status: row.status,
        scheduledAt: row.scheduledAt?.toISOString() ?? null,
      },
    });

    if (status === "PROCESSING") {
      enqueueAnnouncementDeliverySafe({
        announcementId: row.id,
        title: row.title,
        description: row.description,
        target: row.target,
        kind: row.kind,
        deviceType: row.deviceType,
        communityId: row.communityId,
        cursor: 0,
        limit: DELIVERY_BATCH_LIMIT,
        batchId: `ann:${row.id}:cursor:0`,
      });
    }

    const detail = await announcementRepository.getById(row.id);
    return detail as AnnouncementDetail;
  },

  /**
   * Edit a scheduled announcement. Rejected once the poller has claimed it
   * (PROCESSING) or it has already been sent/cancelled — the CAS in the
   * repository is the authority, so an admin editing at the exact moment the
   * cron claims the row loses the race deterministically instead of mutating
   * a send that is already fanning out.
   */
  async updateScheduledAnnouncement(
    id: string,
    input: UpdateAnnouncementInput,
    actorId: string
  ): Promise<AnnouncementDetail> {
    const before = await announcementRepository.getById(id);
    if (!before) throw new NotFoundError("ANNOUNCEMENT_NOT_FOUND");

    const updated = await announcementRepository.updateScheduled(id, input);
    if (!updated) throw new ConflictError("ANNOUNCEMENT_NOT_SCHEDULED");

    await auditService.record({
      actorId,
      action: AUDIT_ACTIONS.ANNOUNCEMENT_UPDATED,
      targetType: "announcement",
      targetId: id,
      before: {
        title: before.title,
        description: before.description,
        deviceType: before.deviceType,
        scheduledAt: before.scheduledAt
          ? new Date(before.scheduledAt).toISOString()
          : null,
      },
      after: {
        title: input.title,
        description: input.description,
        deviceType: input.deviceType,
        scheduledAt: input.scheduledAt,
      },
    });

    return (await announcementRepository.getById(id)) as AnnouncementDetail;
  },

  /** Cancel a scheduled announcement. Status-only — the row is kept for audit. */
  async cancelAnnouncement(
    id: string,
    actorId: string
  ): Promise<AnnouncementDetail> {
    const before = await announcementRepository.getById(id);
    if (!before) throw new NotFoundError("ANNOUNCEMENT_NOT_FOUND");

    const cancelled = await announcementRepository.cancelScheduled(id);
    if (!cancelled) throw new ConflictError("ANNOUNCEMENT_NOT_SCHEDULED");

    await auditService.record({
      actorId,
      action: AUDIT_ACTIONS.ANNOUNCEMENT_CANCELLED,
      targetType: "announcement",
      targetId: id,
      before: { status: before.status },
      after: { status: "CANCELLED" },
    });

    return (await announcementRepository.getById(id)) as AnnouncementDetail;
  },

  listAnnouncements(
    query: ListAnnouncementsQuery
  ): Promise<Paginated<AnnouncementListItem>> {
    return announcementRepository.list(query);
  },

  getAnnouncementDetails(id: string): Promise<AnnouncementDetail | null> {
    return announcementRepository.getById(id);
  },
};

export { DELIVERY_BATCH_LIMIT };
