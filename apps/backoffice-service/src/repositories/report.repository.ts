import { ConflictError, NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import { prisma } from "../config/prisma.js";
import type { Prisma } from "../generated/prisma/client.js";
import { isUuid } from "../lib/uuid.js";
import {
  communityClient,
  type AdminCommunityBrief,
} from "../grpc/community.client.js";
import { userClient, type AdminProfileRecord } from "../grpc/user.client.js";
import {
  decodeCursor as decodeCursorRaw,
  encodeCursor as encodeCursorGeneric,
  parseSort as parseSortGeneric,
} from "../lib/keyset-cursor.js";
import { adminUserRepository } from "./admin-user.repository.js";
import { moderationActionRepository } from "./moderation-action.repository.js";
import { reportFixtures } from "./__fixtures__/reports.fixture.js";
import { resolveAvatarOrNull } from "../lib/avatar-media.js";
import type {
  AccountStatus,
  ActionOnReportedUser,
  BulkResult,
  BulkResultItem,
  DismissReason,
  DismissResult,
  EvidenceItem,
  HistoryItem,
  ListReportEvidenceQuery,
  ListReportHistoryQuery,
  ListReportRelatedQuery,
  ModeratorRef,
  Paginated,
  PaginationMeta,
  RelatedReport,
  ReportCore,
  ReportDetail,
  ReportedUserProfile,
  ReporterUserProfile,
  ReportListItem,
  ReportPriority,
  ReportStatus,
  ReportType,
  ResolutionType,
  ResolveResult,
  TargetType,
  UserRef,
  ListReportsQuery,
} from "../types/moderation.types.js";

/**
 * Repository contract for the Reports & Moderation read+decision model.
 *
 * Phase 1 ships {@link MockReportRepository} (in-memory fixtures). Phase 2 will
 * add a `PrismaReportRepository implements ReportRepository` backed by the
 * `Report` / `ReportEvidence` / `ReportAction` models in `admin_db` — swapping
 * the singleton below is the ENTIRE migration; controllers/routes/validators
 * and the response shapes stay untouched.
 */
export interface ReportRepository {
  list(query: ListReportsQuery): Promise<Paginated<ReportListItem>>;
  getById(id: string): Promise<ReportDetail | null>;
  getCore(id: string): Promise<ReportCore | null>;
  listEvidence(
    id: string,
    query: ListReportEvidenceQuery
  ): Promise<Paginated<EvidenceItem>>;
  listHistory(
    id: string,
    query: ListReportHistoryQuery
  ): Promise<Paginated<HistoryItem>>;
  listRelated(
    id: string,
    query: ListReportRelatedQuery
  ): Promise<Paginated<RelatedReport>>;
  resolve(
    id: string,
    input: ResolveInput,
    actor: ActorRef
  ): Promise<ResolveResult>;
  dismiss(
    id: string,
    input: DismissInput,
    actor: ActorRef
  ): Promise<DismissResult>;
  bulkResolve(
    ids: string[],
    input: ResolveInput,
    actor: ActorRef
  ): Promise<BulkResult>;
  bulkDismiss(
    ids: string[],
    input: DismissInput,
    actor: ActorRef
  ): Promise<BulkResult>;
}

/** Decision payload the service forwards from the validated body. */
export type ResolveInput = {
  resolution: ResolutionType;
  actionOnReportedUser: ActionOnReportedUser;
  note?: string;
};

export type DismissInput = {
  reason: DismissReason;
  note?: string;
  flagFalseReport?: boolean;
};

/** The acting admin (subset of req.admin) + a precomputed timestamp. */
export type ActorRef = {
  moderator: ModeratorRef;
  /** epoch-ms timestamp the service captured for this mutation. */
  at: number;
};

// ---------------------------------------------------------------------------
// Helpers (pure).
// ---------------------------------------------------------------------------
const CLOSED_STATUSES: ReadonlySet<ReportStatus> = new Set([
  "RESOLVED",
  "DISMISSED",
]);

type SortField =
  | "createdAt"
  | "status"
  | "reportType"
  | "priority"
  | "updatedAt";

/**
 * Local sort parser keeps the `1|-1` comparator shape this in-memory repo sorts
 * with; the cursor codec itself is shared (lib/keyset-cursor).
 */
function parseSort(sort: string): { field: SortField; dir: 1 | -1 } {
  const { field, dir } = parseSortGeneric<SortField>(sort);
  return { field, dir: dir === "asc" ? 1 : -1 };
}

/** Opaque keyset cursor over (createdAt, reportId). */
type Cursor = { createdAt: number; reportId: string };

const CURSOR_KEYS = ["createdAt", "reportId"] as const;

function encodeCursor(c: Cursor): string {
  return encodeCursorGeneric(c);
}

function decodeCursor(raw: string): Cursor | null {
  return decodeCursorRaw<Cursor>(raw, CURSOR_KEYS);
}

/**
 * Project a full detail row to the list-table shape. Fixture rows always
 * populate both user refs (unlike real ingested rows, which may target a
 * non-user entity) — the `!` here is fixture-guaranteed, not a real-data assumption.
 */
function toListItem(r: ReportDetail): ReportListItem {
  return {
    reportId: r.reportId,
    reportedUser: {
      id: r.reportedUser!.id,
      username: r.reportedUser!.username,
      displayName: r.reportedUser!.displayName,
      firstName: r.reportedUser!.firstName,
      lastName: r.reportedUser!.lastName,
      avatar: r.reportedUser!.avatar,
      accountStatus: r.reportedUser!.accountStatus,
    },
    reporterUser: {
      id: r.reporterUser!.id,
      username: r.reporterUser!.username,
      displayName: r.reporterUser!.displayName,
      firstName: r.reporterUser!.firstName,
      lastName: r.reporterUser!.lastName,
      avatar: r.reporterUser!.avatar,
    },
    reportType: r.reportType,
    targetType: r.targetType,
    status: r.status,
    priority: r.priority,
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
    moderator: r.moderator ?? null,
    communityName: r.communityName,
  };
}

// ---------------------------------------------------------------------------
// Mock implementation.
// ---------------------------------------------------------------------------
export class MockReportRepository implements ReportRepository {
  /** Mutable in-memory store — cloned from fixtures so resolve/dismiss persist. */
  private readonly rows: ReportDetail[];

  constructor(seed: ReportDetail[] = reportFixtures) {
    // Deep clone so mutations during dev don't corrupt the imported module.
    this.rows = seed.map((r) => structuredClone(r));
  }

  list(query: ListReportsQuery): Promise<Paginated<ReportListItem>> {
    const filtered = this.applyFilters(query);
    const sorted = this.applySort(filtered, query.sort);

    if (query.cursor) {
      return Promise.resolve(this.keysetPage(sorted, query));
    }
    return Promise.resolve(this.offsetPage(sorted, query));
  }

  getById(id: string): Promise<ReportDetail | null> {
    const row = this.rows.find((r) => r.reportId === id) ?? null;
    return Promise.resolve(row ? structuredClone(row) : null);
  }

  getCore(id: string): Promise<ReportCore | null> {
    const row = this.rows.find((r) => r.reportId === id) ?? null;
    if (!row) return Promise.resolve(null);
    const { evidence, history, relatedReports, ...core } = structuredClone(row);
    return Promise.resolve(core);
  }

  listEvidence(
    id: string,
    query: ListReportEvidenceQuery
  ): Promise<Paginated<EvidenceItem>> {
    const row = this.rows.find((r) => r.reportId === id);
    if (!row) return Promise.resolve(this.emptyPage(query));
    const items = row.evidence;
    return Promise.resolve(this.slicePage(items, query));
  }

  listHistory(
    id: string,
    query: ListReportHistoryQuery
  ): Promise<Paginated<HistoryItem>> {
    const row = this.rows.find((r) => r.reportId === id);
    if (!row) return Promise.resolve(this.emptyPage(query));
    const items = row.history;
    return Promise.resolve(this.slicePage(items, query));
  }

  listRelated(
    id: string,
    query: ListReportRelatedQuery
  ): Promise<Paginated<RelatedReport>> {
    const row = this.rows.find((r) => r.reportId === id);
    if (!row) return Promise.resolve(this.emptyPage(query));
    const items = row.relatedReports;
    return Promise.resolve(this.slicePage(items, query));
  }

  resolve(
    id: string,
    input: ResolveInput,
    actor: ActorRef
  ): Promise<ResolveResult> {
    const row = this.requireOpen(id);

    row.status = "RESOLVED";
    row.resolution = input.resolution;
    row.dismissReason = null;
    row.decisionNote = input.note ?? null;
    row.resolvedAt = actor.at;
    row.updatedAt = actor.at;
    row.moderator = actor.moderator;
    row.availableActions = ["VIEW"];
    row.history.push({
      id: `h_${id}_${row.history.length + 1}`,
      action: "RESOLVED",
      actorType: "ADMIN",
      actorId: actor.moderator.id,
      actorName: actor.moderator.name,
      at: actor.at,
      note: input.note ?? null,
    });

    return Promise.resolve({
      reportId: row.reportId,
      status: "RESOLVED",
      resolution: input.resolution,
      resolvedAt: actor.at,
      moderator: actor.moderator,
      appliedActions: this.buildAppliedActions(row, input, actor),
    });
  }

  dismiss(
    id: string,
    input: DismissInput,
    actor: ActorRef
  ): Promise<DismissResult> {
    const row = this.requireOpen(id);

    // input.flagFalseReport is recorded in the audit `after` by the service but
    // intentionally not persisted on the report in Phase 1 (no reporter-reputation store yet).
    row.status = "DISMISSED";
    row.dismissReason = input.reason;
    row.resolution = null;
    row.decisionNote = input.note ?? null;
    row.resolvedAt = actor.at;
    row.updatedAt = actor.at;
    row.moderator = actor.moderator;
    row.availableActions = ["VIEW"];
    row.history.push({
      id: `h_${id}_${row.history.length + 1}`,
      action: "DISMISSED",
      actorType: "ADMIN",
      actorId: actor.moderator.id,
      actorName: actor.moderator.name,
      at: actor.at,
      note: input.note ?? null,
    });

    return Promise.resolve({
      reportId: row.reportId,
      status: "DISMISSED",
      dismissReason: input.reason,
      resolvedAt: actor.at,
      moderator: actor.moderator,
    });
  }

  async bulkResolve(
    ids: string[],
    input: ResolveInput,
    actor: ActorRef
  ): Promise<BulkResult> {
    return this.runBulk(ids, (id) => this.resolve(id, input, actor));
  }

  async bulkDismiss(
    ids: string[],
    input: DismissInput,
    actor: ActorRef
  ): Promise<BulkResult> {
    return this.runBulk(ids, (id) => this.dismiss(id, input, actor));
  }

  // -------------------------------------------------------------------------
  // Internals.
  // -------------------------------------------------------------------------
  private requireOpen(id: string): ReportDetail {
    const row = this.rows.find((r) => r.reportId === id);
    if (!row) throw new NotFoundError("REPORT_NOT_FOUND");
    if (CLOSED_STATUSES.has(row.status)) {
      throw new ConflictError("REPORT_ALREADY_RESOLVED");
    }
    return row;
  }

  private buildAppliedActions(
    row: ReportDetail,
    input: ResolveInput,
    actor: ActorRef
  ): ResolveResult["appliedActions"] {
    if (input.actionOnReportedUser === "NONE") return [];
    let effectiveUntil: number | null = null;
    if (input.actionOnReportedUser === "SUSPEND_7D") {
      effectiveUntil = this.addDays(actor.at, 7);
    } else if (input.actionOnReportedUser === "SUSPEND_30D") {
      effectiveUntil = this.addDays(actor.at, 30);
    }
    return [
      {
        type: input.actionOnReportedUser,
        targetUserId: row.reportedUser!.id,
        effectiveUntil,
      },
    ];
  }

  private addDays(ms: number, days: number): number {
    const d = new Date(ms);
    d.setUTCDate(d.getUTCDate() + days);
    return d.getTime();
  }

  private async runBulk(
    ids: string[],
    op: (id: string) => Promise<{ reportId: string; status: ReportStatus }>
  ): Promise<BulkResult> {
    const results: BulkResultItem[] = [];
    let succeeded = 0;
    let failed = 0;

    for (const id of ids) {
      try {
        const r = await op(id);
        results.push({ reportId: id, status: r.status, ok: true });
        succeeded += 1;
      } catch (err) {
        failed += 1;
        const code =
          err instanceof ConflictError
            ? "REPORT_ALREADY_RESOLVED"
            : err instanceof NotFoundError
              ? "REPORT_NOT_FOUND"
              : "BULK_ITEM_FAILED";
        const message =
          err instanceof Error ? err.message : "Unexpected bulk item error";
        results.push({ reportId: id, ok: false, error: { code, message } });
      }
    }

    return { requested: ids.length, succeeded, failed, results };
  }

  private slicePage<T>(
    items: T[],
    query: { page: number; limit: number }
  ): Paginated<T> {
    const { page, limit } = query;
    const total = items.length;
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
    const start = (page - 1) * limit;
    const slice = items.slice(start, start + limit);
    return {
      data: slice,
      pagination: {
        mode: "offset",
        page,
        limit,
        total,
        totalApprox: total,
        totalPages,
        hasNext: start + limit < total,
        hasPrev: page > 1,
        nextCursor: null,
      },
    };
  }

  private emptyPage<T>(query: { page: number; limit: number }): Paginated<T> {
    return this.slicePage<T>([], query);
  }

  private applyFilters(query: ListReportsQuery): ReportDetail[] {
    const search = query.search?.toLowerCase();
    const typeSet = query.reportType ? new Set(query.reportType) : null;
    const statusSet = query.status ? new Set(query.status) : null;
    const from = query.dateFrom
      ? Date.parse(`${query.dateFrom}T00:00:00.000Z`)
      : null;
    // dateTo is inclusive on the whole day.
    const to = query.dateTo
      ? Date.parse(`${query.dateTo}T23:59:59.999Z`)
      : null;

    return this.rows.filter((r) => {
      if (typeSet && !typeSet.has(r.reportType)) return false;
      if (statusSet && !statusSet.has(r.status)) return false;
      if (query.targetType && r.targetType !== query.targetType) return false;
      if (query.communityId && r.communityId !== query.communityId)
        return false;
      if (query.assignedTo) {
        if (query.assignedTo === "unassigned") {
          if (r.moderator) return false;
        } else if ((r.moderator?.id ?? null) !== query.assignedTo) {
          return false;
        }
      }
      const created = r.createdAt;
      if (from !== null && created < from) return false;
      if (to !== null && created > to) return false;
      if (search) {
        const haystack = [
          r.reportId,
          r.reportedUser!.username,
          r.reportedUser!.displayName,
          r.reporterUser!.username,
          r.reporterUser!.displayName,
          r.communityName ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
  }

  private applySort(rows: ReportDetail[], sort: string): ReportDetail[] {
    const { field, dir } = parseSort(sort);
    return [...rows].sort((a, b) => {
      const av = String(a[field]);
      const bv = String(b[field]);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      // Stable tiebreaker on reportId so keyset pagination is deterministic.
      if (a.reportId < b.reportId) return -1;
      if (a.reportId > b.reportId) return 1;
      return 0;
    });
  }

  private offsetPage(
    sorted: ReportDetail[],
    query: ListReportsQuery
  ): Paginated<ReportListItem> {
    const { page, limit } = query;
    const total = sorted.length;
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
    const start = (page - 1) * limit;
    const slice = sorted.slice(start, start + limit);
    const hasNext = start + limit < total;

    const last = slice[slice.length - 1];
    // The cursor encodes {createdAt, reportId}; only emit it when the active sort
    // is createdAt, else the keyset path would mis-decode it against a different ordering.
    const cursorable = parseSort(query.sort).field === "createdAt";
    const pagination: PaginationMeta = {
      mode: "offset",
      page,
      limit,
      total,
      totalApprox: total,
      totalPages,
      hasNext,
      hasPrev: page > 1,
      nextCursor:
        cursorable && hasNext && last
          ? encodeCursor({ createdAt: last.createdAt, reportId: last.reportId })
          : null,
    };
    return { data: slice.map(toListItem), pagination };
  }

  private keysetPage(
    sorted: ReportDetail[],
    query: ListReportsQuery
  ): Paginated<ReportListItem> {
    const { limit } = query;
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;

    let startIdx = 0;
    if (cursor) {
      const idx = sorted.findIndex(
        (r) =>
          r.createdAt === cursor.createdAt && r.reportId === cursor.reportId
      );
      startIdx = idx >= 0 ? idx + 1 : 0;
    }

    const slice = sorted.slice(startIdx, startIdx + limit);
    const hasNext = startIdx + limit < sorted.length;
    const last = slice[slice.length - 1];

    const pagination: PaginationMeta = {
      mode: "keyset",
      page: 1,
      limit,
      total: sorted.length,
      totalApprox: sorted.length,
      totalPages: limit === 0 ? 0 : Math.ceil(sorted.length / limit),
      hasNext,
      hasPrev: startIdx > 0,
      nextCursor:
        hasNext && last
          ? encodeCursor({ createdAt: last.createdAt, reportId: last.reportId })
          : null,
    };
    return { data: slice.map(toListItem), pagination };
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Prisma-backed implementation (admin_db.Report, real ingested rows).
// ---------------------------------------------------------------------------
//
// Known, documented gaps vs. the full ReportDetail contract (tracked for a
// follow-up, NOT faked here):
//  - evidence[] / relatedReports[]: no ReportEvidence model and no duplicate-
//    detection query yet — both endpoints return a real, empty paginated page.
//  - target.snapshot / deepLink / conversationId: would need a live gRPC call
//    to chat/community-service per targetType; not wired.
//  - sourceService: AdminReportIngestPayload does not carry which upstream
//    service published the row, and both chat-service and community-service
//    can emit `type: "user"` — genuinely not derivable, so this is "unknown"
//    rather than a guess.
//  - reportType: upstream `reason` is a free-text field for community reports
//    (chat-service reports use a fixed-but-different enum with e.g. "SCAM").
//    We best-effort-match `reason` against the 12-value ReportType enum
//    (case-insensitive) and fall back to OTHER — real data, not a fixture.

const REPORT_TYPES: readonly ReportType[] = [
  "SPAM",
  "HARASSMENT",
  "HATE_SPEECH",
  "NUDITY",
  "VIOLENCE",
  "SELF_HARM",
  "IMPERSONATION",
  "MISINFORMATION",
  "ILLEGAL_CONTENT",
  "CSAM",
  "TERRORISM",
  "OTHER",
];
const KNOWN_REPORT_TYPES = REPORT_TYPES.filter((t) => t !== "OTHER");

function toReportType(reason: string): ReportType {
  const upper = reason
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
  return (KNOWN_REPORT_TYPES as string[]).includes(upper)
    ? (upper as ReportType)
    : "OTHER";
}

function toPriority(priority: string): ReportPriority {
  switch (priority.trim().toLowerCase()) {
    case "low":
      return "LOW";
    case "high":
      return "HIGH";
    case "critical":
    case "urgent":
      return "CRITICAL";
    default:
      return "MEDIUM";
  }
}

const DB_TYPE_TO_TARGET_TYPE: Record<string, TargetType> = {
  user: "USER",
  community: "COMMUNITY",
  message: "MESSAGE",
  stream: "STREAM",
};
const TARGET_TYPE_TO_DB_TYPE: Partial<Record<TargetType, string>> = {
  USER: "user",
  COMMUNITY: "community",
  MESSAGE: "message",
  STREAM: "stream",
};
function toTargetType(dbType: string): TargetType {
  return DB_TYPE_TO_TARGET_TYPE[dbType] ?? "MEDIA";
}

const DB_STATUS_TO_STATUS: Record<string, ReportStatus> = {
  open: "PENDING",
  reviewing: "UNDER_REVIEW",
  resolved: "RESOLVED",
  dismissed: "DISMISSED",
};
// ESCALATED has no dedicated admin_db bucket yet — closest existing state.
const STATUS_TO_DB_STATUS: Record<ReportStatus, string> = {
  PENDING: "open",
  UNDER_REVIEW: "reviewing",
  RESOLVED: "resolved",
  DISMISSED: "dismissed",
  ESCALATED: "reviewing",
};
function toReportStatus(dbStatus: string): ReportStatus {
  return DB_STATUS_TO_STATUS[dbStatus] ?? "PENDING";
}

const CLOSED_DB_STATUSES = new Set(["resolved", "dismissed"]);

type RawReportRow = {
  id: string;
  type: string;
  targetId: string;
  reporterId: string;
  reason: string;
  details: string | null;
  communityId: string | null;
  status: string;
  priority: string;
  assignedTo: string | null;
  resolution: string | null;
  dismissReason: string | null;
  decisionNote: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  reportedUserId: string | null;
};

/** Batched profile/status/moderator-name lookups for a page of report rows. */
type EnrichmentContext = {
  profiles: Map<string, AdminProfileRecord>;
  statuses: Map<string, AccountStatus>;
  moderatorNames: Map<string, string>;
  communityNames: Map<string, string>;
};

async function buildListEnrichment(
  rows: RawReportRow[]
): Promise<EnrichmentContext> {
  const userIds = new Set<string>();
  const moderatorIds = new Set<string>();
  // The community name is never stored on the row — it's resolved live from
  // community-service on every read via this batch lookup, so it can't go stale.
  const communityIds = new Set<string>();
  for (const r of rows) {
    if (r.type === "user") userIds.add(r.targetId);
    else if (r.reportedUserId) userIds.add(r.reportedUserId);
    userIds.add(r.reporterId);
    if (r.assignedTo) moderatorIds.add(r.assignedTo);
    if (r.communityId) communityIds.add(r.communityId);
  }
  const allUserIds = [...userIds];

  const [profiles, userIndexRows, moderatorNames, communityBriefs] =
    await Promise.all([
      userClient.adminGetProfilesByIds(allUserIds),
      allUserIds.length
        ? prisma.userIndex.findMany({
            where: { userId: { in: allUserIds } },
            select: { userId: true, status: true },
          })
        : Promise.resolve([]),
      adminUserRepository.findNamesByIds([...moderatorIds]),
      communityClient.adminGetCommunitiesByIds([...communityIds]),
    ]);

  return {
    profiles: new Map(profiles.map((p) => [p.userId, p])),
    statuses: new Map(
      userIndexRows.map((u) => [u.userId, u.status as AccountStatus])
    ),
    moderatorNames,
    communityNames: new Map(
      [...communityBriefs.values()].map((c) => [c.communityId, c.name])
    ),
  };
}

async function toUserRef(
  userId: string,
  ctx: EnrichmentContext
): Promise<UserRef | null> {
  const profile = ctx.profiles.get(userId);
  if (!profile) return null;
  const displayName =
    [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim() ||
    profile.username;
  return {
    id: userId,
    username: profile.username,
    displayName,
    firstName: profile.firstName,
    lastName: profile.lastName,
    avatar: await resolveAvatarOrNull(profile.avatarUrl),
    accountStatus: ctx.statuses.get(userId),
  };
}

function toModeratorRef(
  assignedTo: string | null,
  ctx: Pick<EnrichmentContext, "moderatorNames">
): ModeratorRef | null {
  if (!assignedTo) return null;
  return {
    id: assignedTo,
    name: ctx.moderatorNames.get(assignedTo) ?? assignedTo,
  };
}

async function toReportListItem(
  r: RawReportRow,
  ctx: EnrichmentContext
): Promise<ReportListItem> {
  const reportedUserId =
    r.type === "user" ? r.targetId : (r.reportedUserId ?? null);
  const [reportedUser, reporterUser] = await Promise.all([
    reportedUserId ? toUserRef(reportedUserId, ctx) : Promise.resolve(null),
    toUserRef(r.reporterId, ctx),
  ]);
  return {
    reportId: r.id,
    reportedUser,
    reporterUser,
    reportType: toReportType(r.reason),
    targetType: toTargetType(r.type),
    status: toReportStatus(r.status),
    priority: toPriority(r.priority),
    createdAt: r.createdAt.getTime(),
    resolvedAt: r.resolvedAt?.getTime() ?? null,
    moderator: toModeratorRef(r.assignedTo, ctx),
    communityName: r.communityId
      ? (ctx.communityNames.get(r.communityId) ?? null)
      : null,
  };
}

/** Real, derived availableActions — no DB column, but not hardcoded either. */
function toAvailableActions(status: ReportStatus): string[] {
  return status === "RESOLVED" || status === "DISMISSED"
    ? ["VIEW"]
    : ["RESOLVE", "DISMISS", "ESCALATE"];
}

async function toReportedProfile(
  userId: string,
  ctx: EnrichmentContext,
  priorReportsCount: number,
  priorActionsCount: number
): Promise<ReportedUserProfile | null> {
  const ref = await toUserRef(userId, ctx);
  if (!ref) return null;
  return {
    ...ref,
    accountStatus: ref.accountStatus ?? "ACTIVE",
    // ctx.profiles' createdAt arrives as an ISO string from user-service — coerce to epoch ms.
    joinedAt: Date.parse(ctx.profiles.get(userId)?.createdAt ?? "") || 0,
    priorReportsCount,
    priorActionsCount,
  };
}

async function toReporterProfile(
  userId: string,
  ctx: EnrichmentContext,
  reportsFiledCount: number,
  falseReportCount: number
): Promise<ReporterUserProfile | null> {
  const ref = await toUserRef(userId, ctx);
  if (!ref) return null;
  return {
    ...ref,
    accountStatus: ref.accountStatus ?? "ACTIVE",
    reportsFiledCount,
    falseReportRate:
      reportsFiledCount > 0
        ? Math.round((falseReportCount / reportsFiledCount) * 100) / 100
        : 0,
  };
}

/** reportType filter: match `reason` case-insensitively; OTHER = none of the 12 known values. */
function reportTypeClause(types: ReportType[]): Prisma.ReportWhereInput {
  const known = types.filter((t): t is ReportType => t !== "OTHER");
  const wantsOther = types.includes("OTHER");
  const clauses: Prisma.ReportWhereInput[] = [];
  if (known.length) {
    clauses.push({
      OR: known.map((t) => ({
        reason: { equals: t, mode: "insensitive" as const },
      })),
    });
  }
  if (wantsOther) {
    clauses.push({
      NOT: {
        OR: KNOWN_REPORT_TYPES.map((t) => ({
          reason: { equals: t, mode: "insensitive" as const },
        })),
      },
    });
  }
  return clauses.length === 1 ? clauses[0]! : { OR: clauses };
}

/** Human-readable label per ReportStatus, used to match free-text status search. */
const REPORT_STATUS_LABELS: Record<ReportStatus, string> = {
  PENDING: "pending",
  UNDER_REVIEW: "under review",
  RESOLVED: "resolved",
  DISMISSED: "dismissed",
  ESCALATED: "escalated",
};

/**
 * Db status values whose human label matches (either direction) the search
 * term. Guarded to terms of 3+ chars so a 1-2 char query doesn't fuzzily match
 * every status label (e.g. "e" is a substring of nearly all of them).
 */
function matchReportStatusLabels(term: string): string[] {
  const lower = term.toLowerCase();
  if (lower.length < 3) return [];
  const matched = new Set<string>();
  for (const status of Object.keys(REPORT_STATUS_LABELS) as ReportStatus[]) {
    const label = REPORT_STATUS_LABELS[status];
    if (label.includes(lower) || lower.includes(label)) {
      matched.add(STATUS_TO_DB_STATUS[status]);
    }
  }
  return [...matched];
}

type ListSortField =
  | "createdAt"
  | "status"
  | "reportType"
  | "priority"
  | "updatedAt";
const PRISMA_SORT_COLUMN: Record<ListSortField, string> = {
  createdAt: "createdAt",
  status: "status",
  // reportType has no dedicated column — `reason` is the closest real proxy.
  reportType: "reason",
  priority: "priority",
  updatedAt: "updatedAt",
};

/** Shared bulk-op runner (resolve/dismiss loop with per-item error capture). */
async function runBulkOp(
  ids: string[],
  op: (id: string) => Promise<{ reportId: string; status: ReportStatus }>
): Promise<BulkResult> {
  const results: BulkResultItem[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const id of ids) {
    try {
      const r = await op(id);
      results.push({ reportId: id, status: r.status, ok: true });
      succeeded += 1;
    } catch (err) {
      failed += 1;
      const code =
        err instanceof ConflictError
          ? "REPORT_ALREADY_RESOLVED"
          : err instanceof NotFoundError
            ? "REPORT_NOT_FOUND"
            : "BULK_ITEM_FAILED";
      const message =
        err instanceof Error ? err.message : "Unexpected bulk item error";
      results.push({ reportId: id, ok: false, error: { code, message } });
    }
  }

  return { requested: ids.length, succeeded, failed, results };
}

function buildAppliedActionsFor(
  targetUserId: string,
  input: ResolveInput,
  actor: ActorRef
): ResolveResult["appliedActions"] {
  if (input.actionOnReportedUser === "NONE") return [];
  let effectiveUntil: number | null = null;
  if (input.actionOnReportedUser === "SUSPEND_7D") {
    effectiveUntil = addDaysMs(actor.at, 7);
  } else if (input.actionOnReportedUser === "SUSPEND_30D") {
    effectiveUntil = addDaysMs(actor.at, 30);
  }
  return [{ type: input.actionOnReportedUser, targetUserId, effectiveUntil }];
}

function addDaysMs(ms: number, days: number): number {
  const d = new Date(ms);
  d.setUTCDate(d.getUTCDate() + days);
  return d.getTime();
}

export class PrismaReportRepository implements ReportRepository {
  async list(query: ListReportsQuery): Promise<Paginated<ReportListItem>> {
    try {
      const where = await this.buildWhere(query);
      const orderBy = this.buildOrderBy(query.sort);
      const cursorable =
        parseSortGeneric<ListSortField>(query.sort).field === "createdAt";

      if (query.cursor && cursorable) {
        return await this.keysetPage(where, orderBy, query);
      }
      return await this.offsetPage(where, orderBy, query, cursorable);
    } catch (error) {
      // Surface the real cause with the query context that triggered it —
      // otherwise the global error handler only emits a generic 500 and the
      // offending search term / filter is lost.
      logger.error(
        `Report list failed (search=${JSON.stringify(
          query.search ?? null
        )}, status=${JSON.stringify(query.status ?? null)}, sort=${
          query.sort
        }): ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  async getById(id: string): Promise<ReportDetail | null> {
    // Sub-resources (evidence/history/relatedReports) are served by their own
    // endpoints; getCore() below is what the controller actually calls for
    // GET /reports/:reportId. This full form is kept to satisfy the interface
    // used internally by resolve/dismiss's "before" snapshot.
    const core = await this.getCore(id);
    if (!core) return null;
    return { ...core, evidence: [], history: [], relatedReports: [] };
  }

  async getCore(id: string): Promise<ReportCore | null> {
    const row = await prisma.report.findUnique({ where: { id } });
    if (!row) return null;

    const moderatorIds = row.assignedTo ? [row.assignedTo] : [];
    // reportedUserId is the message-sender / comment-author on non-USER reports
    // (message/stream). For user reports the target IS the reported user, so
    // fall back to targetId — keeping the resolution logic uniform below.
    const reportedUserId =
      row.type === "user" ? row.targetId : (row.reportedUserId ?? null);
    const allIds = [
      ...new Set(
        [reportedUserId, row.reporterId, ...moderatorIds].filter(
          (v): v is string => v !== null
        )
      ),
    ];

    const [
      profiles,
      userIndexRows,
      moderatorNames,
      reportedPriorCount,
      reportedPriorActions,
      reporterFiledCount,
      reporterFalseCount,
      communityBriefs,
    ] = await Promise.all([
      userClient.adminGetProfilesByIds(allIds),
      allIds.length
        ? prisma.userIndex.findMany({
            where: { userId: { in: allIds } },
            select: { userId: true, status: true },
          })
        : Promise.resolve([]),
      adminUserRepository.findNamesByIds(moderatorIds),
      row.type === "user"
        ? prisma.report.count({
            where: {
              type: "user",
              targetId: row.targetId,
              id: { not: row.id },
            },
          })
        : Promise.resolve(0),
      row.type === "user"
        ? prisma.moderationAction.count({
            where: { targetType: "user", targetId: row.targetId },
          })
        : Promise.resolve(0),
      prisma.report.count({ where: { reporterId: row.reporterId } }),
      prisma.report.count({
        where: { reporterId: row.reporterId, dismissReason: "FALSE_REPORT" },
      }),
      row.communityId
        ? communityClient.adminGetCommunitiesByIds([row.communityId])
        : Promise.resolve(new Map<string, AdminCommunityBrief>()),
    ]);

    const ctx: EnrichmentContext = {
      profiles: new Map(profiles.map((p) => [p.userId, p])),
      statuses: new Map(
        userIndexRows.map((u) => [u.userId, u.status as AccountStatus])
      ),
      moderatorNames,
      communityNames: new Map(
        [...communityBriefs.values()].map((c) => [c.communityId, c.name])
      ),
    };

    const status = toReportStatus(row.status);
    const [reportedUser, reporterUser] = await Promise.all([
      reportedUserId
        ? toReportedProfile(
            reportedUserId,
            ctx,
            reportedPriorCount,
            reportedPriorActions
          )
        : Promise.resolve(null),
      toReporterProfile(
        row.reporterId,
        ctx,
        reporterFiledCount,
        reporterFalseCount
      ),
    ]);
    return {
      reportId: row.id,
      reportType: toReportType(row.reason),
      targetType: toTargetType(row.type),
      status,
      priority: toPriority(row.priority),
      reason: row.reason,
      reporterNote: row.details,
      communityId: row.communityId ?? null,
      communityName: row.communityId
        ? (ctx.communityNames.get(row.communityId) ?? null)
        : null,
      // Not carried by AdminReportIngestPayload — see file-header note.
      sourceService: "unknown",
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
      resolvedAt: row.resolvedAt?.getTime() ?? null,
      slaDueAt: null,
      reportedUser,
      reporterUser,
      target: { type: toTargetType(row.type), id: row.targetId },
      availableActions: toAvailableActions(status),
      resolution: row.resolution as ResolutionType | null,
      dismissReason: row.dismissReason as DismissReason | null,
      decisionNote: row.decisionNote,
      moderator: toModeratorRef(row.assignedTo, ctx),
    };
  }

  // Evidence storage doesn't exist yet (no ReportEvidence model) — real, empty page.
  listEvidence(
    _id: string,
    query: ListReportEvidenceQuery
  ): Promise<Paginated<EvidenceItem>> {
    return Promise.resolve(this.emptyPage(query));
  }

  async listHistory(
    id: string,
    query: ListReportHistoryQuery
  ): Promise<Paginated<HistoryItem>> {
    const skip = (query.page - 1) * query.limit;
    const { total, rows } = await moderationActionRepository.listByReportId(
      id,
      skip,
      query.limit
    );
    const actorIds = [...new Set(rows.map((r) => r.actorId))];
    const names = await adminUserRepository.findNamesByIds(actorIds);

    const data: HistoryItem[] = rows.map((r) => ({
      id: r.id,
      action: r.type,
      actorType: "ADMIN",
      actorId: r.actorId,
      actorName: names.get(r.actorId) ?? r.actorId,
      at: r.createdAt.getTime(),
      note:
        r.metadata && typeof r.metadata === "object" && "note" in r.metadata
          ? ((r.metadata as { note: string | null }).note ?? null)
          : null,
    }));

    return { data, pagination: this.offsetMeta(query, total, data.length) };
  }

  // No duplicate-detection query implemented yet — real, empty page.
  listRelated(
    _id: string,
    query: ListReportRelatedQuery
  ): Promise<Paginated<RelatedReport>> {
    return Promise.resolve(this.emptyPage(query));
  }

  async resolve(
    id: string,
    input: ResolveInput,
    actor: ActorRef
  ): Promise<ResolveResult> {
    const before = await prisma.report.findUnique({ where: { id } });
    if (!before) throw new NotFoundError("REPORT_NOT_FOUND");
    if (CLOSED_DB_STATUSES.has(before.status)) {
      throw new ConflictError("REPORT_ALREADY_RESOLVED");
    }

    const resolvedAt = new Date(actor.at);
    await prisma.$transaction(async (tx) => {
      await tx.report.update({
        where: { id },
        data: {
          status: "resolved",
          resolution: input.resolution,
          dismissReason: null,
          decisionNote: input.note ?? null,
          resolvedAt,
          assignedTo: actor.moderator.id,
        },
      });
      await moderationActionRepository.create(
        {
          actorId: actor.moderator.id,
          type: "report_resolved",
          targetType: before.type,
          targetId: before.targetId,
          reason: input.resolution,
          metadata: {
            note: input.note ?? null,
            actionOnReportedUser: input.actionOnReportedUser,
          },
          reportId: id,
        },
        tx
      );
    });

    return {
      reportId: id,
      status: "RESOLVED",
      resolution: input.resolution,
      resolvedAt: actor.at,
      moderator: actor.moderator,
      appliedActions: buildAppliedActionsFor(before.targetId, input, actor),
    };
  }

  async dismiss(
    id: string,
    input: DismissInput,
    actor: ActorRef
  ): Promise<DismissResult> {
    const before = await prisma.report.findUnique({ where: { id } });
    if (!before) throw new NotFoundError("REPORT_NOT_FOUND");
    if (CLOSED_DB_STATUSES.has(before.status)) {
      throw new ConflictError("REPORT_ALREADY_RESOLVED");
    }

    const resolvedAt = new Date(actor.at);
    await prisma.$transaction(async (tx) => {
      await tx.report.update({
        where: { id },
        data: {
          status: "dismissed",
          dismissReason: input.reason,
          resolution: null,
          decisionNote: input.note ?? null,
          resolvedAt,
          assignedTo: actor.moderator.id,
        },
      });
      await moderationActionRepository.create(
        {
          actorId: actor.moderator.id,
          type: "report_dismissed",
          targetType: before.type,
          targetId: before.targetId,
          reason: input.reason,
          // flagFalseReport is captured in the audit log `after`; it is not
          // persisted on the report itself (no reporter-reputation store yet).
          metadata: {
            note: input.note ?? null,
            flagFalseReport: input.flagFalseReport ?? false,
          },
          reportId: id,
        },
        tx
      );
    });

    return {
      reportId: id,
      status: "DISMISSED",
      dismissReason: input.reason,
      resolvedAt: actor.at,
      moderator: actor.moderator,
    };
  }

  async bulkResolve(
    ids: string[],
    input: ResolveInput,
    actor: ActorRef
  ): Promise<BulkResult> {
    return runBulkOp(ids, (id) => this.resolve(id, input, actor));
  }

  async bulkDismiss(
    ids: string[],
    input: DismissInput,
    actor: ActorRef
  ): Promise<BulkResult> {
    return runBulkOp(ids, (id) => this.dismiss(id, input, actor));
  }

  // -------------------------------------------------------------------------
  // Internals.
  // -------------------------------------------------------------------------
  private async buildWhere(
    query: ListReportsQuery
  ): Promise<Prisma.ReportWhereInput> {
    const and: Prisma.ReportWhereInput[] = [];
    if (query.status?.length) {
      and.push({
        status: { in: query.status.map((s) => STATUS_TO_DB_STATUS[s]) },
      });
    }
    if (query.targetType) {
      const dbType = TARGET_TYPE_TO_DB_TYPE[query.targetType];
      if (dbType) and.push({ type: dbType });
    }
    if (query.assignedTo) {
      and.push({
        assignedTo: query.assignedTo === "unassigned" ? null : query.assignedTo,
      });
    }
    if (query.communityId) {
      and.push({ communityId: query.communityId });
    }
    if (query.dateFrom) {
      and.push({
        createdAt: { gte: new Date(`${query.dateFrom}T00:00:00.000Z`) },
      });
    }
    if (query.dateTo) {
      and.push({
        createdAt: { lte: new Date(`${query.dateTo}T23:59:59.999Z`) },
      });
    }
    if (query.reportType?.length) {
      and.push(reportTypeClause(query.reportType));
    }
    if (query.search) {
      and.push(await this.buildSearchClause(query.search));
    }
    return and.length ? { AND: and } : {};
  }

  /**
   * Free-text search across fields that don't all live on the `Report` row
   * itself. `reason`/`details`/`id` are matched locally. Reported-user
   * name/username/email needs two extra lookups because the data is split
   * across services: username + email are mirrored locally on `UserIndex`
   * (admin_db, same DB as Report — a plain query, no round-trip), while
   * first/last/full name only exist in user-service's `UserProfile` — one
   * batched gRPC call (`AdminSearchProfileIds`) resolves those to userIds.
   * Community name similarly needs one batched gRPC call to community-service
   * (`AdminSearchCommunityIds`). All three run in parallel — ONE extra
   * round-trip per source per list() call, never per-row (no N+1). Report
   * status is matched by comparing the search term against the human-readable
   * status labels and mapping back to the stored db value.
   */
  private async buildSearchClause(
    search: string
  ): Promise<Prisma.ReportWhereInput> {
    const term = search.trim();
    if (!term) return {};

    const [profileUserIds, communityIds, localUserIndexRows] =
      await Promise.all([
        userClient.adminSearchProfileIds(term),
        communityClient.adminSearchCommunityIds(term),
        prisma.userIndex.findMany({
          where: {
            OR: [
              { username: { contains: term, mode: "insensitive" } },
              { email: { contains: term, mode: "insensitive" } },
            ],
          },
          select: { userId: true },
          take: 500,
        }),
      ]);

    const matchedUserIds = [
      ...new Set([
        ...profileUserIds,
        ...localUserIndexRows.map((r) => r.userId),
      ]),
    ];
    const matchedDbStatuses = matchReportStatusLabels(term);

    const or: Prisma.ReportWhereInput[] = [
      { reason: { contains: term, mode: "insensitive" } },
      { details: { contains: term, mode: "insensitive" } },
    ];
    // Id/reference clauses. `Report.id` is a Postgres `uuid` column, so a
    // non-UUID term (e.g. "Vidd") passed as an equality would raise
    // `22P02 invalid input syntax for type uuid` and surface as a 500. Only
    // add these when the term is actually a UUID. reporterId/targetId/
    // communityId/sourceReportId are stored as plain strings but also carry
    // UUIDs — matching them here lets an admin paste any id and find its
    // report, without an extra lookup.
    if (isUuid(term)) {
      or.push(
        { id: { equals: term } },
        { reporterId: { equals: term } },
        { targetId: { equals: term } },
        { communityId: { equals: term } },
        { sourceReportId: { equals: term } }
      );
    }
    if (matchedUserIds.length) {
      or.push({ type: "user", targetId: { in: matchedUserIds } });
    }
    if (communityIds.length) {
      or.push({ communityId: { in: communityIds } });
    }
    if (matchedDbStatuses.length) {
      or.push({ status: { in: matchedDbStatuses } });
    }
    return { OR: or };
  }

  private buildOrderBy(sort: string): Prisma.ReportOrderByWithRelationInput[] {
    const { field, dir } = parseSortGeneric<ListSortField>(sort);
    const column = PRISMA_SORT_COLUMN[field];
    return [{ [column]: dir }, { id: dir }];
  }

  private async offsetPage(
    where: Prisma.ReportWhereInput,
    orderBy: Prisma.ReportOrderByWithRelationInput[],
    query: ListReportsQuery,
    cursorable: boolean
  ): Promise<Paginated<ReportListItem>> {
    const { page, limit } = query;
    const skip = (page - 1) * limit;

    const [total, rows] = await Promise.all([
      prisma.report.count({ where }),
      prisma.report.findMany({ where, orderBy, skip, take: limit }),
    ]);
    const ctx = await buildListEnrichment(rows);

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
    const hasNext = skip + rows.length < total;
    const last = rows[rows.length - 1];

    const pagination: PaginationMeta = {
      mode: "offset",
      page,
      limit,
      total,
      totalApprox: total,
      totalPages,
      hasNext,
      hasPrev: page > 1,
      nextCursor:
        cursorable && hasNext && last
          ? encodeCursor({
              createdAt: last.createdAt.getTime(),
              reportId: last.id,
            })
          : null,
    };
    return {
      data: await Promise.all(rows.map((r) => toReportListItem(r, ctx))),
      pagination,
    };
  }

  private async keysetPage(
    where: Prisma.ReportWhereInput,
    orderBy: Prisma.ReportOrderByWithRelationInput[],
    query: ListReportsQuery
  ): Promise<Paginated<ReportListItem>> {
    const { limit } = query;
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const { dir } = parseSortGeneric<ListSortField>(query.sort);

    let seekWhere = where;
    if (cursor) {
      const at = new Date(cursor.createdAt);
      const op = dir === "asc" ? "gt" : "lt";
      const cursorClause: Prisma.ReportWhereInput = {
        OR: [
          { createdAt: { [op]: at } },
          { createdAt: at, id: { [op]: cursor.reportId } },
        ],
      };
      const existing = where.AND
        ? Array.isArray(where.AND)
          ? where.AND
          : [where.AND]
        : [where];
      seekWhere = { AND: [...existing, cursorClause] };
    }

    const [total, rows] = await Promise.all([
      prisma.report.count({ where }),
      prisma.report.findMany({ where: seekWhere, orderBy, take: limit }),
    ]);
    const ctx = await buildListEnrichment(rows);

    const hasNext = rows.length === limit;
    const last = rows[rows.length - 1];

    const pagination: PaginationMeta = {
      mode: "keyset",
      page: 1,
      limit,
      total,
      totalApprox: total,
      totalPages: limit === 0 ? 0 : Math.ceil(total / limit),
      hasNext,
      hasPrev: cursor !== null,
      nextCursor:
        hasNext && last
          ? encodeCursor({
              createdAt: last.createdAt.getTime(),
              reportId: last.id,
            })
          : null,
    };
    return {
      data: await Promise.all(rows.map((r) => toReportListItem(r, ctx))),
      pagination,
    };
  }

  private emptyPage<T>(query: { page: number; limit: number }): Paginated<T> {
    return {
      data: [],
      pagination: {
        mode: "offset",
        page: query.page,
        limit: query.limit,
        total: 0,
        totalApprox: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: query.page > 1,
        nextCursor: null,
      },
    };
  }

  private offsetMeta(
    query: { page: number; limit: number },
    total: number,
    pageLen: number
  ): PaginationMeta {
    const { page, limit } = query;
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
    return {
      mode: "offset",
      page,
      limit,
      total,
      totalApprox: total,
      totalPages,
      hasNext: (page - 1) * limit + pageLen < total,
      hasPrev: page > 1,
      nextCursor: null,
    };
  }
}

/** Production singleton. `MockReportRepository` above stays for the smoke test. */
export const reportRepository: ReportRepository = new PrismaReportRepository();
