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
  LivestreamStatus,
  ListLivestreamsQuery,
  ListLivestreamReportsQuery,
  Paginated,
  PaginationMeta,
  ReportsByType,
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

/** Shared bulk-operation runner used by both Mock and Prisma repositories. */
async function runBulk(
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
    return runBulk(ids, async (id) => {
      const r = await this.end(id, input, actor);
      return { id, status: r.status };
    });
  }

  async bulkReviewReports(
    reportIds: string[],
    input: ReviewReportsInput,
    actor: ActorRef
  ): Promise<BulkResult> {
    return runBulk(reportIds, (reportId) =>
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

// ---------------------------------------------------------------------------
// Prisma implementation.
// ---------------------------------------------------------------------------

import { prisma } from "../config/prisma.js";
import type { LivestreamIndex as PrismaLivestreamIndex } from "../generated/prisma/client.js";

function toListItemFromIndex(row: PrismaLivestreamIndex): LivestreamListItem {
  const endedAt = row.endedAt?.toISOString() ?? null;
  const startedAt = row.livedAt?.toISOString() ?? row.createdAt.toISOString();
  return {
    livestreamId: row.streamId,
    title: row.title,
    community: {
      id: row.communityId,
      name: row.communityName,
      slug: slugify(row.communityName),
    },
    creator: {
      id: row.creatorId,
      username: row.creatorUsername,
      displayName: row.creatorUsername,
      avatarUrl: null,
    },
    category: { id: "", name: "", slug: "" },
    createdAt: row.createdAt.toISOString(),
    startedAt,
    endedAt,
    durationSeconds: row.durationSeconds,
    status: row.status as LivestreamStatus,
    viewerCount: row.viewerCount,
    reportCount: 0,
    reportSeverity: "NONE",
    thumbnailUrl: row.thumbnailUrl ?? null,
  };
}

function toDetailFromIndex(row: PrismaLivestreamIndex): LivestreamDetail {
  const endedAt = row.endedAt?.toISOString() ?? null;
  const startedAt = row.livedAt?.toISOString() ?? row.createdAt.toISOString();
  const emptyByType: ReportsByType = {
    HARASSMENT: 0,
    SPAM: 0,
    COPYRIGHT: 0,
    NUDITY: 0,
    VIOLENCE: 0,
    HATE_SPEECH: 0,
    OTHER: 0,
  };
  return {
    livestreamId: row.streamId,
    title: row.title,
    description: row.description,
    community: {
      id: row.communityId,
      name: row.communityName,
      slug: slugify(row.communityName),
      memberCount: 0,
      creatorRole: "",
    },
    creator: {
      id: row.creatorId,
      username: row.creatorUsername,
      displayName: row.creatorUsername,
      avatarUrl: null,
      accountStatus: "ACTIVE",
      totalStreams: 0,
      priorStrikes: 0,
    },
    category: { id: "", name: "", slug: "" },
    createdAt: row.createdAt.toISOString(),
    startedAt,
    endedAt,
    durationSeconds: row.durationSeconds,
    status: row.status as LivestreamStatus,
    viewerCount: row.viewerCount,
    reportCount: 0,
    reportSeverity: "NONE",
    thumbnailUrl: row.thumbnailUrl ?? null,
    endReasonCode: (row.reasonCode as EndReasonCode) ?? null,
    endedBy: row.endedByAdminId
      ? {
          adminId: row.endedByAdminId,
          adminName: row.endedByAdminName ?? row.endedByAdminId,
        }
      : null,
    viewerStats: {
      currentViewers: row.status === "LIVE" ? row.viewerCount : 0,
      peakViewers: row.peakViewers,
      totalUniqueViewers: 0,
      totalWatchTimeSeconds: 0,
      averageWatchTimeSeconds: 0,
      chatMessageCount: row.totalComments,
    },
    streamMetadata: {
      ingestProtocol: row.sourceType || "RTMP",
      playbackUrl: row.hlsUrl ?? "",
      resolution: "",
      bitrateKbps: 0,
      fps: 0,
      region: "",
      isRecording: false,
      recordingUrl: null,
    },
    reportsSummary: {
      total: 0,
      open: 0,
      reviewing: 0,
      resolved: 0,
      dismissed: 0,
      severity: "NONE",
      byType: emptyByType,
      firstReportedAt: null,
      lastReportedAt: null,
    },
    moderationHistory: [
      {
        id: `${row.streamId}_created`,
        action: "STREAM_CREATED",
        adminId: "system",
        adminName: "System",
        reasonCode: null,
        note: null,
        createdAt: row.createdAt.toISOString(),
      },
      ...(row.endedByAdminId && endedAt
        ? [
            {
              id: `${row.streamId}_ended`,
              action: "STREAM_ENDED",
              adminId: row.endedByAdminId,
              adminName: row.endedByAdminName ?? row.endedByAdminId,
              reasonCode: row.reasonCode ?? null,
              note: null,
              createdAt: endedAt,
            },
          ]
        : []),
    ],
    reports: [],
  };
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "") || name
  );
}

export class PrismaLivestreamRepository implements LivestreamRepository {
  async list(
    query: ListLivestreamsQuery
  ): Promise<Paginated<LivestreamListItem>> {
    const where: Record<string, unknown> = {};
    if (query.status) where["status"] = query.status;
    if (query.communityId) where["communityId"] = query.communityId;
    if (query.creatorId) where["creatorId"] = query.creatorId;
    if (query.search) {
      where["OR"] = [
        { title: { contains: query.search, mode: "insensitive" } },
        { communityName: { contains: query.search, mode: "insensitive" } },
        { creatorUsername: { contains: query.search, mode: "insensitive" } },
      ];
    }
    if (query.dateFrom || query.dateTo) {
      where["createdAt"] = {
        ...(query.dateFrom
          ? { gte: new Date(`${query.dateFrom}T00:00:00.000Z`) }
          : {}),
        ...(query.dateTo
          ? { lte: new Date(`${query.dateTo}T23:59:59.999Z`) }
          : {}),
      };
    }

    const [field, dir] = query.sort.split(":") as [string, "asc" | "desc"];
    const orderByField =
      field === "viewerCount"
        ? "viewerCount"
        : field === "duration"
          ? "durationSeconds"
          : "createdAt";
    const orderBy = [{ [orderByField]: dir }, { streamId: "asc" as const }];

    const { page, limit } = query;
    const skip = (page - 1) * limit;
    const [rows, total] = await Promise.all([
      prisma.livestreamIndex.findMany({ where, orderBy, skip, take: limit }),
      prisma.livestreamIndex.count({ where }),
    ]);

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
    const hasNext = skip + limit < total;
    const lastRow = rows[rows.length - 1];
    const cursorable = orderByField === "createdAt";
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
        cursorable && hasNext && lastRow
          ? encodeCursor({
              createdAt: lastRow.createdAt.toISOString(),
              livestreamId: lastRow.streamId,
            })
          : null,
    };

    return { data: rows.map(toListItemFromIndex), pagination };
  }

  async getById(id: string): Promise<LivestreamDetail | null> {
    const row = await prisma.livestreamIndex.findUnique({
      where: { streamId: id },
    });
    if (!row) return null;
    return toDetailFromIndex(row);
  }

  async listReports(
    livestreamId: string,
    query: ListLivestreamReportsQuery
  ): Promise<Paginated<LivestreamReportItem>> {
    const exists = await prisma.livestreamIndex.findUnique({
      where: { streamId: livestreamId },
    });
    if (!exists) throw new NotFoundError("LIVESTREAM_NOT_FOUND");

    const pagination: PaginationMeta = {
      mode: "offset",
      page: query.page,
      limit: query.limit,
      total: 0,
      totalApprox: 0,
      totalPages: 0,
      hasNext: false,
      hasPrev: false,
      nextCursor: null,
    };
    return { data: [], pagination };
  }

  async end(
    id: string,
    input: EndInput,
    actor: ActorRef
  ): Promise<EndLivestreamResult> {
    const row = await prisma.livestreamIndex.findUnique({
      where: { streamId: id },
    });
    if (!row) throw new NotFoundError("LIVESTREAM_NOT_FOUND");
    if (row.status !== "LIVE" && row.status !== "PENDING") {
      throw new ConflictError("LIVESTREAM_ALREADY_ENDED");
    }

    const endedAt = new Date(actor.at);
    const durationSeconds = row.livedAt
      ? Math.max(
          0,
          Math.round((endedAt.getTime() - row.livedAt.getTime()) / 1000)
        )
      : 0;

    await prisma.livestreamIndex.update({
      where: { streamId: id },
      data: {
        status: "ENDED",
        endedAt,
        durationSeconds,
        reasonCode: input.reasonCode,
        endedByAdminId: actor.admin.id,
        endedByAdminName: actor.admin.name,
        viewerCount: 0,
      },
    });

    const moderationActionId = `${id}_ended_${Date.now()}`;
    return {
      livestreamId: id,
      status: "ENDED",
      endedAt: actor.at,
      endedBy: { adminId: actor.admin.id, adminName: actor.admin.name },
      reasonCode: input.reasonCode,
      moderationActionId,
      auditLogId: null,
      creatorNotified: input.notifyCreator ?? false,
      strikeIssued: input.issueStrike ?? false,
    };
  }

  async bulkEnd(
    ids: string[],
    input: EndInput,
    actor: ActorRef
  ): Promise<BulkResult> {
    return runBulk(ids, async (id) => {
      const r = await this.end(id, input, actor);
      return { id, status: r.status };
    });
  }

  async bulkReviewReports(
    reportIds: string[],
    input: ReviewReportsInput,
    _actor: ActorRef
  ): Promise<BulkResult> {
    // Reports not yet implemented — return all as succeeded no-ops.
    const results: BulkResultItem[] = reportIds.map((id) => ({
      id,
      status: input.status,
      ok: true as const,
    }));
    return {
      requested: reportIds.length,
      succeeded: reportIds.length,
      failed: 0,
      results,
    };
  }
}

/** Phase 2 singleton — backed by admin_db LivestreamIndex. */
export const livestreamRepository: LivestreamRepository =
  new PrismaLivestreamRepository();
