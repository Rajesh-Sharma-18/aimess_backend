import { NotFoundError } from "@aimess/errors";

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
        communityId: row.communityId,
        cursor: 0,
        limit: DELIVERY_BATCH_LIMIT,
        batchId: `ann:${row.id}:cursor:0`,
      });
    }

    const detail = await announcementRepository.getById(row.id);
    return detail as AnnouncementDetail;
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
