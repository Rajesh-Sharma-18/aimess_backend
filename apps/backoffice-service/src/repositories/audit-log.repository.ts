import { prisma } from "../config/prisma.js";
import type {
  AuditActorType,
  AuditLog,
  AuditSource,
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
import { communityClient } from "../grpc/community.client.js";
import { userClient } from "../grpc/user.client.js";
import { logger } from "@aimess/logger";
import {
  MANDATORY_AUDIT_ACTIONS,
  auditActionsForCategory,
  auditCategoryOf,
} from "@aimess/messaging";
import type { AuditCategoryKind } from "../types/audit-log.types.js";

// The unfiltered default page shows the mandatory classification only — the five
// categories in @aimess/messaging mandatory-audit-actions.ts. Everything else
// (views, joins, token refreshes) stays queryable through an explicit ?action=
// filter, it just no longer buries the moderation trail.
const MANDATORY_ACTIONS: string[] = [...MANDATORY_AUDIT_ACTIONS];

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

/** The columns the resolver below reads off a row. */
type ResolvableRow = Pick<
  AuditLog,
  "actorId" | "actorType" | "targetType" | "targetId"
>;

/**
 * A raw target id answers "which one", never "which one is that". The Target
 * column was printing a bare uuid for every row, so a reader could not tell who
 * was banned without pasting the id into another screen. These are the target
 * types whose display name is resolvable from a service backoffice already talks
 * to; anything else (session, report, livestream, …) keeps showing its id.
 */
const NAMED_TARGET_TYPES = new Set(["user", "admin", "community", "session"]);

/**
 * Resolves every row's performer AND target display name in ONE batch per source.
 * There is no FK to follow: ADMIN actors live in admin_db, USER actors and user
 * targets in user-service (gRPC), community targets in community-service. Actor
 * and target ids are folded into the same batches, so naming the target costs no
 * extra round trip. Any lookup failing degrades to an unnamed row rather than
 * failing the page.
 */
async function buildRowResolver(rows: ResolvableRow[]): Promise<{
  toPerformer: (row: ResolvableRow) => Promise<AuditPerformer>;
  targetNameOf: (row: ResolvableRow) => string | null;
}> {
  const actorIdsOf = (type: AuditActorType) =>
    rows
      .filter((r) => r.actorType === type && r.actorId)
      .map((r) => r.actorId as string);
  const targetIdsOf = (targetType: string) =>
    rows
      .filter((r) => r.targetType === targetType && r.targetId)
      .map((r) => r.targetId as string);

  const adminIds = [
    ...new Set([...actorIdsOf("ADMIN"), ...targetIdsOf("admin")]),
  ];
  const userIds = [...new Set([...actorIdsOf("USER"), ...targetIdsOf("user")])];
  const communityIds = [...new Set(targetIdsOf("community"))];

  const [admins, profiles, communities] = await Promise.all([
    adminIds.length
      ? prisma.adminUser.findMany({
          where: { id: { in: adminIds } },
          select: ADMIN_SELECT,
        })
      : Promise.resolve([]),
    userIds.length
      ? userClient.adminGetProfilesByIds(userIds).catch((error: unknown) => {
          logger.warn(
            `Audit log performer lookup failed (user-service, ${userIds.length} ids): ${String(error)}`
          );
          return [];
        })
      : Promise.resolve([]),
    communityIds.length
      ? communityClient
          .adminGetCommunitiesByIds(communityIds)
          .catch((error: unknown) => {
            logger.warn(
              `Audit log target lookup failed (community-service): ${String(error)}`
            );
            return new Map<string, { name: string }>();
          })
      : Promise.resolve(new Map<string, { name: string }>()),
  ]);

  const adminMap = new Map(admins.map((a) => [a.id, a]));
  const profileMap = new Map(profiles.map((p) => [p.userId, p]));

  /** Full name, else username — the same precedence the performer column uses. */
  const displayNameOf = (userId: string): string | null => {
    const profile = profileMap.get(userId);
    if (!profile) return null;
    const fullName =
      `${profile.firstName ?? ""} ${profile.lastName ?? ""}`.trim();
    return fullName || profile.username || null;
  };

  const targetNameOf = (row: ResolvableRow): string | null => {
    if (!row.targetId || !NAMED_TARGET_TYPES.has(row.targetType)) return null;
    if (row.targetType === "user") return displayNameOf(row.targetId);
    if (row.targetType === "admin")
      return adminMap.get(row.targetId)?.name ?? null;
    // A session id names nobody, and login/logout rows are all session-targeted.
    // The session belongs to the account that opened it — the actor on this very
    // row — so that is the name a reader is looking for.
    if (row.targetType === "session") {
      if (!row.actorId) return null;
      return row.actorType === "ADMIN"
        ? (adminMap.get(row.actorId)?.name ?? null)
        : displayNameOf(row.actorId);
    }
    return communities.get(row.targetId)?.name ?? null;
  };

  const toPerformer = async (row: ResolvableRow): Promise<AuditPerformer> => {
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
      return {
        id: row.actorId,
        type: row.actorType,
        name: displayNameOf(row.actorId),
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

  return { toPerformer, targetNameOf };
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
        // Written only by admin-panel request handlers, so the source is known
        // without asking the client — no header to spoof on this path.
        source: "ADMIN_PANEL",
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

    // Category is a named slice of the action filter — both narrow the same
    // column, so they are ordered rather than combined: an explicit ?action=
    // wins, then ?category=, then the full mandatory set.
    if (query.action && query.action.length > 0) {
      where.action = { in: query.action };
    } else if (query.category && query.category.length > 0) {
      where.action = {
        in: query.category.flatMap((c) => auditActionsForCategory(c)),
      };
    } else {
      where.action = { in: MANDATORY_ACTIONS };
    }
    if (query.source && query.source.length > 0) {
      where.source = { in: query.source as AuditSource[] };
    }
    if (query.actorType && query.actorType.length > 0) {
      // Legacy filter, kept so old links keep working: it selects who acted
      // (admin / end user / platform), where `source` selects which client.
      const actorTypes = new Set<AuditActorType>(query.actorType);
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

    const { toPerformer, targetNameOf } = await buildRowResolver(rows);
    const data: AuditLogListItem[] = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        performer: await toPerformer(row),
        source: row.source,
        category: auditCategoryOf(row.action) as AuditCategoryKind | null,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        targetName: targetNameOf(row),
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
    const { toPerformer, targetNameOf } = await buildRowResolver([row]);
    return {
      id: row.id,
      performer: await toPerformer(row),
      source: row.source,
      category: auditCategoryOf(row.action) as AuditCategoryKind | null,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      targetName: targetNameOf(row),
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
