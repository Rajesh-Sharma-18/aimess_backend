import { ConflictError, NotFoundError } from "@aimess/errors";

import {
  decodeCursor as decodeCursorRaw,
  encodeCursor as encodeCursorGeneric,
  parseSort as parseSortGeneric,
} from "../lib/keyset-cursor.js";
import { reportFixtures } from "./__fixtures__/reports.fixture.js";
import type {
  ActionOnReportedUser,
  BulkResult,
  BulkResultItem,
  DismissReason,
  DismissResult,
  ModeratorRef,
  Paginated,
  PaginationMeta,
  ReportDetail,
  ReportListItem,
  ReportStatus,
  ResolutionType,
  ResolveResult,
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
  /** ISO timestamp the service captured for this mutation. */
  at: string;
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
type Cursor = { createdAt: string; reportId: string };

const CURSOR_KEYS = ["createdAt", "reportId"] as const;

function encodeCursor(c: Cursor): string {
  return encodeCursorGeneric(c);
}

function decodeCursor(raw: string): Cursor | null {
  return decodeCursorRaw<Cursor>(raw, CURSOR_KEYS);
}

/** Project a full detail row to the list-table shape. */
function toListItem(r: ReportDetail): ReportListItem {
  return {
    reportId: r.reportId,
    reportedUser: {
      id: r.reportedUser.id,
      username: r.reportedUser.username,
      displayName: r.reportedUser.displayName,
      avatarUrl: r.reportedUser.avatarUrl,
      accountStatus: r.reportedUser.accountStatus,
    },
    reporterUser: {
      id: r.reporterUser.id,
      username: r.reporterUser.username,
      displayName: r.reporterUser.displayName,
      avatarUrl: r.reporterUser.avatarUrl,
    },
    reportType: r.reportType,
    targetType: r.targetType,
    status: r.status,
    priority: r.priority,
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
    moderator: r.moderator ?? null,
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
    let effectiveUntil: string | null = null;
    if (input.actionOnReportedUser === "SUSPEND_7D") {
      effectiveUntil = this.addDays(actor.at, 7);
    } else if (input.actionOnReportedUser === "SUSPEND_30D") {
      effectiveUntil = this.addDays(actor.at, 30);
    }
    return [
      {
        type: input.actionOnReportedUser,
        targetUserId: row.reportedUser.id,
        effectiveUntil,
      },
    ];
  }

  private addDays(iso: string, days: number): string {
    const d = new Date(iso);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString();
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
      if (query.assignedTo) {
        if (query.assignedTo === "unassigned") {
          if (r.moderator) return false;
        } else if ((r.moderator?.id ?? null) !== query.assignedTo) {
          return false;
        }
      }
      const created = Date.parse(r.createdAt);
      if (from !== null && created < from) return false;
      if (to !== null && created > to) return false;
      if (search) {
        const haystack = [
          r.reportId,
          r.reportedUser.username,
          r.reportedUser.displayName,
          r.reporterUser.username,
          r.reporterUser.displayName,
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

/** Phase 1 singleton. Swap to `new PrismaReportRepository()` in Phase 2. */
export const reportRepository: ReportRepository = new MockReportRepository();
