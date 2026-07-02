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
  LivestreamUserItem,
  ListLivestreamsQuery,
  ListLivestreamReportsQuery,
  ListLivestreamUsersQuery,
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
  listUsers(
    livestreamId: string,
    query: ListLivestreamUsersQuery
  ): Promise<Paginated<LivestreamUserItem>>;
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

  listUsers(
    livestreamId: string,
    query: ListLivestreamUsersQuery
  ): Promise<Paginated<LivestreamUserItem>> {
    const row = this.rows.find((r) => r.livestreamId === livestreamId);
    if (!row) throw new NotFoundError("LIVESTREAM_NOT_FOUND");
    // Mock has no roster — return an empty page (the gRPC repo is the real impl).
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
    return Promise.resolve({ data: [], pagination });
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
// gRPC live-read implementation (source of truth).
//
// The admin Livestream Management screen reads streams LIVE from stream-service
// over gRPC and enriches each row with community/creator/category/avatars (from
// community + user gRPC) and report counts (from admin_db `Report`, type=stream).
// There is NO event-fed read-model to drift out of sync — this replaced the
// old PrismaLivestreamRepository that read the chronically-empty LivestreamIndex.
// ---------------------------------------------------------------------------

import { prisma } from "../config/prisma.js";
import { env } from "../config/env.js";
import { mediaUrlStrategy } from "../config/storage.js";
import { streamClient, type AdminStreamRow } from "../grpc/stream.client.js";
import {
  communityClient,
  type AdminCommunityBrief,
} from "../grpc/community.client.js";
import { userClient, type AdminProfileRecord } from "../grpc/user.client.js";
import type {
  LivestreamReportType,
  ReportSeverity,
  ReportsSummary,
} from "../types/livestream.types.js";

const STREAM_BUCKET = env.MINIO_BUCKET_STREAM;

// --- pure mappers ----------------------------------------------------------

/** stream-service PENDING ⇄ admin-facing SCHEDULED. */
function toAdminStatus(s: string): LivestreamStatus {
  if (s === "PENDING") return "SCHEDULED";
  if (s === "LIVE" || s === "ENDED" || s === "CANCELLED" || s === "SCHEDULED") {
    return s;
  }
  return s as LivestreamStatus;
}
function toStreamStatus(s: LivestreamStatus): string {
  return s === "SCHEDULED" ? "PENDING" : s;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "") || name
  );
}

function severityFromCount(n: number): ReportSeverity {
  if (n <= 0) return "NONE";
  if (n <= 2) return "LOW";
  if (n <= 5) return "MEDIUM";
  return "HIGH";
}

function displayNameOf(u?: AdminProfileRecord | null): string {
  if (!u) return "";
  const full = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return full || u.username;
}

const REPORT_TYPE_SET = new Set<LivestreamReportType>([
  "HARASSMENT",
  "SPAM",
  "COPYRIGHT",
  "NUDITY",
  "VIOLENCE",
  "HATE_SPEECH",
  "OTHER",
]);
function toReportType(reason: string): LivestreamReportType {
  const up = (reason || "").toUpperCase().replace(/\s+/g, "_");
  return REPORT_TYPE_SET.has(up as LivestreamReportType)
    ? (up as LivestreamReportType)
    : "OTHER";
}
function toReportStatus(s: string): LivestreamReportStatus {
  const up = (s || "").toUpperCase();
  return up === "OPEN" ||
    up === "REVIEWING" ||
    up === "RESOLVED" ||
    up === "DISMISSED"
    ? (up as LivestreamReportStatus)
    : "OPEN";
}

function unique(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))];
}

function offsetMeta(
  page: number,
  limit: number,
  total: number
): PaginationMeta {
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  return {
    mode: "offset",
    page,
    limit,
    total,
    totalApprox: total,
    totalPages,
    hasNext: page * limit < total,
    hasPrev: page > 1,
    nextCursor: null,
  };
}

function emptyListPage(
  query: ListLivestreamsQuery
): Paginated<LivestreamListItem> {
  return { data: [], pagination: offsetMeta(query.page, query.limit, 0) };
}

async function resolveThumb(key: string | null): Promise<string | null> {
  if (!key) return null;
  try {
    const r = await mediaUrlStrategy.resolveDownloadUrl(STREAM_BUCKET, key);
    return r.url;
  } catch {
    return null;
  }
}

// --- search/filter resolution (push everything down to a paginated query) --

/** Community-name search → matching community ids (best-effort, degrades to []). */
async function resolveCommunityIdsByName(search: string): Promise<string[]> {
  try {
    const r = await communityClient.adminListCommunities({
      search,
      type: "",
      category: "",
      status: "",
      createdFrom: "",
      createdTo: "",
      sortField: "createdAt",
      sortDir: "desc",
      page: 1,
      limit: 50,
    });
    return r.communities.map((c) => c.communityId);
  } catch {
    return [];
  }
}

/** Creator-name search → matching creator ids (admin_db UserIndex). */
async function resolveCreatorIdsByName(search: string): Promise<string[]> {
  const rows = await prisma.userIndex.findMany({
    where: { username: { contains: search, mode: "insensitive" } },
    select: { userId: true },
    take: 50,
  });
  return rows.map((r) => r.userId);
}

/** Category filter → community ids in that category (matched by slug/id/name). */
async function resolveCommunityIdsByCategory(
  category: string
): Promise<string[]> {
  try {
    const r = await communityClient.adminListCommunities({
      search: "",
      type: "",
      category,
      status: "",
      createdFrom: "",
      createdTo: "",
      sortField: "createdAt",
      sortDir: "desc",
      page: 1,
      limit: 200,
    });
    return r.communities.map((c) => c.communityId);
  } catch {
    return [];
  }
}

/** Stream ids with at least `min` reports (admin_db Report, type=stream). */
async function resolveStreamIdsWithReports(min: number): Promise<string[]> {
  const rows = await prisma.report.groupBy({
    by: ["targetId"],
    where: { type: "stream" },
    _count: { _all: true },
  });
  return rows.filter((r) => r._count._all >= min).map((r) => r.targetId);
}

/** Report counts keyed by streamId (admin_db Report, type=stream). */
async function reportCountsByStream(
  streamIds: string[]
): Promise<Map<string, number>> {
  if (streamIds.length === 0) return new Map();
  const rows = await prisma.report.groupBy({
    by: ["targetId"],
    where: { type: "stream", targetId: { in: streamIds } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.targetId, r._count._all]));
}

type StreamReportRow = {
  id: string;
  reporterId: string;
  reason: string;
  details: string | null;
  status: string;
  createdAt: Date;
};

/** All admin_db Report rows for one stream (optionally status-filtered). */
async function streamReportRows(
  livestreamId: string,
  statusLower?: string
): Promise<StreamReportRow[]> {
  return prisma.report.findMany({
    where: {
      type: "stream",
      targetId: livestreamId,
      ...(statusLower ? { status: statusLower } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      reporterId: true,
      reason: true,
      details: true,
      status: true,
      createdAt: true,
    },
  });
}

/** Map Report rows → API report items, enriching the reporter from UserIndex. */
async function toReportItems(
  livestreamId: string,
  rows: StreamReportRow[]
): Promise<LivestreamReportItem[]> {
  const reporterIds = unique(rows.map((r) => r.reporterId));
  const idx = reporterIds.length
    ? await prisma.userIndex.findMany({
        where: { userId: { in: reporterIds } },
        select: { userId: true, username: true },
      })
    : [];
  const nameMap = new Map(idx.map((u) => [u.userId, u.username]));
  return rows.map((r) => {
    const username = nameMap.get(r.reporterId) ?? "";
    return {
      reportId: r.id,
      livestreamId,
      reporter: { id: r.reporterId, username, displayName: username },
      reportType: toReportType(r.reason),
      description: r.details ?? r.reason ?? "",
      status: toReportStatus(r.status),
      resolution: null,
      createdAt: r.createdAt.toISOString(),
      evidence: { timestampSeconds: null, clipUrl: null },
    };
  });
}

function buildReportsSummary(items: LivestreamReportItem[]): ReportsSummary {
  const byType: ReportsByType = {
    HARASSMENT: 0,
    SPAM: 0,
    COPYRIGHT: 0,
    NUDITY: 0,
    VIOLENCE: 0,
    HATE_SPEECH: 0,
    OTHER: 0,
  };
  let open = 0;
  let reviewing = 0;
  let resolved = 0;
  let dismissed = 0;
  let first: string | null = null;
  let last: string | null = null;
  for (const r of items) {
    byType[r.reportType] += 1;
    if (r.status === "OPEN") open += 1;
    else if (r.status === "REVIEWING") reviewing += 1;
    else if (r.status === "RESOLVED") resolved += 1;
    else dismissed += 1;
    if (!first || r.createdAt < first) first = r.createdAt;
    if (!last || r.createdAt > last) last = r.createdAt;
  }
  return {
    total: items.length,
    open,
    reviewing,
    resolved,
    dismissed,
    severity: severityFromCount(items.length),
    byType,
    firstReportedAt: first,
    lastReportedAt: last,
  };
}

async function toListItemEnriched(
  s: AdminStreamRow,
  c: AdminCommunityBrief | undefined,
  u: AdminProfileRecord | undefined,
  reportCount: number
): Promise<LivestreamListItem> {
  return {
    livestreamId: s.id,
    title: s.title,
    community: {
      id: s.communityId,
      name: c?.name ?? "",
      slug: slugify(c?.name ?? ""),
      avatarUrl: c?.avatarUrl || null,
    },
    creator: {
      id: s.creatorId,
      username: u?.username ?? "",
      displayName: displayNameOf(u),
      avatarUrl: u?.avatarUrl || null,
    },
    category: {
      id: c?.categoryId ?? "",
      name: c?.categoryName ?? "",
      slug: c?.categorySlug ?? "",
    },
    createdAt: new Date(s.createdAt).toISOString(),
    startedAt:
      s.livedAt > 0
        ? new Date(s.livedAt).toISOString()
        : new Date(s.createdAt).toISOString(),
    endedAt: s.endedAt > 0 ? new Date(s.endedAt).toISOString() : null,
    durationSeconds: s.durationSeconds,
    status: toAdminStatus(s.status),
    viewerCount: s.viewerCount,
    reportCount,
    reportSeverity: severityFromCount(reportCount),
    thumbnailUrl: await resolveThumb(s.thumbnail || null),
  };
}

export class GrpcLivestreamRepository implements LivestreamRepository {
  async list(
    query: ListLivestreamsQuery
  ): Promise<Paginated<LivestreamListItem>> {
    const [field, dir] = query.sort.split(":") as [string, "asc" | "desc"];

    // Name search → OR-ed community/creator id sets (title match is added in
    // stream-service). Resolution failures degrade to a title-only search.
    let searchCommunityIds: string[] | undefined;
    let searchCreatorIds: string[] | undefined;
    if (query.search) {
      [searchCommunityIds, searchCreatorIds] = await Promise.all([
        resolveCommunityIdsByName(query.search),
        resolveCreatorIdsByName(query.search),
      ]);
    }

    // Category filter → AND-restrict to that category's communities.
    let restrictCommunityIds: string[] | undefined;
    if (query.category) {
      restrictCommunityIds = await resolveCommunityIdsByCategory(
        query.category
      );
      if (restrictCommunityIds.length === 0) return emptyListPage(query);
    }

    // hasReports / minReports → AND-restrict to reported stream ids.
    let restrictStreamIds: string[] | undefined;
    const minReports =
      query.hasReports === true
        ? Math.max(1, query.minReports ?? 1)
        : query.minReports;
    if (minReports && minReports > 0) {
      restrictStreamIds = await resolveStreamIdsWithReports(minReports);
      if (restrictStreamIds.length === 0) return emptyListPage(query);
    }

    const sortField =
      field === "viewerCount"
        ? "viewerCount"
        : field === "duration"
          ? "duration"
          : "createdAt";

    const { streams, total } = await streamClient.adminListStreams({
      search: query.search,
      communityIds: searchCommunityIds,
      creatorIds: searchCreatorIds,
      restrictCommunityIds,
      restrictStreamIds,
      status: query.status ? toStreamStatus(query.status) : undefined,
      communityId: query.communityId,
      creatorId: query.creatorId,
      dateFrom: query.dateFrom
        ? Date.parse(`${query.dateFrom}T00:00:00.000Z`)
        : undefined,
      dateTo: query.dateTo
        ? Date.parse(`${query.dateTo}T23:59:59.999Z`)
        : undefined,
      sortField,
      sortDir: dir === "asc" ? "asc" : "desc",
      page: query.page,
      limit: query.limit,
    });

    const data = await this.enrichListItems(streams);
    return { data, pagination: offsetMeta(query.page, query.limit, total) };
  }

  private async enrichListItems(
    streams: AdminStreamRow[]
  ): Promise<LivestreamListItem[]> {
    if (streams.length === 0) return [];
    const communityIds = unique(streams.map((s) => s.communityId));
    const creatorIds = unique(streams.map((s) => s.creatorId));
    const streamIds = streams.map((s) => s.id);
    const [communityMap, creators, reportCounts] = await Promise.all([
      communityClient.adminGetCommunitiesByIds(communityIds),
      userClient.adminGetProfilesByIds(creatorIds),
      reportCountsByStream(streamIds),
    ]);
    const creatorMap = new Map(creators.map((c) => [c.userId, c]));
    return Promise.all(
      streams.map((s) =>
        toListItemEnriched(
          s,
          communityMap.get(s.communityId),
          creatorMap.get(s.creatorId),
          reportCounts.get(s.id) ?? 0
        )
      )
    );
  }

  async getById(id: string): Promise<LivestreamDetail | null> {
    const s = await streamClient.adminGetStream(id);
    if (!s) return null;
    const [communityMap, creators, reportRows] = await Promise.all([
      communityClient.adminGetCommunitiesByIds([s.communityId]),
      userClient.adminGetProfilesByIds([s.creatorId]),
      streamReportRows(id),
    ]);
    const c = communityMap.get(s.communityId);
    const u = creators[0];
    const thumbnailUrl = await resolveThumb(s.thumbnail || null);
    const reports = await toReportItems(id, reportRows);
    const summary = buildReportsSummary(reports);
    const createdAtIso = new Date(s.createdAt).toISOString();
    const endedAtIso = s.endedAt > 0 ? new Date(s.endedAt).toISOString() : null;

    return {
      livestreamId: s.id,
      title: s.title,
      description: s.description,
      community: {
        id: s.communityId,
        name: c?.name ?? "",
        slug: slugify(c?.name ?? ""),
        avatarUrl: c?.avatarUrl || null,
        memberCount: c?.memberCount ?? 0,
        creatorRole: "",
      },
      creator: {
        id: s.creatorId,
        username: u?.username ?? "",
        displayName: displayNameOf(u),
        avatarUrl: u?.avatarUrl || null,
        accountStatus: "ACTIVE",
        totalStreams: 0,
        priorStrikes: 0,
      },
      category: {
        id: c?.categoryId ?? "",
        name: c?.categoryName ?? "",
        slug: c?.categorySlug ?? "",
      },
      createdAt: createdAtIso,
      startedAt:
        s.livedAt > 0 ? new Date(s.livedAt).toISOString() : createdAtIso,
      endedAt: endedAtIso,
      durationSeconds: s.durationSeconds,
      status: toAdminStatus(s.status),
      viewerCount: s.viewerCount,
      reportCount: reports.length,
      reportSeverity: severityFromCount(reports.length),
      thumbnailUrl,
      endReasonCode: null,
      endedBy: null,
      viewerStats: {
        currentViewers: s.status === "LIVE" ? s.viewerCount : 0,
        peakViewers: s.peakViewers,
        totalUniqueViewers: 0,
        totalWatchTimeSeconds: 0,
        averageWatchTimeSeconds: 0,
        chatMessageCount: s.totalComments,
      },
      streamMetadata: {
        ingestProtocol: s.sourceType || "RTMP",
        playbackUrl: s.hlsUrl || "",
        resolution: "",
        bitrateKbps: 0,
        fps: 0,
        region: "",
        isRecording: false,
        recordingUrl: null,
      },
      reportsSummary: summary,
      moderationHistory: [
        {
          id: `${s.id}_created`,
          action: "STREAM_CREATED",
          adminId: "system",
          adminName: "System",
          reasonCode: null,
          note: null,
          createdAt: createdAtIso,
        },
        ...(endedAtIso
          ? [
              {
                id: `${s.id}_ended`,
                action: "STREAM_ENDED",
                adminId: "system",
                adminName: "System",
                reasonCode: null,
                note: null,
                createdAt: endedAtIso,
              },
            ]
          : []),
      ],
      reports,
    };
  }

  async listReports(
    livestreamId: string,
    query: ListLivestreamReportsQuery
  ): Promise<Paginated<LivestreamReportItem>> {
    const s = await streamClient.adminGetStream(livestreamId);
    if (!s) throw new NotFoundError("LIVESTREAM_NOT_FOUND");

    const rows = await streamReportRows(
      livestreamId,
      query.status ? query.status.toLowerCase() : undefined
    );
    let items = await toReportItems(livestreamId, rows);
    if (query.reportType) {
      items = items.filter((r) => r.reportType === query.reportType);
    }
    const dir = query.sort.endsWith(":asc") ? 1 : -1;
    items.sort((a, b) =>
      a.createdAt < b.createdAt
        ? -1 * dir
        : a.createdAt > b.createdAt
          ? 1 * dir
          : 0
    );
    const total = items.length;
    const start = (query.page - 1) * query.limit;
    const data = items.slice(start, start + query.limit);
    return { data, pagination: offsetMeta(query.page, query.limit, total) };
  }

  /**
   * The admin "Livestream User List" — the users who ACTUALLY watched this
   * stream, backed by the durable `LivestreamViewerSession` history persisted
   * by stream-service on join/leave (see `apps/stream-service`
   * `LivestreamViewerSessionRepository`). Replaces the earlier placeholder
   * that returned the stream's community roster instead of real viewers.
   */
  async listUsers(
    livestreamId: string,
    query: ListLivestreamUsersQuery
  ): Promise<Paginated<LivestreamUserItem>> {
    const s = await streamClient.adminGetStream(livestreamId);
    if (!s) throw new NotFoundError("LIVESTREAM_NOT_FOUND");

    const { sessions, total } = await streamClient.adminListViewerSessions({
      streamId: livestreamId,
      page: query.page,
      limit: query.limit,
      sortField: query.sortField,
      sortDir: query.sortDir,
    });

    const userIds = unique(sessions.map((v) => v.userId));
    const profiles = userIds.length
      ? await userClient.adminGetProfilesByIds(userIds)
      : [];
    const profileMap = new Map(profiles.map((p) => [p.userId, p]));

    const data: LivestreamUserItem[] = sessions.map((v) => {
      const p = profileMap.get(v.userId);
      return {
        userId: v.userId,
        username: p?.username ?? "",
        handle: p?.username ? `@${p.username}` : null,
        avatarUrl: p?.avatarUrl || null,
        joinedAt: new Date(v.joinedAt).toISOString(),
        // 0 from the wire means "still watching" (see AdminViewerSessionRow).
        leftAt: v.leftAt > 0 ? new Date(v.leftAt).toISOString() : null,
        watchDurationSeconds: v.watchDurationSeconds,
      };
    });

    return { data, pagination: offsetMeta(query.page, query.limit, total) };
  }

  async end(
    id: string,
    input: EndInput,
    actor: ActorRef
  ): Promise<EndLivestreamResult> {
    const row = await streamClient.adminGetStream(id);
    if (!row) throw new NotFoundError("LIVESTREAM_NOT_FOUND");
    if (row.status !== "LIVE" && row.status !== "PENDING") {
      throw new ConflictError("LIVESTREAM_ALREADY_ENDED");
    }
    const res = await streamClient.adminForceEnd(id, input.reasonCode);
    if (
      !res.success &&
      (res.status === "ENDED" || res.status === "CANCELLED")
    ) {
      throw new ConflictError("LIVESTREAM_ALREADY_ENDED");
    }
    return {
      livestreamId: id,
      status: "ENDED",
      endedAt: actor.at,
      endedBy: { adminId: actor.admin.id, adminName: actor.admin.name },
      reasonCode: input.reasonCode,
      moderationActionId: `${id}_ended_${Date.parse(actor.at)}`,
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
    // Livestream report state transitions are owned by the Reports & Moderation
    // module (admin_db Report). This slice records the action in the audit log
    // but does not mutate report rows — return all as succeeded no-ops.
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

/** Phase 2 singleton — gRPC live-read source of truth (no read-model). */
export const livestreamRepository: LivestreamRepository =
  new GrpcLivestreamRepository();
