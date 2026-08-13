import { prisma } from "../config/prisma.js";
import type {
  AuditActorType,
  AuditLog,
  Prisma,
} from "../generated/prisma/client.js";
import type {
  AuditLogDetail,
  AuditLogListItem,
  AuditPerformer,
  ListAuditLogsQuery,
  Paginated,
  PaginationMeta,
} from "../types/audit-log.types.js";
import { resolveAvatarOrNull } from "../lib/avatar-media.js";
import { userClient } from "../grpc/user.client.js";
import { AUDIT_ACTIONS } from "../constants/index.js";
import { logger } from "@aimess/logger";

// Read-audit rows would bury the moderation trail on the unfiltered default
// page. Derived from the constant KEYS (…_VIEWED) so "…_REVIEWED" is excluded.
const VIEW_ACTIONS: string[] = Object.entries(AUDIT_ACTIONS)
  .filter(([key]) => key.endsWith("_VIEWED"))
  .map(([, value]) => value);

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

const ADMIN_SELECT = {
  id: true,
  name: true,
  email: true,
  avatarUrl: true,
} as const;

/**
 * Resolves every row's performer in ONE batch per actor kind. There is no FK to
 * follow any more: ADMIN actors live in admin_db, USER actors in user-service
 * (gRPC), and SYSTEM rows have no actor at all. A user-service outage degrades to
 * an unnamed performer instead of failing the page.
 */
async function buildPerformerResolver(
  rows: Pick<AuditLog, "actorId" | "actorType">[]
): Promise<
  (row: Pick<AuditLog, "actorId" | "actorType">) => Promise<AuditPerformer>
> {
  const idsOf = (type: AuditActorType) => [
    ...new Set(
      rows
        .filter((r) => r.actorType === type && r.actorId)
        .map((r) => r.actorId as string)
    ),
  ];
  const adminIds = idsOf("ADMIN");
  const userIds = idsOf("USER");

  const [admins, profiles] = await Promise.all([
    adminIds.length
      ? prisma.adminUser.findMany({
          where: { id: { in: adminIds } },
          select: ADMIN_SELECT,
        })
      : Promise.resolve([]),
    userIds.length
      ? userClient.adminGetProfilesByIds(userIds).catch((error: unknown) => {
          logger.warn(
            `Audit log performer lookup failed (user-service): ${String(error)}`
          );
          return [];
        })
      : Promise.resolve([]),
  ]);

  const adminMap = new Map(admins.map((a) => [a.id, a]));
  const profileMap = new Map(profiles.map((p) => [p.userId, p]));

  return async (row) => {
    if (row.actorType === "SYSTEM" || !row.actorId) {
      return {
        id: row.actorId,
        type: row.actorType,
        name: null,
        email: null,
        avatar: null,
      };
    }
    if (row.actorType === "USER") {
      const profile = profileMap.get(row.actorId);
      const fullName = profile
        ? `${profile.firstName ?? ""} ${profile.lastName ?? ""}`.trim()
        : "";
      return {
        id: row.actorId,
        type: row.actorType,
        name: fullName || profile?.username || null,
        // user-service's admin profile projection carries no email — username stands in.
        email: profile?.username ?? null,
        avatar: await resolveAvatarOrNull(profile?.avatarUrl ?? null),
      };
    }
    const admin = adminMap.get(row.actorId);
    return {
      id: row.actorId,
      type: row.actorType,
      name: admin?.name ?? null,
      email: admin?.email ?? null,
      avatar: await resolveAvatarOrNull(admin?.avatarUrl ?? null),
    };
  };
}

/**
 * `search` matches the target id OR the performer's name/email — and the performer
 * can be an admin (local table) or an end user (user-service). Both id sets are
 * resolved first, then folded into a single `actorId IN (…)` clause.
 */
async function resolveSearchActorIds(term: string): Promise<string[]> {
  const [admins, userIds] = await Promise.all([
    prisma.adminUser.findMany({
      where: {
        OR: [
          { name: { contains: term, mode: "insensitive" } },
          { email: { contains: term, mode: "insensitive" } },
        ],
      },
      select: { id: true },
    }),
    userClient.adminSearchProfileIds(term).catch((error: unknown) => {
      logger.warn(
        `Audit log performer search failed (user-service): ${String(error)}`
      );
      return [] as string[];
    }),
  ]);
  return [...new Set([...admins.map((a) => a.id), ...userIds])];
}

export const auditLogRepository = {
  /**
   * Append an audit row. Accepts an optional transaction client so the write
   * can share a transaction with the domain mutation it records. Admin-side only —
   * website activity is written by the admin.activity.ingest consumer.
   */
  create(input: AuditLogInput, client: Prisma.TransactionClient = prisma) {
    return client.auditLog.create({
      data: {
        actorId: input.actorId,
        actorType: "ADMIN",
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
    } else {
      // View rows stay reachable, but only via an explicit ?action= filter.
      where.action = { notIn: VIEW_ACTIONS };
    }
    if (query.actorType && query.actorType.length > 0) {
      // The admin panel offers two sources, not three: "System" means everything that
      // did NOT come from the admin panel, so it covers USER rows as well as SYSTEM ones.
      const actorTypes = new Set<AuditActorType>(query.actorType);
      if (actorTypes.has("SYSTEM")) actorTypes.add("USER");
      where.actorType = { in: [...actorTypes] };
    }
    if (query.search) {
      const actorIds = await resolveSearchActorIds(query.search);
      where.OR = [
        { targetId: { contains: query.search, mode: "insensitive" } },
        ...(actorIds.length > 0 ? [{ actorId: { in: actorIds } }] : []),
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
      }),
      prisma.auditLog.count({ where }),
    ]);

    const toPerformer = await buildPerformerResolver(rows);
    const data: AuditLogListItem[] = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        performer: await toPerformer(row),
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        createdAt: row.createdAt.getTime(),
      }))
    );

    const totalPages = total === 0 ? 0 : Math.ceil(total / query.limit);
    const pagination: PaginationMeta = {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
      hasNext: skip + query.limit < total,
      hasPrev: query.page > 1,
    };
    return { data, pagination };
  },

  /** Single audit-log detail; null → 404 at the controller. */
  async getById(id: string): Promise<AuditLogDetail | null> {
    const row = await prisma.auditLog.findUnique({ where: { id } });
    if (!row) return null;
    const toPerformer = await buildPerformerResolver([row]);
    return {
      id: row.id,
      performer: await toPerformer(row),
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      createdAt: row.createdAt.getTime(),
      reason: extractReason(row),
      metadata: {
        before: row.before ?? null,
        after: row.after ?? null,
        ip: row.ip,
        userAgent: row.userAgent,
      },
    };
  },
};
