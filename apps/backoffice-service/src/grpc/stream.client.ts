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

export const streamClient = {
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

  /** Backoffice admin viewer-session list (the actual "Livestream User List"). */
  async adminListViewerSessions(
    args: AdminListViewerSessionsArgs
  ): Promise<{ sessions: AdminViewerSessionRow[]; total: number }> {
    return adminListViewerSessionsBreaker.fire(args);
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
