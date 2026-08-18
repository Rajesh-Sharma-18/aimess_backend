import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";

import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/stream.proto"
);

export interface StreamStatsResult {
  found: boolean;
  status: string;
  viewerCount: number;
  peakViewers: number;
  totalViews: number;
  totalComments: number;
}

export interface AdminUpdateThumbnailResult {
  success: boolean;
}

export interface AdminForceEndResult {
  success: boolean;
  status: string;
}

export interface ForceEndStreamsByCreatorResult {
  ok: boolean;
  endedCount: number;
}

/** One viewer session row from AdminListViewerSessions. */
export interface AdminViewerSessionRow {
  userId: string;
  /** epoch ms. */
  joinedAt: number;
  /** epoch ms; 0 = still watching. */
  leftAt: number;
  watchDurationSeconds: number;
}

/** One livestream chat comment. `senderAvatar` is already a presigned URL. */
export interface StreamCommentRow {
  id: string;
  sentBy: string;
  senderName: string;
  senderAvatar: string;
  message: string;
  /** epoch ms. */
  createdAt: number;
}

export interface GetCommentsArgs {
  livestreamId: string;
  limit: number;
  /** Exclusive cursor — fetch comments older than this id. */
  before?: string;
}

export interface AdminListViewerSessionsArgs {
  streamId: string;
  page: number;
  limit: number;
  sortField?: "joinedAt" | "watchDurationSeconds";
  sortDir?: "asc" | "desc";
}

/** Filters forwarded to stream-service AdminListStreams (all optional). */
export interface AdminListStreamsArgs {
  search?: string;
  status?: string;
  communityId?: string;
  creatorId?: string;
  /** Search-resolved ids OR-ed with `search` (community/creator name match). */
  communityIds?: string[];
  creatorIds?: string[];
  /** AND-restrict to these communities (drives the category filter). */
  restrictCommunityIds?: string[];
  /** AND-restrict to these stream ids (drives the has-reports/min-reports filter). */
  restrictStreamIds?: string[];
  /** AND-exclude these stream ids (drives reportStatus=NOT_REPORTED). */
  excludeStreamIds?: string[];
  /** epoch ms inclusive; 0/undefined = no bound. */
  dateFrom?: number;
  dateTo?: number;
  /** Native stream-service columns only — cross-service fields are sorted in backoffice. */
  sortField?: "createdAt" | "viewerCount" | "duration" | "title" | "status";
  sortDir?: "asc" | "desc";
  page: number;
  limit: number;
}

/** A clean (coerced) admin stream row from stream-service. */
export interface AdminStreamRow {
  id: string;
  communityId: string;
  creatorId: string;
  title: string;
  description: string;
  /** Raw thumbnail object key ("" if none) — caller resolves to a URL. */
  thumbnail: string;
  sourceType: string;
  /** External playback source (URL / YOUTUBE modes); "" for SRS-ingested streams. */
  sourceUrl: string;
  status: string;
  hlsUrl: string;
  flvUrl: string;
  viewerCount: number;
  peakViewers: number;
  totalViews: number;
  totalComments: number;
  durationSeconds: number;
  /** epoch ms; 0 if never went live / not ended. */
  livedAt: number;
  endedAt: number;
  createdAt: number;
  /** Distinct-user count from LivestreamViewerSession — matches AdminListViewerSessions' total. */
  uniqueViewerCount: number;
  /** Last known quality snapshot — "" / 0 if none reported yet. */
  resolution: string;
  bitrateKbps: number;
  fps: number;
}

/** Raw wire row (longs arrive as strings under longs:String). */
interface RawAdminStreamRow {
  id: string;
  communityId: string;
  creatorId: string;
  title: string;
  description: string;
  thumbnail: string;
  sourceType: string;
  sourceUrl: string;
  status: string;
  hlsUrl: string;
  flvUrl: string;
  viewerCount: string | number;
  peakViewers: string | number;
  totalViews: string | number;
  totalComments: string | number;
  durationSeconds: string | number;
  livedAt: string | number;
  endedAt: string | number;
  createdAt: string | number;
  uniqueViewerCount: string | number;
  resolution: string;
  bitrateKbps: string | number;
  fps: string | number;
}

interface RawAdminListStreamsRes {
  streams: RawAdminStreamRow[];
  total: string | number;
}
interface RawAdminGetStreamRes {
  found: boolean;
  stream?: RawAdminStreamRow;
}

interface RawAdminViewerSessionRow {
  userId: string;
  joinedAt: string | number;
  leftAt: string | number;
  watchDurationSeconds: string | number;
}
interface RawAdminListViewerSessionsRes {
  sessions: RawAdminViewerSessionRow[];
  total: string | number;
}

function toAdminViewerSessionRow(
  r: RawAdminViewerSessionRow
): AdminViewerSessionRow {
  return {
    userId: r.userId,
    joinedAt: Number(r.joinedAt ?? 0),
    leftAt: Number(r.leftAt ?? 0),
    watchDurationSeconds: Number(r.watchDurationSeconds ?? 0),
  };
}

function toAdminStreamRow(r: RawAdminStreamRow): AdminStreamRow {
  return {
    id: r.id,
    communityId: r.communityId,
    creatorId: r.creatorId,
    title: r.title,
    description: r.description,
    thumbnail: r.thumbnail ?? "",
    sourceType: r.sourceType,
    sourceUrl: r.sourceUrl ?? "",
    status: r.status,
    hlsUrl: r.hlsUrl ?? "",
    flvUrl: r.flvUrl ?? "",
    viewerCount: Number(r.viewerCount ?? 0),
    peakViewers: Number(r.peakViewers ?? 0),
    totalViews: Number(r.totalViews ?? 0),
    totalComments: Number(r.totalComments ?? 0),
    durationSeconds: Number(r.durationSeconds ?? 0),
    livedAt: Number(r.livedAt ?? 0),
    endedAt: Number(r.endedAt ?? 0),
    createdAt: Number(r.createdAt ?? 0),
    uniqueViewerCount: Number(r.uniqueViewerCount ?? 0),
    resolution: r.resolution ?? "",
    bitrateKbps: Number(r.bitrateKbps ?? 0),
    fps: Number(r.fps ?? 0),
  };
}

const pkgDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
const ServiceCtor = (proto["stream"] as grpc.GrpcObject)[
  "StreamService"
] as grpc.ServiceClientConstructor;
const client = new ServiceCtor(
  env.STREAM_GRPC_URL,
  grpc.credentials.createInsecure()
);

const call = <TReq, TRes>(method: string, req: TReq) =>
  makeGrpcCall<TReq, TRes>(client, method, req);

const adminUpdateThumbnailBreaker = makeBreaker(
  "stream.adminUpdateThumbnail",
  (args: { streamId: string; thumbnail: string }) =>
    call<{ streamId: string; thumbnail: string }, AdminUpdateThumbnailResult>(
      "adminUpdateThumbnail",
      args
    ).then((r) => ({ success: r.success ?? false }))
);

const adminForceEndBreaker = makeBreaker(
  "stream.adminForceEnd",
  (args: { streamId: string; reason: string }) =>
    call<{ streamId: string; reason: string }, AdminForceEndResult>(
      "adminForceEnd",
      args
    ).then((r) => ({ success: r.success ?? false, status: r.status ?? "" }))
);

// Best-effort — a stream-service outage must not fail an account ban/suspend.
const forceEndByCreatorBreaker = makeBreaker(
  "stream.forceEndStreamsByCreator",
  (args: { creatorId: string; reason: string }) =>
    call<
      { creatorId: string; communityId: string; reason: string },
      { ok?: boolean; endedCount?: number }
    >("forceEndStreamsByCreator", {
      creatorId: args.creatorId,
      communityId: "", // unscoped — account-level action ends every stream everywhere
      reason: args.reason,
    }).then((r) => ({
      ok: r.ok ?? false,
      endedCount: Number(r.endedCount ?? 0),
    }))
);
forceEndByCreatorBreaker.fallback(() => ({ ok: false, endedCount: 0 }));

const getStreamStatsBreaker = makeBreaker(
  "stream.getStreamStats",
  (args: { streamId: string }) =>
    call<{ streamId: string }, StreamStatsResult>("getStreamStats", args).then(
      (r) => ({
        found: r.found ?? false,
        status: r.status ?? "",
        viewerCount: Number(r.viewerCount ?? 0),
        peakViewers: Number(r.peakViewers ?? 0),
        totalViews: Number(r.totalViews ?? 0),
        totalComments: Number(r.totalComments ?? 0),
      })
    )
);

const adminListStreamsBreaker = makeBreaker(
  "stream.adminListStreams",
  (args: AdminListStreamsArgs) =>
    call<Record<string, unknown>, RawAdminListStreamsRes>("adminListStreams", {
      search: args.search ?? "",
      status: args.status ?? "",
      communityId: args.communityId ?? "",
      creatorId: args.creatorId ?? "",
      communityIds: args.communityIds ?? [],
      creatorIds: args.creatorIds ?? [],
      restrictCommunityIds: args.restrictCommunityIds ?? [],
      restrictStreamIds: args.restrictStreamIds ?? [],
      excludeStreamIds: args.excludeStreamIds ?? [],
      dateFrom: args.dateFrom ?? 0,
      dateTo: args.dateTo ?? 0,
      sortField: args.sortField ?? "createdAt",
      sortDir: args.sortDir ?? "desc",
      page: args.page,
      limit: args.limit,
    }).then((r) => ({
      streams: (r.streams ?? []).map(toAdminStreamRow),
      total: Number(r.total ?? 0),
    }))
);

const adminGetStreamBreaker = makeBreaker(
  "stream.adminGetStream",
  (args: { streamId: string }) =>
    call<{ streamId: string }, RawAdminGetStreamRes>(
      "adminGetStream",
      args
    ).then((r) => ({
      found: r.found ?? false,
      stream: r.stream ? toAdminStreamRow(r.stream) : null,
    }))
);

const adminListViewerSessionsBreaker = makeBreaker(
  "stream.adminListViewerSessions",
  (args: AdminListViewerSessionsArgs) =>
    call<Record<string, unknown>, RawAdminListViewerSessionsRes>(
      "adminListViewerSessions",
      {
        streamId: args.streamId,
        page: args.page,
        limit: args.limit,
        sortField: args.sortField ?? "joinedAt",
        sortDir: args.sortDir ?? "desc",
      }
    ).then((r) => ({
      sessions: (r.sessions ?? []).map(toAdminViewerSessionRow),
      total: Number(r.total ?? 0),
    }))
);

interface RawStreamComment {
  id: string;
  sentBy: string;
  senderName: string;
  senderAvatar: string;
  message: string;
  createdAt: string | number;
}
interface RawGetCommentsRes {
  comments: RawStreamComment[];
  nextCursor: string;
  hasMore: boolean;
}

const getCommentsBreaker = makeBreaker(
  "stream.getComments",
  (args: GetCommentsArgs) =>
    call<Record<string, unknown>, RawGetCommentsRes>("getComments", {
      livestreamId: args.livestreamId,
      limit: args.limit,
      before: args.before ?? "",
      after: "",
      // "" = trusted internal caller: skips the per-viewer stream-ban gate that
      // would otherwise apply to a userId. Authorization for this read happens at
      // the admin REST edge (requirePermission(LIVESTREAMS_READ)), and the RPC
      // itself is reachable only with the shared service token.
      requesterId: "",
    }).then((r) => ({
      comments: (r.comments ?? []).map((c) => ({
        id: c.id,
        sentBy: c.sentBy,
        senderName: c.senderName ?? "",
        senderAvatar: c.senderAvatar ?? "",
        message: c.message ?? "",
        createdAt: Number(c.createdAt ?? 0),
      })),
      nextCursor: r.nextCursor ?? "",
      hasMore: r.hasMore ?? false,
    }))
);

interface RawAdminLivestreamReportCount {
  livestreamId: string;
  count: string | number;
}
interface RawAdminLivestreamReportCountsRes {
  counts: RawAdminLivestreamReportCount[];
}
const adminGetLivestreamReportCountsBreaker = makeBreaker(
  "stream.adminGetLivestreamReportCounts",
  (args: { livestreamIds: string[]; minCount: number }) =>
    call<
      { livestreamIds: string[]; minCount: number },
      RawAdminLivestreamReportCountsRes
    >("adminGetLivestreamReportCounts", args).then((r) => ({
      counts: (r.counts ?? []).map((c) => ({
        livestreamId: c.livestreamId,
        count: Number(c.count ?? 0),
      })),
    }))
);
// Fail-open: a stream-service outage on the count enrichment must not fail the
// whole admin list. `reportCount` degrades to 0, matching prior behavior.
adminGetLivestreamReportCountsBreaker.fallback(() => ({ counts: [] }));

interface RawCommunityStreamCount {
  communityId: string;
  count: number;
}
interface RawActiveStreamCountsRes {
  counts?: RawCommunityStreamCount[];
}

// Only communities with count > 0 come back, so an absent id means 0 LIVE.
// Fail-OPEN: a stream-service blip must not blank the whole community list.
const activeStreamCountsBreaker = makeBreaker(
  "stream.getActiveStreamCountsByCommunityIds",
  (args: { communityIds: string[] }) =>
    call<{ communityIds: string[] }, RawActiveStreamCountsRes>(
      "getActiveStreamCountsByCommunityIds",
      args
    )
);
// Fail-open, same as the report-count enrichment above: a stream-service blip
// degrades the column to 0 rather than failing the whole community list.
activeStreamCountsBreaker.fallback(() => ({ counts: [] }));

export const streamClient = {
  async getActiveStreamCountsByCommunityIds(
    communityIds: string[]
  ): Promise<Map<string, number>> {
    if (communityIds.length === 0) return new Map();
    try {
      const r = await activeStreamCountsBreaker.fire({ communityIds });
      return new Map((r.counts ?? []).map((c) => [c.communityId, c.count]));
    } catch {
      return new Map();
    }
  },
  /** Backoffice admin list — fail-closed (propagates on outage). */
  async adminListStreams(
    args: AdminListStreamsArgs
  ): Promise<{ streams: AdminStreamRow[]; total: number }> {
    return adminListStreamsBreaker.fire(args);
  },

  /** Backoffice admin single-stream fetch — null when not found. */
  async adminGetStream(streamId: string): Promise<AdminStreamRow | null> {
    const r = await adminGetStreamBreaker.fire({ streamId });
    return r.found && r.stream ? r.stream : null;
  },

  /**
   * Livestream chat history for the admin monitor, newest-first. Fail-closed:
   * an outage surfaces as a 503 rather than an empty transcript, which would
   * read as "nobody commented".
   */
  async getComments(args: GetCommentsArgs): Promise<{
    comments: StreamCommentRow[];
    nextCursor: string;
    hasMore: boolean;
  }> {
    return getCommentsBreaker.fire(args);
  },

  /** Backoffice admin viewer-session list (the actual "Livestream User List"). */
  async adminListViewerSessions(
    args: AdminListViewerSessionsArgs
  ): Promise<{ sessions: AdminViewerSessionRow[]; total: number }> {
    return adminListViewerSessionsBreaker.fire(args);
  },

  /**
   * Report counts for the admin Livestream Management list/detail. Empty
   * `livestreamIds` returns every stream with `count >= minCount`
   * (drives has-reports/min-reports filter); a non-empty list returns counts
   * for exactly those ids (used for row enrichment; missing ⇒ 0).
   */
  async adminGetLivestreamReportCounts(args: {
    livestreamIds?: string[];
    minCount?: number;
  }): Promise<{ livestreamId: string; count: number }[]> {
    const r = await adminGetLivestreamReportCountsBreaker.fire({
      livestreamIds: args.livestreamIds ?? [],
      minCount: args.minCount ?? 0,
    });
    return r.counts;
  },

  async getStreamStats(streamId: string): Promise<StreamStatsResult> {
    try {
      return await getStreamStatsBreaker.fire({ streamId });
    } catch {
      // Fail-open: if stream-service is down, return a "not found" result so
      // the backoffice still serves the mock row without crashing.
      return {
        found: false,
        status: "",
        viewerCount: 0,
        peakViewers: 0,
        totalViews: 0,
        totalComments: 0,
      };
    }
  },

  /** Fail-closed: admin thumbnail update must succeed; propagates on error. */
  async adminUpdateThumbnail(
    streamId: string,
    thumbnail: string
  ): Promise<void> {
    await adminUpdateThumbnailBreaker.fire({ streamId, thumbnail });
  },

  /** Fail-closed: propagates on error or circuit-open. */
  async adminForceEnd(
    streamId: string,
    reason: string
  ): Promise<AdminForceEndResult> {
    return await adminForceEndBreaker.fire({ streamId, reason });
  },

  /**
   * Best-effort: force-ends every non-terminal stream `creatorId` owns,
   * across every community. Called after an account ban/suspend — an admin
   * action that means "this account shouldn't be usable right now" must not
   * leave an existing broadcast running. Fail-open: a stream-service outage
   * must not fail the ban/suspend itself.
   */
  async forceEndStreamsByCreator(
    creatorId: string,
    reason: string
  ): Promise<ForceEndStreamsByCreatorResult> {
    try {
      return await forceEndByCreatorBreaker.fire({ creatorId, reason });
    } catch {
      return { ok: false, endedCount: 0 };
    }
  },
};
