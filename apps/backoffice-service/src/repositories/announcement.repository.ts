import { prisma } from "../config/prisma.js";
import type {
  Announcement,
  AnnouncementStatus,
  AnnouncementTarget,
  Prisma,
} from "../generated/prisma/client.js";
import type {
  AnnouncementDetail,
  AnnouncementListItem,
  CreateAnnouncementInput,
  ListAnnouncementsQuery,
  Paginated,
  PaginationMeta,
} from "../types/announcement.types.js";

type SortField = "createdAt" | "scheduledAt" | "sentAt" | "title";

function parseSort(sort: string): { field: SortField; dir: "asc" | "desc" } {
  const [field, dir] = sort.split(":") as [SortField, "asc" | "desc"];
  return { field, dir };
}

function toDetail(row: Announcement): AnnouncementDetail {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    target: row.target,
    kind: row.kind,
    communityId: row.communityId,
    status: row.status,
    scheduledAt: row.scheduledAt ? row.scheduledAt.toISOString() : null,
    recipientCount: row.recipientCount,
    failureReason: row.failureReason,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
  };
}

function toListItem(row: Announcement): AnnouncementListItem {
  return {
    id: row.id,
    title: row.title,
    target: row.target,
    communityId: row.communityId,
    recipientCount: row.recipientCount,
    status: row.status,
    announcedAt: (row.sentAt ?? row.createdAt).toISOString(),
  };
}

export const announcementRepository = {
  create(
    input: CreateAnnouncementInput,
    createdById: string,
    status: AnnouncementStatus
  ): Promise<Announcement> {
    return prisma.announcement.create({
      data: {
        title: input.title,
        description: input.description,
        target: input.target,
        kind: input.kind,
        communityId: input.communityId ?? null,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
        status,
        createdById,
      },
    });
  },

  async list(
    query: ListAnnouncementsQuery
  ): Promise<Paginated<AnnouncementListItem>> {
    const { field, dir } = parseSort(query.sort);
    const where: Prisma.AnnouncementWhereInput = {};

    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: "insensitive" } },
        { description: { contains: query.search, mode: "insensitive" } },
      ];
    }
    if (query.target) where.target = query.target;
    if (query.status && query.status.length > 0) {
      where.status = { in: query.status };
    }
    if (query.dateFrom || query.dateTo) {
      where.createdAt = {
        ...(query.dateFrom
          ? { gte: new Date(`${query.dateFrom}T00:00:00.000Z`) }
          : {}),
        ...(query.dateTo
          ? { lte: new Date(`${query.dateTo}T23:59:59.999Z`) }
          : {}),
      };
    }

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
      prisma.announcement.findMany({
        where,
        orderBy: { [field]: dir },
        skip,
        take: query.limit,
      }),
      prisma.announcement.count({ where }),
    ]);

    const totalPages = total === 0 ? 0 : Math.ceil(total / query.limit);
    const pagination: PaginationMeta = {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
      hasNext: skip + query.limit < total,
      hasPrev: query.page > 1,
    };
    return { data: rows.map(toListItem), pagination };
  },

  async getById(id: string): Promise<AnnouncementDetail | null> {
    const row = await prisma.announcement.findUnique({ where: { id } });
    return row ? toDetail(row) : null;
  },

  /** SCHEDULED rows whose scheduledAt is due — candidates for the scheduler to claim. */
  async findDueScheduled(
    now: Date
  ): Promise<
    Pick<
      Announcement,
      "id" | "title" | "description" | "target" | "kind" | "communityId"
    >[]
  > {
    return prisma.announcement.findMany({
      where: { status: "SCHEDULED", scheduledAt: { lte: now } },
      select: {
        id: true,
        title: true,
        description: true,
        target: true,
        kind: true,
        communityId: true,
      },
    });
  },

  /**
   * Atomic compare-and-swap: only succeeds (returns true) if the row is still
   * SCHEDULED at the moment of the update. This is the guard against two
   * backoffice-service instances double-claiming the same due announcement.
   */
  async claimScheduled(id: string): Promise<boolean> {
    const result = await prisma.announcement.updateMany({
      where: { id, status: "SCHEDULED" },
      data: { status: "PROCESSING" },
    });
    return result.count === 1;
  },

  incrementRecipientCount(id: string, delta: number): Promise<Announcement> {
    return prisma.announcement.update({
      where: { id },
      data: { recipientCount: { increment: delta } },
    });
  },

  markSent(id: string): Promise<Announcement> {
    return prisma.announcement.update({
      where: { id },
      data: { status: "SENT", sentAt: new Date() },
    });
  },

  markFailed(id: string, reason: string): Promise<Announcement> {
    return prisma.announcement.update({
      where: { id },
      data: { status: "FAILED", failureReason: reason.slice(0, 2000) },
    });
  },
};

export type { AnnouncementTarget, AnnouncementStatus };
