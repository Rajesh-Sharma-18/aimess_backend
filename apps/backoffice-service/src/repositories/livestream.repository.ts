import { ConflictError, NotFoundError } from "@aimess/errors";

import { livestreamFixtures } from "./__fixtures__/livestreams.fixture.js";
import type {
  BulkResult,
  BulkResultItem,
  EndLivestreamResult,
  EndReasonCode,
  LivestreamDetail,
  LivestreamListItem,
  LivestreamReportItem,
  LivestreamReportStatus,
  ListLivestreamsQuery,
  ListLivestreamReportsQuery,
  Paginated,
  PaginationMeta,
} from "../types/livestream.types.js";

/**
 * Repository contract for the Livestream Management read+moderation model.
 *
 * Phase 1 ships {@link MockLivestreamRepository} (in-memory fixtures). Phase 2
 * will add a `PrismaLivestreamRepository implements LivestreamRepository` backed
 * by `admin_db` + OSSRS telemetry — swapping the singleton below is the ENTIRE
 * migration; controllers/routes/validators and the response shapes stay
 * untouched.
 */
export interface LivestreamRepository {
  list(query: ListLivestreamsQuery): Promise<Paginated<LivestreamListItem>>;
  getById(id: string): Promise<LivestreamDetail | null>;
  listReports(
    livestreamId: string,
    query: ListLivestreamReportsQuery
  ): Promise<Paginated<LivestreamReportItem>>;
  end(
    id: string,
    input: EndInput,
    actor: ActorRef
  ): Promise<EndLivestreamResult>;
  bulkEnd(ids: string[], input: EndInput, actor: ActorRef): Promise<BulkResult>;
  bulkReviewReports(
    reportIds: string[],
    input: ReviewReportsInput,
    actor: ActorRef
  ): Promise<BulkResult>;
}

/** Moderation payload the service forwards from the validated body. */
export type EndInput = {
  reasonCode: EndReasonCode;
  note?: string;
  notifyCreator?: boolean;
  issueStrike?: boolean;
  takedownRecording?: boolean;
};

export type ReviewReportsInput = {
  status: Extract<
    LivestreamReportStatus,
    "REVIEWING" | "RESOLVED" | "DISMISSED"
  >;
  note?: string;
};

/** The acting admin (subset of req.admin) + a precomputed timestamp. */
export type ActorRef = {
  admin: { id: string; name: string };
  /** ISO timestamp the service captured for this mutation. */
  at: string;
};

// ---------------------------------------------------------------------------
// Helpers (pure).
// ---------------------------------------------------------------------------
type SortField = "createdAt" | "viewerCount" | "reportCount" | "duration";

function parseSort(sort: string): { field: SortField; dir: 1 | -1 } {
  const [field, dir] = sort.split(":") as [SortField, "asc" | "desc"];
  return { field, dir: dir === "asc" ? 1 : -1 };
}

/** Opaque keyset cursor over (createdAt, livestreamId). */
type Cursor = { createdAt: string; livestreamId: string };

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8")
    ) as Cursor;
    if (
      typeof parsed.createdAt === "string" &&
      typeof parsed.livestreamId === "string"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/** Project a full detail row to the list-table shape. */
function toListItem(r: LivestreamDetail): LivestreamListItem {
  return {
    livestreamId: r.livestreamId,
    title: r.title,
    community: {
      id: r.community.id,
      name: r.community.name,
      slug: r.community.slug,
    },
    creator: {
      id: r.creator.id,
      username: r.creator.username,
      displayName: r.creator.displayName,
      avatarUrl: r.creator.avatarUrl,
    },
    category: r.category,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    durationSeconds: r.durationSeconds,
    status: r.status,
    viewerCount: r.viewerCount,
    reportCount: r.reportCount,
    reportSeverity: r.reportSeverity,
    thumbnailUrl: r.thumbnailUrl,
  };
}

// ---------------------------------------------------------------------------
// Mock implementation.
// ---------------------------------------------------------------------------
export class MockLivestreamRepository implements LivestreamRepository {
  /** Mutable in-memory store — cloned from fixtures so end()/review persist. */
  private readonly rows: LivestreamDetail[];

  constructor(seed: LivestreamDetail[] = livestreamFixtures) {
    // Deep clone so mutations during dev don't corrupt the imported module.
    this.rows = seed.map((r) => structuredClone(r));
  }

  list(query: ListLivestreamsQuery): Promise<Paginated<LivestreamListItem>> {
    const filtered = this.applyFilters(query);
    const sorted = this.applySort(filtered, query.sort);

    if (query.cursor) {
      return Promise.resolve(this.keysetPage(sorted, query));
    }
    return Promise.resolve(this.offsetPage(sorted, query));
  }

  getById(id: string): Promise<LivestreamDetail | null> {
    const row = this.rows.find((r) => r.livestreamId === id) ?? null;
    return Promise.resolve(row ? structuredClone(row) : null);
  }

  listReports(
    livestreamId: string,
    query: ListLivestreamReportsQuery
  ): Promise<Paginated<LivestreamReportItem>> {
    const row = this.rows.find((r) => r.livestreamId === livestreamId);
    if (!row) throw new NotFoundError("LIVESTREAM_NOT_FOUND");

    const statusFilter = query.status ?? null;
    const typeFilter = query.reportType ?? null;
    const filtered = row.reports.filter((rep) => {
      if (statusFilter && rep.status !== statusFilter) return false;
      if (typeFilter && rep.reportType !== typeFilter) return false;
      return true;
    });
    const sorted = this.applyReportSort(filtered, query.sort);

    return Promise.resolve(this.offsetReportPage(sorted, query));
  }

  end(
    id: string,
    input: EndInput,
    actor: ActorRef
  ): Promise<EndLivestreamResult> {
    const row = this.requireLive(id);

    row.status = "ENDED";
    row.endedAt = actor.at;
    row.endedBy = { adminId: actor.admin.id, adminName: actor.admin.name };
    row.endReasonCode = input.reasonCode;
    // currentViewers drop to zero the moment the stream is forced down.
    row.viewerStats.currentViewers = 0;
    // Recompute duration now that we have a real end timestamp.
    row.durationSeconds = computeDuration(row, actor.at);
    if (input.takedownRecording) {
      row.streamMetadata.isRecording = false;
      row.streamMetadata.recordingUrl = null;
    }
    if (input.issueStrike) {
      row.creator.priorStrikes += 1;
    }

    const moderationActionId = `lsh_${row.livestreamId}_${row.moderationHistory.length + 1}`;
    row.moderationHistory.push({
      id: moderationActionId,
      action: "STREAM_ENDED",
      adminId: actor.admin.id,
      adminName: actor.admin.name,
      reasonCode: input.reasonCode,
      note: input.note ?? null,
      createdAt: actor.at,
    });

    return Promise.resolve({
      livestreamId: row.livestreamId,
      status: "ENDED",
      endedAt: actor.at,
      endedBy: { adminId: actor.admin.id, adminName: actor.admin.name },
      reasonCode: input.reasonCode,
      moderationActionId,
      auditLogId: null,
      creatorNotified: input.notifyCreator ?? false,
      strikeIssued: input.issueStrike ?? false,
    });
  }

  async bulkEnd(
    ids: string[],
    input: EndInput,
    actor: ActorRef
  ): Promise<BulkResult> {
    return this.runBulk(ids, async (id) => {
      const r = await this.end(id, input, actor);
      return { id, status: r.status };
    });
  }

  async bulkReviewReports(
    reportIds: string[],
    input: ReviewReportsInput,
    actor: ActorRef
  ): Promise<BulkResult> {
    return this.runBulk(reportIds, (reportId) =>
      Promise.resolve(this.reviewReport(reportId, input, actor))
    );
  }

  // -------------------------------------------------------------------------
  // Internals.
  // -------------------------------------------------------------------------
  private requireLive(id: string): LivestreamDetail {
    const row = this.rows.find((r) => r.livestreamId === id);
    if (!row) throw new NotFoundError("LIVESTREAM_NOT_FOUND");
    if (row.status !== "LIVE") {
      throw new ConflictError("LIVESTREAM_ALREADY_ENDED");
    }
    return row;
  }

  /** Flip an embedded report (found across all streams) to the requested status. */
  private reviewReport(
    reportId: string,
    input: ReviewReportsInput,
    actor: ActorRef
  ): { id: string; status: string } {
    for (const row of this.rows) {
      const rep = row.reports.find((r) => r.reportId === reportId);
      if (!rep) continue;

      rep.status = input.status;
      if (input.status === "RESOLVED" || input.status === "DISMISSED") {
        rep.resolution = {
          action: input.status === "RESOLVED" ? "CONTENT_REMOVED" : "NO_ACTION",
          note: input.note ?? null,
          resolvedBy: actor.admin.name,
          resolvedAt: actor.at,
        };
      } else {
        // REVIEWING re-opens the decision.
        rep.resolution = null;
      }
      this.recomputeReportsSummary(row);
      return { id: reportId, status: input.status };
    }
    throw new NotFoundError("LIVESTREAM_REPORT_NOT_FOUND");
  }

  /** Recompute a stream's reportsSummary counters after a report flip. */
  private recomputeReportsSummary(row: LivestreamDetail): void {
    let open = 0;
    let reviewing = 0;
    let resolved = 0;
    let dismissed = 0;
    for (const rep of row.reports) {
      if (rep.status === "OPEN") open += 1;
      else if (rep.status === "REVIEWING") reviewing += 1;
      else if (rep.status === "RESOLVED") resolved += 1;
      else dismissed += 1;
    }
    row.reportsSummary.open = open;
    row.reportsSummary.reviewing = reviewing;
    row.reportsSummary.resolved = resolved;
    row.reportsSummary.dismissed = dismissed;
  }

  private async runBulk(
    ids: string[],
    op: (id: string) => Promise<{ id: string; status: string }>
  ): Promise<BulkResult> {
    const results: BulkResultItem[] = [];
    let succeeded = 0;
    let failed = 0;

    for (const id of ids) {
      try {
        const r = await op(id);
        results.push({ id, status: r.status, ok: true });
        succeeded += 1;
      } catch (err) {
        failed += 1;
        const code =
          err instanceof ConflictError
            ? "LIVESTREAM_ALREADY_ENDED"
            : err instanceof NotFoundError
              ? err.message
              : "BULK_ITEM_FAILED";
        const message =
          err instanceof Error ? err.message : "Unexpected bulk item error";
        results.push({ id, ok: false, error: { code, message } });
      }
    }

    return { requested: ids.length, succeeded, failed, results };
  }

  private applyFilters(query: ListLivestreamsQuery): LivestreamDetail[] {
    const search = query.search?.toLowerCase();
    const from = query.dateFrom
      ? Date.parse(`${query.dateFrom}T00:00:00.000Z`)
      : null;
    // dateTo is inclusive on the whole day.
    const to = query.dateTo
      ? Date.parse(`${query.dateTo}T23:59:59.999Z`)
      : null;

    return this.rows.filter((r) => {
      if (query.status && r.status !== query.status) return false;
      if (query.category && r.category.slug !== query.category) return false;
      if (query.communityId && r.community.id !== query.communityId)
        return false;
      if (query.creatorId && r.creator.id !== query.creatorId) return false;
      if (query.hasReports !== undefined) {
        const has = r.reportCount > 0;
        if (query.hasReports !== has) return false;
      }
      if (query.minReports !== undefined && r.reportCount < query.minReports) {
        return false;
      }
      const created = Date.parse(r.createdAt);
      if (from !== null && created < from) return false;
      if (to !== null && created > to) return false;
      if (search) {
        const haystack = [
          r.livestreamId,
          r.title,
          r.community.name,
          r.creator.displayName,
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
  }

  private applySort(
    rows: LivestreamDetail[],
    sort: string
  ): LivestreamDetail[] {
    const { field, dir } = parseSort(sort);
    return [...rows].sort((a, b) => {
      const cmp = compareBy(a, b, field);
      if (cmp !== 0) return cmp * dir;
      // Stable tiebreaker on livestreamId so keyset pagination is deterministic.
      if (a.livestreamId < b.livestreamId) return -1;
      if (a.livestreamId > b.livestreamId) return 1;
      return 0;
    });
  }

  private offsetPage(
    sorted: LivestreamDetail[],
    query: ListLivestreamsQuery
  ): Paginated<LivestreamListItem> {
    const { page, limit } = query;
    const total = sorted.length;
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
    const start = (page - 1) * limit;
    const slice = sorted.slice(start, start + limit);
    const hasNext = start + limit < total;

    const last = slice[slice.length - 1];
    // The cursor encodes {createdAt, livestreamId}; only emit it when the active
    // sort is createdAt, else the keyset path would mis-decode it against a
    // different ordering.
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
          ? encodeCursor({
              createdAt: last.createdAt,
              livestreamId: last.livestreamId,
            })
          : null,
    };
    return { data: slice.map(toListItem), pagination };
  }

  private keysetPage(
    sorted: LivestreamDetail[],
    query: ListLivestreamsQuery
  ): Paginated<LivestreamListItem> {
    const { limit } = query;
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;

    let startIdx = 0;
    if (cursor) {
      const idx = sorted.findIndex(
        (r) =>
          r.createdAt === cursor.createdAt &&
          r.livestreamId === cursor.livestreamId
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
          ? encodeCursor({
              createdAt: last.createdAt,
              livestreamId: last.livestreamId,
            })
          : null,
    };
    return { data: slice.map(toListItem), pagination };
  }

  private applyReportSort(
    rows: LivestreamReportItem[],
    sort: string
  ): LivestreamReportItem[] {
    // Reports sort on createdAt only (whitelist enforced by the validator).
    const dir = sort.endsWith(":asc") ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (a.createdAt < b.createdAt) return -1 * dir;
      if (a.createdAt > b.createdAt) return 1 * dir;
      if (a.reportId < b.reportId) return -1;
      if (a.reportId > b.reportId) return 1;
      return 0;
    });
  }

  private offsetReportPage(
    sorted: LivestreamReportItem[],
    query: ListLivestreamReportsQuery
  ): Paginated<LivestreamReportItem> {
    const { page, limit } = query;
    const total = sorted.length;
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
    const start = (page - 1) * limit;
    const slice = sorted.slice(start, start + limit);
    const hasNext = start + limit < total;

    const pagination: PaginationMeta = {
      mode: "offset",
      page,
      limit,
      total,
      totalApprox: total,
      totalPages,
      hasNext,
      hasPrev: page > 1,
      // Per-stream reports use offset pagination only; no keyset cursor here.
      nextCursor: null,
    };
    return { data: slice.map((r) => structuredClone(r)), pagination };
  }
}

/**
 * Duration of a stream in seconds.
 *  - LIVE → (reference "now" passed via `now`) − startedAt.
 *  - ENDED/CANCELLED → endedAt − startedAt.
 * Fixtures store `durationSeconds` directly so LIVE rows stay deterministic;
 * this is only invoked by `end()` once a real end timestamp exists.
 */
function computeDuration(row: LivestreamDetail, now: string): number {
  const start = Date.parse(row.startedAt);
  const end = row.endedAt ? Date.parse(row.endedAt) : Date.parse(now);
  return Math.max(0, Math.round((end - start) / 1000));
}

/** Compare two streams by a sortable field. */
function compareBy(
  a: LivestreamDetail,
  b: LivestreamDetail,
  field: SortField
): number {
  if (field === "createdAt") {
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  }
  const av =
    field === "viewerCount"
      ? a.viewerCount
      : field === "reportCount"
        ? a.reportCount
        : a.durationSeconds;
  const bv =
    field === "viewerCount"
      ? b.viewerCount
      : field === "reportCount"
        ? b.reportCount
        : b.durationSeconds;
  return av - bv;
}

/** Phase 1 singleton. Swap to `new PrismaLivestreamRepository()` in Phase 2. */
export const livestreamRepository: LivestreamRepository =
  new MockLivestreamRepository();
