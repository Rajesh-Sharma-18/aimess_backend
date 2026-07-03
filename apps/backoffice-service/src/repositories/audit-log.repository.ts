import { prisma } from "../config/prisma.js";
import type { AuditLog, Prisma } from "../generated/prisma/client.js";
import type {
  AuditLogDetail,
  AuditLogListItem,
  AuditPerformer,
  ListAuditLogsQuery,
  Paginated,
  PaginationMeta,
} from "../types/audit-log.types.js";

export type AuditLogInput = {
  actorId: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  ip?: string | null;
  userAgent?: string | null;
};

/** Whitelisted sort columns for the list endpoint (validator enforces the shape). */
type SortField = "createdAt" | "action";

function parseSort(sort: string): { field: SortField; dir: "asc" | "desc" } {
  const [field, dir] = sort.split(":") as [SortField, "asc" | "desc"];
  return { field, dir };
}

/** AuditLog row with the actor relation eagerly loaded. */
type AuditLogWithActor = AuditLog & {
  actor: {
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
  } | null;
};

function toPerformer(row: AuditLogWithActor): AuditPerformer {
  return {
    id: row.actorId,
    name: row.actor?.name ?? null,
    email: row.actor?.email ?? null,
    avatarUrl: row.actor?.avatarUrl ?? null,
  };
}

/**
 * Lift a best-effort human "reason" from the recorded before/after payloads.
 * Services stamp free-text under a handful of conventional keys (note, reason,
 * reasonNote, reasonCode); we surface the first one present, `after` first.
 */
function extractReason(row: AuditLog): string | null {
  const REASON_KEYS = ["reason", "note", "reasonNote", "reasonCode"] as const;
  for (const payload of [row.after, row.before]) {
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const bag = payload as Record<string, unknown>;
      for (const key of REASON_KEYS) {
        const value = bag[key];
        if (typeof value === "string" && value.trim()) return value;
      }
    }
  }
  return null;
}

function toListItem(row: AuditLogWithActor): AuditLogListItem {
  return {
    id: row.id,
    performer: toPerformer(row),
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    createdAt: row.createdAt.toISOString(),
  };
}

function toDetail(row: AuditLogWithActor): AuditLogDetail {
  return {
    id: row.id,
    performer: toPerformer(row),
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    createdAt: row.createdAt.toISOString(),
    reason: extractReason(row),
    metadata: {
      before: row.before ?? null,
      after: row.after ?? null,
      ip: row.ip,
      userAgent: row.userAgent,
    },
  };
}

const ACTOR_SELECT = {
  select: { id: true, name: true, email: true, avatarUrl: true },
} as const;

export const auditLogRepository = {
  /**
   * Append an audit row. Accepts an optional transaction client so the write
   * can share a transaction with the domain mutation it records.
   */
  create(input: AuditLogInput, client: Prisma.TransactionClient = prisma) {
    return client.auditLog.create({
      data: {
        actorId: input.actorId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        ...(input.before !== undefined ? { before: input.before } : {}),
        ...(input.after !== undefined ? { after: input.after } : {}),
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  },

  /** Paginated + filtered list (newest first by default). */
  async list(query: ListAuditLogsQuery): Promise<Paginated<AuditLogListItem>> {
    const { field, dir } = parseSort(query.sort);
    const where: Prisma.AuditLogWhereInput = {};

    if (query.action && query.action.length > 0) {
      where.action = { in: query.action };
    }
    if (query.search) {
      // Search performer (name/email) OR the target id.
      where.OR = [
        { targetId: { contains: query.search, mode: "insensitive" } },
        { actor: { name: { contains: query.search, mode: "insensitive" } } },
        { actor: { email: { contains: query.search, mode: "insensitive" } } },
      ];
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
      prisma.auditLog.findMany({
        where,
        // Tiebreak on id so pages are deterministic when two rows share a sort key.
        orderBy: [{ [field]: dir }, { id: "desc" }],
        skip,
        take: query.limit,
        include: { actor: ACTOR_SELECT },
      }),
      prisma.auditLog.count({ where }),
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
    return {
      data: (rows as AuditLogWithActor[]).map(toListItem),
      pagination,
    };
  },

  /** Single audit-log detail; null → 404 at the controller. */
  async getById(id: string): Promise<AuditLogDetail | null> {
    const row = await prisma.auditLog.findUnique({
      where: { id },
      include: { actor: ACTOR_SELECT },
    });
    return row ? toDetail(row as AuditLogWithActor) : null;
  },
};
