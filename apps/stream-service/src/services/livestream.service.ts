import { randomBytes } from "node:crypto";

import { logger } from "@aimess/logger";
import {
  ForbiddenError,
  NotFoundError,
  ConflictError,
  BadRequestError,
} from "@aimess/errors";
import { formatStreamDuration } from "@aimess/constants";

import { env } from "../config/env.js";
import type { Livestream } from "../generated/prisma/index.js";
import type {
  AdminStreamFilter,
  LivestreamRepository,
} from "../repositories/livestream.repository.js";
import type { LivestreamBanRepository } from "../repositories/livestream-ban.repository.js";
import type { SrsService, IngestEndpoints } from "./srs.service.js";
import type { CommunityGrpcClient } from "../grpc/community.client.js";
import type { redis as RedisClient } from "../config/redis.js";
import { publishStreamEvent } from "../events/index.js";
import { userGrpcClient } from "../grpc/user.client.js";

/** A single watching user, enriched for the owner-only viewers list. */
export interface StreamViewerView {
  userId: string;
  username: string;
  displayName: string;
  avatarObjectKey: string;
  /** Epoch ms of this viewer's first join; null if unknown (e.g. Redis miss). */
  joinedAt: number | null;
}

/** Stream record enriched with a live viewer count + presentation helpers. */
export interface StreamView {
  id: string;
  communityId: string;
  creatorId: string;
  title: string;
  description: string;
  thumbnail: string | null;
  sourceType: string;
  sourceUrl: string | null;
  status: string;
  commentStatus: boolean;
  hlsUrl: string | null;
  flvUrl: string | null;
  dashUrl: string | null;
  viewerCount: number;
  peakViewers: number;
  totalViews: number;
  totalComments: number;
  livedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Owner-only create response: adds publish ingest endpoints + the stream key. */
export interface CreateStreamResult extends StreamView {
  streamKey: string;
  ingest: IngestEndpoints;
}

export interface ListStreamsResult {
  items: StreamView[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Result of the join gate (CheckStreamAccess). */
export interface StreamAccess {
  allowed: boolean;
  isBanned: boolean;
  status: string;
  reason: string; // "" | NOT_MEMBER | BANNED | STREAM_NOT_FOUND
  canComment: boolean; // reflects stream.commentStatus; false = chat disabled
  // Stream snapshot — populated when allowed=true so the gateway can enrich the
  // join ack without a second gRPC round-trip.
  streamStatus: string;
  title: string;
  description: string;
  thumbnail: string | null;
  creatorId: string;
  hlsUrl: string | null;
  flvUrl: string | null;
}

/** A ban row as exposed over REST. */
export interface BanView {
  userId: string;
  reason: string | null;
  bannedAt: Date;
}

/** Stats shape returned to the backoffice over gRPC. */
export interface StreamStats {
  found: boolean;
  status: string;
  viewerCount: number;
  peakViewers: number;
  totalViews: number;
  totalComments: number;
}

/**
 * A stream row as exposed to the backoffice admin Livestream Management screen
 * over gRPC. Carries the RAW thumbnail object key (the backoffice resolves it to
 * a presigned URL on read) plus a server-computed durationSeconds.
 */
export interface AdminStreamRow {
  id: string;
  communityId: string;
  creatorId: string;
  title: string;
  description: string;
  thumbnail: string | null;
  sourceType: string;
  status: string;
  hlsUrl: string | null;
  flvUrl: string | null;
  viewerCount: number;
  peakViewers: number;
  totalViews: number;
  totalComments: number;
  durationSeconds: number;
  livedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
}

/**
 * Stream duration in seconds.
 *  - never went live (no livedAt) → 0
 *  - LIVE → now − livedAt
 *  - ENDED/CANCELLED → endedAt − livedAt (0 if it ended before going live)
 */
function computeDurationSeconds(s: Livestream): number {
  if (!s.livedAt) return 0;
  const start = s.livedAt.getTime();
  const end = s.endedAt
    ? s.endedAt.getTime()
    : s.status === "LIVE"
      ? Date.now()
      : start;
  return Math.max(0, Math.round((end - start) / 1000));
}

/** Project a stream record to the backoffice admin row (raw keys preserved). */
function toAdminRow(s: Livestream): AdminStreamRow {
  return {
    id: s.id,
    communityId: s.communityId,
    creatorId: s.creatorId,
    title: s.title,
    description: s.description,
    thumbnail: s.thumbnail,
    sourceType: s.sourceType,
    status: s.status,
    hlsUrl: s.hlsUrl,
    flvUrl: s.flvUrl,
    viewerCount: s.viewerCount,
    peakViewers: s.peakViewers,
    totalViews: s.totalViews,
    totalComments: s.totalComments,
    durationSeconds: computeDurationSeconds(s),
    livedAt: s.livedAt,
    endedAt: s.endedAt,
    createdAt: s.createdAt,
  };
}

function toView(s: Livestream & { dashUrl?: string | null }): StreamView {
  return {
    id: s.id,
    communityId: s.communityId,
    creatorId: s.creatorId,
    title: s.title,
    description: s.description,
    thumbnail: s.thumbnail,
    sourceType: s.sourceType,
    sourceUrl: s.sourceUrl,
    status: s.status,
    commentStatus: s.commentStatus,
    hlsUrl: s.hlsUrl,
    flvUrl: s.flvUrl,
    dashUrl: s.dashUrl ?? null,
    viewerCount: s.viewerCount,
    peakViewers: s.peakViewers,
    totalViews: s.totalViews,
    totalComments: s.totalComments,
    livedAt: s.livedAt,
    endedAt: s.endedAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

const sessionKey = (streamId: string) => `stream:session:users:${streamId}`;
// Written by api-gateway's stream.ns.ts on stream:join (HSETNX, so a rejoin
// never overwrites the original join time) — see that file for the write side.
const sessionJoinedKey = (streamId: string) =>
  `stream:session:joined:${streamId}`;
const creatorStreamLockKey = (communityId: string, creatorId: string) =>
  `stream:creator-active-lock:${communityId}:${creatorId}`;
const CREATOR_STREAM_LOCK_TTL_SEC = 15;

/** Map a community-service moderation `errorCode` to the matching AppError subclass. */
function moderationErrorToAppError(errorCode: string): Error {
  if (!errorCode) return new ForbiddenError("STREAM_MUTE_FORBIDDEN");
  if (errorCode.includes("NOT_FOUND")) return new NotFoundError(errorCode);
  if (errorCode.includes("CANNOT_MODIFY"))
    return new BadRequestError(errorCode);
  return new ForbiddenError(errorCode);
}

export class LivestreamService {
  constructor(
    private readonly streamRepo: LivestreamRepository,
    private readonly srsService: SrsService,
    private readonly communityClient: CommunityGrpcClient,
    private readonly redis: typeof RedisClient,
    private readonly banRepo: LivestreamBanRepository,
    private readonly eventPublisher: typeof publishStreamEvent = publishStreamEvent,
    // Resolves the host's display-name/avatar snapshot for enriched community
    // livestream socket payloads. Defaults to the shared singleton; injectable
    // for tests. Best-effort — a failure degrades to an empty host name.
    private readonly userClient: typeof userGrpcClient = userGrpcClient
  ) {}

  /**
   * Go-live: authorize the creator (membership gate, optional), enforce the
   * per-community concurrency cap, mint a stream key + playback URLs and persist
   * a PENDING stream. Returns the record plus owner-only ingest endpoints.
   *
   * YOUTUBE streams skip SRS entirely — sourceUrl is the embed link, no ingest
   * endpoints are minted, and all playback URLs are null.
   */
  async createStream(params: {
    communityId: string;
    creatorId: string;
    title: string;
    description?: string;
    thumbnail?: string;
    sourceType: string;
    sourceUrl?: string;
  }): Promise<CreateStreamResult> {
    if (env.STREAM_REQUIRE_MEMBERSHIP) {
      let membership;
      try {
        membership = await this.communityClient.validateMembership(
          params.communityId,
          params.creatorId
        );
      } catch (error) {
        logger.warn(
          `createStream membership check failed for community=${params.communityId}: ${String(error)}`
        );
        // Fail-closed: can't verify membership → deny go-live.
        throw new ForbiddenError("STREAM_NOT_A_COMMUNITY_MEMBER");
      }
      if (!membership.isMember) {
        throw new ForbiddenError("STREAM_NOT_A_COMMUNITY_MEMBER");
      }
    }

    const isYoutube = params.sourceType === "YOUTUBE";
    if ((params.sourceType === "URL" || isYoutube) && !params.sourceUrl) {
      throw new BadRequestError("STREAM_SOURCE_URL_REQUIRED");
    }

    const { created, streamKey } = await this.withCreatorStreamLock(
      params.communityId,
      params.creatorId,
      async () => {
        // Both counts are LIVE-only — a PENDING stream (still setting up,
        // never published) never blocks a new create and never occupies a
        // community concurrency slot. Only an actually-broadcasting stream does.
        const [activeByCreator, activeByCommunity] = await Promise.all([
          this.streamRepo.countActiveByCommunityAndCreator(
            params.communityId,
            params.creatorId
          ),
          this.streamRepo.countActiveByCommunity(params.communityId),
        ]);
        if (activeByCreator > 0) {
          throw new ConflictError("STREAM_ALREADY_ACTIVE");
        }
        if (activeByCommunity >= env.STREAM_MAX_CONCURRENT_PER_COMMUNITY) {
          throw new ConflictError("STREAM_COMMUNITY_CONCURRENCY_LIMIT");
        }

        const streamKey = randomBytes(16).toString("hex");

        // YouTube streams embed a remote source — no SRS ingest/playback.
        const playback = isYoutube
          ? null
          : this.srsService.buildPlaybackUrls(streamKey);

        const created = await this.streamRepo.create({
          communityId: params.communityId,
          creatorId: params.creatorId,
          title: params.title,
          description: params.description ?? "",
          thumbnail: params.thumbnail ?? null,
          sourceType: params.sourceType,
          sourceUrl: params.sourceUrl ?? null,
          streamKey,
          status: "PENDING",
          hlsUrl: playback?.hlsUrl ?? null,
          flvUrl: playback?.flvUrl ?? null,
          dashUrl: playback?.dashUrl ?? null,
        });

        return { created, streamKey };
      }
    );

    // Race-safe cap enforcement. The count check above has a small window where
    // two concurrent creates both pass at count = MAX-1 and produce MAX+1. After
    // inserting, re-derive THIS stream's rank among the community's LIVE
    // streams (deterministic createdAt + id tiebreak): if MAX or more were
    // created at-or-before it, this one lost the race — delete it and reject, so
    // the community never keeps more than MAX concurrent LIVE streams. (The
    // just-created row is always PENDING here, so in practice this only trips
    // if MAX streams are already LIVE — PENDING never competes for the cap.)
    const priorActive = await this.streamRepo.countActiveCreatedBefore(
      created.communityId,
      created.createdAt,
      created.id
    );
    if (priorActive >= env.STREAM_MAX_CONCURRENT_PER_COMMUNITY) {
      await this.streamRepo.deleteById(created.id).catch((err: unknown) => {
        logger.warn(
          `failed to roll back over-cap stream ${created.id}: ${String(err)}`
        );
      });
      throw new ConflictError("STREAM_COMMUNITY_CONCURRENCY_LIMIT");
    }

    void this.eventPublisher("stream.created", {
      streamId: created.id,
      communityId: created.communityId,
      creatorId: created.creatorId,
      title: created.title,
      description: created.description ?? "",
      thumbnail: created.thumbnail ?? null,
      sourceType: created.sourceType,
      status: created.status,
      hlsUrl: created.hlsUrl ?? null,
      flvUrl: created.flvUrl ?? null,
      createdAt: created.createdAt.toISOString(),
    });

    return {
      ...toView(created),
      streamKey,
      ingest: isYoutube ? {} : this.srsService.buildIngestEndpoints(streamKey),
    };
  }

  /**
   * SRS on_publish hook: the publisher came online. Flip to LIVE, stamp livedAt
   * and playback URLs, broadcast status + emit `stream.started`. Returns whether
   * to allow the publish (false = unknown stream key → SRS rejects).
   */
  async handlePublish(streamKey: string): Promise<boolean> {
    const stream = await this.streamRepo.findByStreamKey(streamKey);
    if (!stream) {
      logger.warn(`on_publish for unknown stream key=${streamKey} — denying`);
      return false;
    }
    if (stream.status === "ENDED" || stream.status === "CANCELLED") {
      logger.warn(
        `on_publish for ${stream.status} stream id=${stream.id} — denying`
      );
      return false;
    }

    // Already LIVE (e.g. markLive was called manually before the hook fired) —
    // allow the publish but skip the re-broadcast so status events fire exactly once.
    if (stream.status === "LIVE") {
      logger.info(
        `on_publish for already-LIVE stream id=${stream.id} — allowing without re-broadcast`
      );
      return true;
    }

    const otherActiveStreams =
      await this.streamRepo.countActiveByCommunityAndCreator(
        stream.communityId,
        stream.creatorId,
        stream.id
      );
    if (otherActiveStreams > 0) {
      logger.warn(
        `on_publish denied for stream id=${stream.id}: creator=${stream.creatorId} already has an active stream in community=${stream.communityId}`
      );
      return false;
    }

    const playback = this.srsService.buildPlaybackUrls(streamKey);
    const updated = await this.streamRepo.updateById(stream.id, {
      status: "LIVE",
      livedAt: new Date(),
      hlsUrl: playback.hlsUrl,
      flvUrl: playback.flvUrl,
      dashUrl: playback.dashUrl,
    });

    await this.publishStatus(updated.id, "LIVE", updated.communityId, {
      creatorId: updated.creatorId,
      hlsUrl: updated.hlsUrl,
      flvUrl: updated.flvUrl,
      startedAt: updated.livedAt?.getTime() ?? Date.now(),
    });
    void this.publishCommunityStreamStarted(updated);
    this.eventPublisher("stream.started", {
      streamId: updated.id,
      communityId: updated.communityId,
      creatorId: updated.creatorId,
      title: updated.title,
      livedAt: updated.livedAt?.getTime() ?? Date.now(),
    });

    return true;
  }

  /**
   * SRS on_unpublish hook: the publisher dropped. Flip to ENDED (idempotent),
   * broadcast status + emit `stream.ended`.
   */
  async handleUnpublish(streamKey: string): Promise<void> {
    const stream = await this.streamRepo.findByStreamKey(streamKey);
    if (!stream) {
      logger.warn(
        `on_unpublish for unknown stream key=${streamKey} — ignoring`
      );
      return;
    }
    if (stream.status === "ENDED" || stream.status === "CANCELLED") return;

    const updated = await this.streamRepo.updateById(stream.id, {
      status: "ENDED",
      endedAt: new Date(),
    });

    await this.publishStatus(updated.id, "ENDED", updated.communityId);
    void this.publishCommunityStreamEnded(updated);
    this.eventPublisher("stream.ended", {
      streamId: updated.id,
      communityId: updated.communityId,
      creatorId: updated.creatorId,
      endedAt: updated.endedAt?.getTime() ?? Date.now(),
      durationSeconds: computeDurationSeconds(updated),
      peakViewers: updated.peakViewers,
    });
  }

  /**
   * Coarse DB viewer-count nudge from SRS on_play/on_stop. The authoritative
   * live count is Redis-owned by the gateway; this just keeps a rough DB number
   * for history. Best-effort — never throws into the hook handler.
   */
  async incrementViewer(streamKey: string, delta: number): Promise<void> {
    try {
      const stream = await this.streamRepo.findByStreamKey(streamKey);
      if (!stream) return;
      const next = Math.max(0, stream.viewerCount + delta);
      await this.streamRepo.updateById(stream.id, {
        viewerCount: next,
        ...(next > stream.peakViewers ? { peakViewers: next } : {}),
      });
    } catch (error) {
      logger.warn(
        `incrementViewer failed for key=${streamKey}: ${String(error)}`
      );
    }
  }

  /**
   * Manual stop by the owner. Ends the stream, asks SRS to drop the publisher,
   * and broadcasts the ENDED status. SRS will also fire on_unpublish, which is
   * a no-op once ENDED.
   */
  async stopStream(id: string, requesterId: string): Promise<StreamView> {
    const stream = await this.streamRepo.findById(id);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    if (stream.creatorId !== requesterId) {
      throw new ForbiddenError("STREAM_NOT_OWNER");
    }

    if (stream.status === "ENDED" || stream.status === "CANCELLED") {
      return toView(stream);
    }

    const updated = await this.streamRepo.updateById(id, {
      status: "ENDED",
      endedAt: new Date(),
    });

    // Best-effort terminate the SRS publisher.
    await this.srsService.kickStream(stream.streamKey);

    await this.publishStatus(updated.id, "ENDED", updated.communityId);
    void this.publishCommunityStreamEnded(updated);
    this.eventPublisher("stream.ended", {
      streamId: updated.id,
      communityId: updated.communityId,
      creatorId: updated.creatorId,
      endedAt: updated.endedAt?.getTime() ?? Date.now(),
      durationSeconds: computeDurationSeconds(updated),
      peakViewers: updated.peakViewers,
    });

    return toView(updated);
  }

  /**
   * Manual go-live by the owner. Used when SRS has no on_publish hook (e.g.
   * hosted SRS without callback support). Flips PENDING→LIVE, stamps playback
   * URLs, broadcasts stream:status, and emits stream.started. Idempotent if
   * already LIVE.
   */
  async markLive(id: string, requesterId: string): Promise<StreamView> {
    const stream = await this.streamRepo.findById(id);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    if (stream.creatorId !== requesterId) {
      throw new ForbiddenError("STREAM_NOT_OWNER");
    }
    if (stream.status === "ENDED" || stream.status === "CANCELLED") {
      throw new BadRequestError("STREAM_ALREADY_ENDED");
    }
    if (stream.status === "LIVE") {
      return toView(stream);
    }

    const otherActiveStreams =
      await this.streamRepo.countActiveByCommunityAndCreator(
        stream.communityId,
        stream.creatorId,
        stream.id
      );
    if (otherActiveStreams > 0) {
      throw new ConflictError("STREAM_ALREADY_ACTIVE");
    }

    const playback = this.srsService.buildPlaybackUrls(stream.streamKey);
    const updated = await this.streamRepo.updateById(id, {
      status: "LIVE",
      livedAt: new Date(),
      hlsUrl: playback.hlsUrl,
      flvUrl: playback.flvUrl,
      dashUrl: playback.dashUrl,
    });

    await this.publishStatus(updated.id, "LIVE", updated.communityId, {
      creatorId: updated.creatorId,
      hlsUrl: updated.hlsUrl,
      flvUrl: updated.flvUrl,
      startedAt: updated.livedAt?.getTime() ?? Date.now(),
    });
    void this.publishCommunityStreamStarted(updated);
    this.eventPublisher("stream.started", {
      streamId: updated.id,
      communityId: updated.communityId,
      creatorId: updated.creatorId,
      title: updated.title,
      livedAt: updated.livedAt?.getTime() ?? Date.now(),
    });

    return toView(updated);
  }

  /**
   * Admin: force-end a stream. Idempotent — already ENDED/CANCELLED streams
   * return { success: false } without error. Kicks SRS if stream was LIVE,
   * then broadcasts ENDED status and emits stream.ended event.
   */
  async adminForceEnd(
    streamId: string,
    _reason: string
  ): Promise<{ success: boolean; status: string }> {
    const stream = await this.streamRepo.findById(streamId);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    if (stream.status === "ENDED" || stream.status === "CANCELLED") {
      return { success: false, status: stream.status };
    }

    const updated = await this.streamRepo.updateById(streamId, {
      status: "ENDED",
      endedAt: new Date(),
    });

    if (stream.status === "LIVE") {
      // Best-effort — kick SRS publisher if stream was live. Errors are swallowed.
      await this.srsService.kickStream(stream.streamKey);
    }

    await this.publishStatus(updated.id, "ENDED", updated.communityId);
    void this.publishCommunityStreamEnded(updated);
    this.eventPublisher("stream.ended", {
      streamId: updated.id,
      communityId: updated.communityId,
      creatorId: updated.creatorId,
      endedAt: updated.endedAt?.getTime() ?? Date.now(),
      durationSeconds: computeDurationSeconds(updated),
      peakViewers: updated.peakViewers,
    });

    return { success: true, status: "ENDED" };
  }

  /** Owner updates editable stream metadata (title, description, thumbnail). */
  async updateStream(
    id: string,
    requesterId: string,
    updates: { title?: string; description?: string; thumbnail?: string }
  ): Promise<StreamView> {
    const stream = await this.streamRepo.findById(id);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    if (stream.creatorId !== requesterId) {
      throw new ForbiddenError("STREAM_NOT_OWNER");
    }

    const updated = await this.streamRepo.updateById(id, {
      ...(updates.title !== undefined ? { title: updates.title } : {}),
      ...(updates.description !== undefined
        ? { description: updates.description }
        : {}),
      ...(updates.thumbnail !== undefined
        ? { thumbnail: updates.thumbnail }
        : {}),
    });

    void this.eventPublisher("stream.updated", {
      streamId: updated.id,
      communityId: updated.communityId,
      creatorId: updated.creatorId,
      title: updated.title,
      description: updated.description ?? "",
      thumbnail: updated.thumbnail ?? null,
      updatedAt: updated.updatedAt.toISOString(),
    });

    // Broadcast so viewers see the updated title/description in real time.
    try {
      await this.redis.publish(
        `stream:${id}`,
        JSON.stringify({
          event: "stream:info_updated",
          data: {
            streamId: id,
            title: updated.title,
            description: updated.description ?? "",
            thumbnail: updated.thumbnail ?? null,
          },
        })
      );
    } catch (err) {
      logger.warn(
        `info_updated broadcast failed for stream=${id}: ${String(err)}`
      );
    }

    return toView(updated);
  }

  /**
   * Owner deletes the stream record. Only PENDING, ENDED, and CANCELLED streams
   * may be deleted — a LIVE stream must be stopped first.
   */
  async deleteStream(id: string, requesterId: string): Promise<void> {
    const stream = await this.streamRepo.findById(id);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    if (stream.creatorId !== requesterId) {
      throw new ForbiddenError("STREAM_NOT_OWNER");
    }
    if (stream.status === "LIVE") {
      throw new ConflictError("STREAM_IS_LIVE");
    }

    await this.streamRepo.deleteById(id);
  }

  async listStreams(params: {
    communityId?: string;
    status?: string;
    limit: number;
    cursor?: string;
  }): Promise<ListStreamsResult> {
    const rows = await this.streamRepo.listByCommunity({
      communityId: params.communityId,
      status: params.status,
      limit: params.limit + 1,
      cursor: params.cursor,
    });
    const hasMore = rows.length > params.limit;
    const page = hasMore ? rows.slice(0, params.limit) : rows;
    const items = page.map(toView);
    const nextCursor =
      hasMore && items.length > 0 ? items[items.length - 1]!.id : null;
    return { items, nextCursor, hasMore };
  }

  /**
   * Single stream fetch. When `userId` is provided the ban list is checked and
   * a ForbiddenError is thrown if the user is banned — preventing banned users
   * from reading stream metadata over REST. The live Redis viewer count is merged
   * in when present.
   */
  async getStream(id: string, userId?: string): Promise<StreamView> {
    const stream = await this.streamRepo.findById(id);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");

    if (userId && (await this.banRepo.isBanned(id, userId))) {
      throw new ForbiddenError("STREAM_BANNED");
    }

    const view = toView(stream);

    try {
      view.viewerCount = await this.redis.scard(sessionKey(id));
    } catch (error) {
      logger.warn(
        `live viewer count read failed for stream=${id}: ${String(error)}`
      );
    }

    return view;
  }

  /**
   * Record a keep-alive heartbeat from the stream host. Updates `lastHeartbeatAt`
   * so the sweeper knows the host is still connected. Called every ~30 s from the
   * client while the stream is LIVE.
   */
  async recordHeartbeat(id: string, requesterId: string): Promise<void> {
    const stream = await this.streamRepo.findById(id);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    if (stream.creatorId !== requesterId) {
      throw new ForbiddenError("STREAM_NOT_OWNER");
    }
    if (stream.status !== "LIVE") {
      throw new BadRequestError("STREAM_NOT_LIVE");
    }
    await this.streamRepo.updateById(id, { lastHeartbeatAt: new Date() });
  }

  /**
   * Background sweeper: auto-end LIVE streams whose host hasn't heartbeated in
   * `STREAM_HEARTBEAT_TIMEOUT_MS`, and auto-cancel PENDING streams that sat
   * unpublished past `STREAM_PENDING_TIMEOUT_MS` (abandoned setup, crashed
   * client, failed publish). A stuck PENDING row otherwise never clears —
   * it permanently occupies that creator's one-active-stream-per-community
   * slot and every subsequent create attempt 409s with STREAM_ALREADY_ACTIVE,
   * even though nothing is actually live. Called periodically from server.ts.
   * Intentionally silent — a single stale stream failure does not block the rest.
   */
  async sweepStaleStreams(): Promise<void> {
    await this.sweepStaleLiveStreams();
    await this.sweepStalePendingStreams();
  }

  private async sweepStaleLiveStreams(): Promise<void> {
    const cutoff = new Date(Date.now() - env.STREAM_HEARTBEAT_TIMEOUT_MS);
    let stale: Awaited<ReturnType<typeof this.streamRepo.findStaleLiveStreams>>;
    try {
      stale = await this.streamRepo.findStaleLiveStreams(cutoff);
    } catch (err) {
      logger.warn(`sweepStaleStreams: DB query failed — ${String(err)}`);
      return;
    }
    if (!stale.length) return;

    logger.info(`sweepStaleStreams: ending ${stale.length} stale stream(s)`);
    for (const stream of stale) {
      try {
        const updated = await this.streamRepo.updateById(stream.id, {
          status: "ENDED",
          endedAt: new Date(),
        });
        await this.srsService.kickStream(stream.streamKey);
        await this.publishStatus(updated.id, "ENDED", updated.communityId);
        void this.publishCommunityStreamEnded(updated);
        this.eventPublisher("stream.ended", {
          streamId: updated.id,
          communityId: updated.communityId,
          creatorId: updated.creatorId,
          endedAt: updated.endedAt?.getTime() ?? Date.now(),
          durationSeconds: computeDurationSeconds(updated),
          peakViewers: updated.peakViewers,
        });
        logger.info(
          `sweepStaleStreams: ended stream=${stream.id} community=${stream.communityId}`
        );
      } catch (err) {
        logger.warn(
          `sweepStaleStreams: failed to end stream=${stream.id} — ${String(err)}`
        );
      }
    }
  }

  private async sweepStalePendingStreams(): Promise<void> {
    const cutoff = new Date(Date.now() - env.STREAM_PENDING_TIMEOUT_MS);
    let stale: Awaited<
      ReturnType<typeof this.streamRepo.findStalePendingStreams>
    >;
    try {
      stale = await this.streamRepo.findStalePendingStreams(cutoff);
    } catch (err) {
      logger.warn(`sweepStalePendingStreams: DB query failed — ${String(err)}`);
      return;
    }
    if (!stale.length) return;

    logger.info(
      `sweepStalePendingStreams: cancelling ${stale.length} stale PENDING stream(s)`
    );
    for (const stream of stale) {
      try {
        const updated = await this.streamRepo.updateById(stream.id, {
          status: "CANCELLED",
          endedAt: new Date(),
        });
        // Best-effort — a PENDING stream never published, but a client may have
        // gotten as far as opening the ingest connection.
        await this.srsService.kickStream(stream.streamKey);
        await this.publishStatus(updated.id, "ENDED", updated.communityId);
        void this.publishCommunityStreamEnded(updated);
        this.eventPublisher("stream.ended", {
          streamId: updated.id,
          communityId: updated.communityId,
          creatorId: updated.creatorId,
          endedAt: updated.endedAt?.getTime() ?? Date.now(),
          durationSeconds: 0,
          peakViewers: 0,
        });
        logger.info(
          `sweepStalePendingStreams: cancelled stream=${stream.id} community=${stream.communityId}`
        );
      } catch (err) {
        logger.warn(
          `sweepStalePendingStreams: failed to cancel stream=${stream.id} — ${String(err)}`
        );
      }
    }
  }

  /** Backs community-service `isLive` enrichment (fail-open caller side). */
  async getActiveStreamsByCommunityIds(
    communityIds: string[]
  ): Promise<string[]> {
    return this.streamRepo.findLiveCommunityIds(communityIds);
  }

  /**
   * Backs `activeLivestreamCount`/`hasActiveLivestream` on GET /communities/mine
   * and the chat-service community rooms list. Returns the LIVE-only count per
   * community (communities with 0 live streams are omitted). Fail-open caller side.
   */
  async getActiveStreamCountsByCommunityIds(
    communityIds: string[]
  ): Promise<Array<{ communityId: string; count: number }>> {
    return this.streamRepo.countLiveByCommunityIds(communityIds);
  }

  /**
   * Backoffice admin list — the source of truth for the Livestream Management
   * screen (read live over gRPC, no event-fed read-model). Returns a page of
   * rows + the total match count for offset pagination. The caller (backoffice)
   * enriches community/creator/category/avatars and resolves the thumbnail key.
   */
  async adminListStreams(params: {
    search?: string;
    communityIds?: string[];
    creatorIds?: string[];
    status?: string;
    communityId?: string;
    creatorId?: string;
    restrictCommunityIds?: string[];
    restrictStreamIds?: string[];
    dateFrom?: Date;
    dateTo?: Date;
    sortField: "createdAt" | "viewerCount" | "durationSeconds";
    sortDir: "asc" | "desc";
    page: number;
    limit: number;
  }): Promise<{ items: AdminStreamRow[]; total: number }> {
    const filter: AdminStreamFilter = {
      search: params.search,
      communityIds: params.communityIds,
      creatorIds: params.creatorIds,
      status: params.status,
      communityId: params.communityId,
      creatorId: params.creatorId,
      restrictCommunityIds: params.restrictCommunityIds,
      restrictStreamIds: params.restrictStreamIds,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    };
    const skip = (params.page - 1) * params.limit;
    const [rows, total] = await Promise.all([
      this.streamRepo.adminList(
        filter,
        params.sortField,
        params.sortDir,
        skip,
        params.limit
      ),
      this.streamRepo.adminCount(filter),
    ]);
    return { items: rows.map(toAdminRow), total };
  }

  /**
   * Backoffice admin single-stream fetch (source of truth). Returns null when
   * the id is unknown. Overlays the live Redis viewer count for LIVE streams so
   * the detail page matches the realtime count.
   */
  async adminGetStream(streamId: string): Promise<AdminStreamRow | null> {
    const stream = await this.streamRepo.findById(streamId);
    if (!stream) return null;
    const row = toAdminRow(stream);
    if (stream.status === "LIVE") {
      try {
        row.viewerCount = await this.redis.scard(sessionKey(streamId));
      } catch (error) {
        logger.warn(
          `admin live viewer count read failed for stream=${streamId}: ${String(error)}`
        );
      }
    }
    return row;
  }

  /**
   * Owner lists the users currently watching the stream, enriched with
   * username/display-name/avatar (best-effort, via user-service) and each
   * viewer's join time (best-effort, from Redis — null if unavailable). The
   * userId set and join-time hash are both maintained by api-gateway:
   * `stream:session:users:<streamId>` (Set) and
   * `stream:session:joined:<streamId>` (Hash, userId -> epoch ms).
   */
  async getViewers(
    id: string,
    requesterId: string
  ): Promise<StreamViewerView[]> {
    const stream = await this.streamRepo.findById(id);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    if (stream.creatorId !== requesterId) {
      throw new ForbiddenError("STREAM_NOT_OWNER");
    }

    let userIds: string[];
    try {
      userIds = await this.redis.smembers(sessionKey(id));
    } catch (error) {
      logger.warn(
        `getViewers Redis read failed for stream=${id}: ${String(error)}`
      );
      return [];
    }
    if (userIds.length === 0) return [];

    let joinedAtById = new Map<string, number>();
    try {
      const joined = await this.redis.hgetall(sessionJoinedKey(id));
      joinedAtById = new Map(
        Object.entries(joined).map(([userId, ts]) => [userId, Number(ts)])
      );
    } catch (error) {
      logger.warn(
        `getViewers join-time Redis read failed for stream=${id}: ${String(error)}`
      );
    }

    let snapshots: Awaited<
      ReturnType<typeof this.userClient.bulkGetUserSnapshots>
    > = [];
    try {
      snapshots = await this.userClient.bulkGetUserSnapshots(userIds);
    } catch (error) {
      logger.warn(
        `getViewers user enrichment failed for stream=${id}: ${String(error)}`
      );
    }
    const snapshotById = new Map(snapshots.map((s) => [s.userId, s]));

    return userIds.map((userId) => {
      const snap = snapshotById.get(userId);
      return {
        userId,
        username: snap?.username ?? "",
        displayName: snap?.displayName ?? "",
        avatarObjectKey: snap?.avatarObjectKey ?? "",
        joinedAt: joinedAtById.get(userId) ?? null,
      };
    });
  }

  /**
   * Join gate (called by the gateway over gRPC on stream:join). A user may view
   * a stream when they are not banned AND (the membership gate is off OR they are
   * the owner OR an ACTIVE community member). Fail-closed on the membership check
   * is inherited from the community gRPC client (returns isMember:false on error).
   */
  async checkAccess(streamId: string, userId: string): Promise<StreamAccess> {
    const stream = await this.streamRepo.findById(streamId);
    if (!stream) {
      return {
        allowed: false,
        isBanned: false,
        status: "",
        reason: "STREAM_NOT_FOUND",
        canComment: false,
        streamStatus: "",
        title: "",
        description: "",
        thumbnail: null,
        creatorId: "",
        hlsUrl: null,
        flvUrl: null,
      };
    }

    // Bans always win, even for would-be members.
    if (await this.banRepo.isBanned(streamId, userId)) {
      return {
        allowed: false,
        isBanned: true,
        status: "",
        reason: "BANNED",
        canComment: false,
        streamStatus: "",
        title: "",
        description: "",
        thumbnail: null,
        creatorId: "",
        hlsUrl: null,
        flvUrl: null,
      };
    }

    // Community-wide ban (ADMIN-applied in community-service) is also a hard
    // block — same shape as the local per-stream ban, including for the owner
    // (a banned member loses the stream too, no exceptions). Fail-open on a
    // community-service outage: consistent with every other community-service
    // read in this method, an outage must not black out viewing on its own —
    // the local ban above remains the always-available, synchronous hard gate.
    try {
      const communityBan = await this.communityClient.checkBan(
        stream.communityId,
        userId
      );
      if (communityBan.isBanned) {
        return {
          allowed: false,
          isBanned: true,
          status: "",
          reason: "BANNED",
          canComment: false,
          streamStatus: "",
          title: "",
          description: "",
          thumbnail: null,
          creatorId: "",
          hlsUrl: null,
          flvUrl: null,
        };
      }
    } catch (error) {
      logger.warn(
        `checkAccess: community ban check failed for stream=${streamId} user=${userId}: ${String(error)}`
      );
    }

    const canComment = stream.commentStatus;

    // Moderator mute (community-level) blocks commenting/reacting regardless of
    // membership requirement. Fail-open: a community-service outage must not
    // silence chat for everyone.
    const isMuted = await (async (): Promise<boolean> => {
      try {
        const mute = await this.communityClient.checkMute(
          stream.communityId,
          userId
        );
        return mute.isMuted;
      } catch (error) {
        logger.warn(
          `checkAccess: mute check failed for stream=${streamId} user=${userId}: ${String(error)}`
        );
        return false; // fail-open
      }
    })();

    // Snapshot fields shared by all allowed=true paths.
    const snapshot = {
      streamStatus: stream.status,
      title: stream.title,
      description: stream.description,
      thumbnail: stream.thumbnail,
      creatorId: stream.creatorId,
      hlsUrl: stream.hlsUrl,
      flvUrl: stream.flvUrl,
    };

    // The owner can always watch their own stream.
    if (stream.creatorId === userId) {
      this.streamRepo
        .incrementTotalViews(streamId)
        .catch((err: unknown) =>
          logger.warn(
            `incrementTotalViews failed stream=${streamId}: ${String(err)}`
          )
        );
      return {
        allowed: true,
        isBanned: false,
        status: "OWNER",
        reason: "",
        canComment: canComment && !isMuted,
        ...snapshot,
      };
    }

    if (env.STREAM_REQUIRE_MEMBERSHIP) {
      // Viewing is always allowed (ban check above is the only hard gate).
      // Membership only controls commenting: non-members can watch silently.
      // A community-service outage (throw) is treated as "member" so viewers
      // aren't locked out of live streams during infra hiccups.
      let isMember: boolean;
      try {
        const membership = await this.communityClient.validateMembership(
          stream.communityId,
          userId
        );
        isMember = membership.isMember;
      } catch (error) {
        logger.warn(
          `checkAccess: community service unavailable for stream=${streamId} user=${userId}: ${String(error)}`
        );
        isMember = true; // fail-open — don't black out live streams
      }
      this.streamRepo
        .incrementTotalViews(streamId)
        .catch((err: unknown) =>
          logger.warn(
            `incrementTotalViews failed stream=${streamId}: ${String(err)}`
          )
        );
      return {
        allowed: true,
        isBanned: false,
        status: "",
        reason: "",
        canComment: (isMember ? canComment : false) && !isMuted,
        ...snapshot,
      };
    }

    this.streamRepo
      .incrementTotalViews(streamId)
      .catch((err: unknown) =>
        logger.warn(
          `incrementTotalViews failed stream=${streamId}: ${String(err)}`
        )
      );
    return {
      allowed: true,
      isBanned: false,
      status: "",
      reason: "",
      canComment: canComment && !isMuted,
      ...snapshot,
    };
  }

  /**
   * Owner bans a user from the stream. Idempotent. Publishes a `stream:banned`
   * event so the gateway kicks the user's live sockets in real time. The join
   * gate (checkAccess) then blocks any rejoin.
   */
  async banUser(
    streamId: string,
    requesterId: string,
    targetUserId: string,
    reason?: string
  ): Promise<void> {
    const stream = await this.streamRepo.findById(streamId);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    if (stream.creatorId !== requesterId) {
      throw new ForbiddenError("STREAM_NOT_OWNER");
    }
    if (targetUserId === stream.creatorId) {
      throw new BadRequestError("STREAM_CANNOT_BAN_OWNER");
    }

    await this.banRepo.ban({
      livestreamId: streamId,
      bannedUserId: targetUserId,
      bannedBy: requesterId,
      reason: reason ?? null,
    });

    try {
      await this.redis.publish(
        `stream:${streamId}`,
        JSON.stringify({
          event: "stream:banned",
          data: { streamId, userId: targetUserId },
        })
      );
    } catch (error) {
      logger.warn(
        `ban broadcast failed for stream=${streamId}: ${String(error)}`
      );
    }
  }

  /** Owner lifts a ban. Idempotent. */
  async unbanUser(
    streamId: string,
    requesterId: string,
    targetUserId: string
  ): Promise<void> {
    const stream = await this.streamRepo.findById(streamId);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    if (stream.creatorId !== requesterId) {
      throw new ForbiddenError("STREAM_NOT_OWNER");
    }
    await this.banRepo.unban(streamId, targetUserId);
  }

  /** Owner lists who is banned from the stream. */
  async listBans(streamId: string, requesterId: string): Promise<BanView[]> {
    const stream = await this.streamRepo.findById(streamId);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    if (stream.creatorId !== requesterId) {
      throw new ForbiddenError("STREAM_NOT_OWNER");
    }
    const bans = await this.banRepo.listByStream(streamId);
    return bans.map((b) => ({
      userId: b.bannedUserId,
      reason: b.reason,
      bannedAt: b.bannedAt,
    }));
  }

  /**
   * Mute a member from the livestream. Writes through to the single community
   * moderation mute record (community-service enforces MODERATOR+ authorization,
   * self/admin guards) so muting from the stream and muting from the community
   * screen are the same action, not two separate mute states. Broadcasts
   * `stream:member_muted` so the gateway can push a real-time notice to the
   * muted user's live socket(s).
   */
  async muteMember(
    streamId: string,
    requesterId: string,
    targetUserId: string,
    durationMinutes: number | null | undefined,
    reason?: string
  ): Promise<{ mutedUntil: number }> {
    const stream = await this.streamRepo.findById(streamId);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");

    const result = await this.communityClient.muteMember(
      stream.communityId,
      requesterId,
      targetUserId,
      durationMinutes && durationMinutes > 0 ? durationMinutes : 0,
      reason ?? ""
    );
    if (!result.ok) {
      throw moderationErrorToAppError(result.errorCode);
    }

    try {
      await this.redis.publish(
        `stream:${streamId}`,
        JSON.stringify({
          event: "stream:member_muted",
          data: {
            streamId,
            userId: targetUserId,
            mutedUntil: result.mutedUntil,
            reason: reason ?? null,
          },
        })
      );
    } catch (error) {
      logger.warn(
        `member_muted broadcast failed for stream=${streamId}: ${String(error)}`
      );
    }

    return { mutedUntil: result.mutedUntil };
  }

  /** Unmute a member from the livestream — same write-through as {@link muteMember}. */
  async unmuteMember(
    streamId: string,
    requesterId: string,
    targetUserId: string
  ): Promise<void> {
    const stream = await this.streamRepo.findById(streamId);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");

    const result = await this.communityClient.unmuteMember(
      stream.communityId,
      requesterId,
      targetUserId
    );
    if (!result.ok) {
      throw moderationErrorToAppError(result.errorCode);
    }

    try {
      await this.redis.publish(
        `stream:${streamId}`,
        JSON.stringify({
          event: "stream:member_unmuted",
          data: { streamId, userId: targetUserId },
        })
      );
    } catch (error) {
      logger.warn(
        `member_unmuted broadcast failed for stream=${streamId}: ${String(error)}`
      );
    }
  }

  /**
   * Inbound push from community-service after a mute/unmute triggered from the
   * community side (UI or socket): find this community's currently-LIVE streams
   * where the target is present (viewer or owner) and relay the same
   * `stream:member_muted`/`stream:member_unmuted` event so live viewers see it
   * without needing to rejoin. Best-effort — never throws.
   */
  async broadcastMuteStatusForCommunity(
    communityId: string,
    userId: string,
    isMuted: boolean,
    mutedUntil: number
  ): Promise<void> {
    if (!communityId || !userId) return;

    let liveStreams: StreamView[];
    try {
      ({ items: liveStreams } = await this.listStreams({
        communityId,
        status: "LIVE",
        limit: 50,
      }));
    } catch (error) {
      logger.warn(
        `broadcastMuteStatusForCommunity: listStreams failed for community=${communityId}: ${String(error)}`
      );
      return;
    }

    for (const stream of liveStreams) {
      let isPresent = stream.creatorId === userId;
      if (!isPresent) {
        try {
          isPresent =
            (await this.redis.sismember(sessionKey(stream.id), userId)) === 1;
        } catch {
          isPresent = false;
        }
      }
      if (!isPresent) continue;

      try {
        await this.redis.publish(
          `stream:${stream.id}`,
          JSON.stringify({
            event: isMuted ? "stream:member_muted" : "stream:member_unmuted",
            data: { streamId: stream.id, userId, mutedUntil },
          })
        );
      } catch (error) {
        logger.warn(
          `mute status broadcast failed for stream=${stream.id}: ${String(error)}`
        );
      }
    }
  }

  /**
   * ADMIN bans a member from the entire community — not just this stream.
   * Writes through to the single community ban record (authorization —
   * ADMIN-only, stricter than mute's MODERATOR+ — is enforced entirely on the
   * community-service side). Distinct from {@link banUser}: this is a
   * separate, community-wide tool; the local per-stream ban above is untouched
   * and still works as an owner-only "kick from just this stream" action.
   * Broadcasts the same `stream:banned` event as the local ban, so the
   * gateway's existing kick logic applies with zero gateway changes.
   */
  async communityBanMember(
    streamId: string,
    requesterId: string,
    targetUserId: string,
    reason?: string
  ): Promise<void> {
    const stream = await this.streamRepo.findById(streamId);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");

    const result = await this.communityClient.banMember(
      stream.communityId,
      requesterId,
      targetUserId,
      reason ?? ""
    );
    if (!result.ok) {
      throw moderationErrorToAppError(result.errorCode);
    }

    try {
      await this.redis.publish(
        `stream:${streamId}`,
        JSON.stringify({
          event: "stream:banned",
          data: { streamId, userId: targetUserId },
        })
      );
    } catch (error) {
      logger.warn(
        `community ban broadcast failed for stream=${streamId}: ${String(error)}`
      );
    }
  }

  /** ADMIN lifts a community-wide ban — same write-through as {@link communityBanMember}. */
  async communityUnbanMember(
    streamId: string,
    requesterId: string,
    targetUserId: string
  ): Promise<void> {
    const stream = await this.streamRepo.findById(streamId);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");

    const result = await this.communityClient.unbanMember(
      stream.communityId,
      requesterId,
      targetUserId
    );
    if (!result.ok) {
      throw moderationErrorToAppError(result.errorCode);
    }
    // No socket push on unban — matches the local per-stream unban's behavior
    // (does not auto-rejoin the user; they rejoin manually).
  }

  /**
   * Inbound push from community-service after an ADMIN bans/unbans a member
   * from the *community* side (UI or socket): find this community's
   * currently-LIVE streams where the target is present and, on ban, kick them
   * the same way a stream-triggered ban does — reuses `stream:banned`, so no
   * gateway changes are needed. Unban is a no-op here, mirroring the local
   * per-stream unban (no auto-rejoin push). Best-effort — never throws.
   */
  async broadcastBanStatusForCommunity(
    communityId: string,
    userId: string,
    isBanned: boolean
  ): Promise<void> {
    if (!communityId || !userId || !isBanned) return;

    let liveStreams: StreamView[];
    try {
      ({ items: liveStreams } = await this.listStreams({
        communityId,
        status: "LIVE",
        limit: 50,
      }));
    } catch (error) {
      logger.warn(
        `broadcastBanStatusForCommunity: listStreams failed for community=${communityId}: ${String(error)}`
      );
      return;
    }

    for (const stream of liveStreams) {
      let isPresent = stream.creatorId === userId;
      if (!isPresent) {
        try {
          isPresent =
            (await this.redis.sismember(sessionKey(stream.id), userId)) === 1;
        } catch {
          isPresent = false;
        }
      }
      if (!isPresent) continue;

      try {
        await this.redis.publish(
          `stream:${stream.id}`,
          JSON.stringify({
            event: "stream:banned",
            data: { streamId: stream.id, userId },
          })
        );
      } catch (error) {
        logger.warn(
          `ban status broadcast failed for stream=${stream.id}: ${String(error)}`
        );
      }
    }
  }

  /**
   * Owner toggles chat on/off. Broadcasts a `stream:comment_status` event via
   * Redis so all connected viewers' Chat components update `canComment` live.
   */
  async setCommentStatus(
    streamId: string,
    requesterId: string,
    enabled: boolean
  ): Promise<StreamView> {
    const stream = await this.streamRepo.findById(streamId);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    if (stream.creatorId !== requesterId)
      throw new ForbiddenError("STREAM_NOT_OWNER");

    const updated = await this.streamRepo.updateById(streamId, {
      commentStatus: enabled,
    });

    try {
      await this.redis.publish(
        `stream:${streamId}`,
        JSON.stringify({
          event: "stream:comment_status",
          data: { streamId, commentStatus: enabled },
        })
      );
    } catch (err) {
      logger.warn(
        `comment_status broadcast failed for stream=${streamId}: ${String(err)}`
      );
    }

    return toView(updated);
  }

  /**
   * Stats snapshot for the backoffice gRPC endpoint. Merges the live Redis
   * viewer count so the backoffice always sees a real-time number.
   */
  async getStreamStatsForBackoffice(streamId: string): Promise<StreamStats> {
    const stream = await this.streamRepo.findById(streamId);
    if (!stream) {
      return {
        found: false,
        status: "",
        viewerCount: 0,
        peakViewers: 0,
        totalViews: 0,
        totalComments: 0,
      };
    }

    let viewerCount = stream.viewerCount;
    try {
      viewerCount = await this.redis.scard(sessionKey(streamId));
    } catch {
      // best-effort
    }

    return {
      found: true,
      status: stream.status,
      viewerCount,
      peakViewers: stream.peakViewers,
      totalViews: stream.totalViews,
      totalComments: stream.totalComments,
    };
  }

  /** Admin override: update (or clear) the thumbnail objectKey without owner check. */
  async adminUpdateThumbnail(
    streamId: string,
    thumbnail: string | null
  ): Promise<void> {
    const stream = await this.streamRepo.findById(streamId);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    await this.streamRepo.updateById(streamId, { thumbnail });
  }

  private async withCreatorStreamLock<T>(
    communityId: string,
    creatorId: string,
    fn: () => Promise<T>
  ): Promise<T> {
    if (!env.REDIS_CACHE_ENABLED) {
      return fn();
    }

    const key = creatorStreamLockKey(communityId, creatorId);
    const token = randomBytes(8).toString("hex");

    let locked: boolean;
    try {
      locked =
        (await this.redis.set(
          key,
          token,
          "EX",
          CREATOR_STREAM_LOCK_TTL_SEC,
          "NX"
        )) === "OK";
    } catch (error) {
      logger.warn(
        `creator stream lock unavailable for community=${communityId} creator=${creatorId}: ${String(error)}`
      );
      return fn();
    }

    if (!locked) {
      throw new ConflictError("STREAM_ALREADY_ACTIVE");
    }

    try {
      return await fn();
    } finally {
      try {
        if ((await this.redis.get(key)) === token) {
          await this.redis.del(key);
        }
      } catch (error) {
        logger.warn(
          `creator stream lock release failed for community=${communityId} creator=${creatorId}: ${String(error)}`
        );
      }
    }
  }

  private async publishStatus(
    streamId: string,
    status: string,
    communityId: string,
    // Extra fields included only on LIVE transitions so the gateway can send a
    // targeted stream:broadcast:live event to the broadcaster's socket.
    broadcasterCtx?: {
      creatorId: string;
      hlsUrl: string | null;
      flvUrl: string | null;
      startedAt: number;
    }
  ): Promise<void> {
    try {
      await this.redis.publish(
        `stream:${streamId}`,
        JSON.stringify({
          event: "stream:status",
          // communityId is always included so the /stream namespace viewer can
          // update the community isLive badge without a separate /community room.
          data: { streamId, status, communityId, ...broadcasterCtx },
        })
      );
    } catch (error) {
      logger.warn(
        `status broadcast failed for stream=${streamId}: ${String(error)}`
      );
    }
  }

  /**
   * Resolve the host's display-name/avatar snapshot for an enriched community
   * livestream socket payload. Best-effort: a user-service failure degrades to an
   * empty name + null avatar (the client falls back to its community roster).
   * `avatarUrl` carries the snapshot's raw avatar object key — stream-service's
   * established wire convention (mirrors comment senderAvatar); resolve on read.
   */
  private async resolveHost(creatorId: string): Promise<{
    userId: string;
    displayName: string;
    avatarUrl: string | null;
  }> {
    try {
      const [snap] = await this.userClient.bulkGetUserSnapshots([creatorId]);
      return {
        userId: creatorId,
        displayName: snap?.displayName ?? "",
        avatarUrl: snap?.avatarObjectKey || null,
      };
    } catch (error) {
      logger.warn(
        `host snapshot resolve failed for ${creatorId}: ${String(error)}`
      );
      return { userId: creatorId, displayName: "", avatarUrl: null };
    }
  }

  /**
   * Notify the community that a stream just went LIVE. Enriched (host, live
   * count, hasActiveLivestream, startedAt) for the live banner + list badge;
   * additive over the legacy { communityId, streamId, title, hlsUrl } shape. The
   * gateway relays this to BOTH the open-chat room and the lightweight typing
   * room, so every connected member sees the banner without opening the chat.
   */
  private async publishCommunityStreamStarted(
    stream: Livestream
  ): Promise<void> {
    logger.info(
      `🔴 [STREAM:LIVE] publishCommunityStreamStarted → Redis channel=community:${stream.communityId} streamId=${stream.id} title="${stream.title ?? ""}"`
    );
    try {
      const [host, liveCount] = await Promise.all([
        this.resolveHost(stream.creatorId),
        this.streamRepo.countLiveByCommunity(stream.communityId),
      ]);
      await this.redis.publish(
        `community:${stream.communityId}`,
        JSON.stringify({
          event: "community:stream:started",
          data: {
            communityId: stream.communityId,
            livestreamId: stream.id,
            streamId: stream.id, // legacy alias
            host,
            title: stream.title ?? null,
            hlsUrl: stream.hlsUrl ?? null,
            status: "LIVE",
            startedAt: stream.livedAt?.getTime() ?? Date.now(),
            activeLivestreamCount: Math.min(
              liveCount,
              env.STREAM_MAX_CONCURRENT_PER_COMMUNITY
            ),
            hasActiveLivestream: true,
          },
        })
      );
      logger.info(
        `🔴 [STREAM:LIVE] ✅ community:stream:started published to Redis community:${stream.communityId}`
      );
    } catch (error) {
      logger.warn(
        `community stream-started broadcast failed for community=${stream.communityId}: ${String(error)}`
      );
    }
  }

  /**
   * Notify the community that a stream ENDED. Unlike the legacy behavior (which
   * only fired when the LAST stream ended), this fires on EVERY end carrying the
   * updated live count — `hasActiveLivestream` stays true while other streams run
   * and flips false only when the final stream ends. Drive banner visibility off
   * `hasActiveLivestream`/`activeLivestreamCount`, not the event's presence.
   */
  private async publishCommunityStreamEnded(stream: Livestream): Promise<void> {
    try {
      // Count is read AFTER this stream is ENDED, so it reflects the streams
      // that remain live.
      const [host, liveCount] = await Promise.all([
        this.resolveHost(stream.creatorId),
        this.streamRepo.countLiveByCommunity(stream.communityId),
      ]);
      const durationSeconds = computeDurationSeconds(stream);
      await this.redis.publish(
        `community:${stream.communityId}`,
        JSON.stringify({
          event: "community:stream:ended",
          data: {
            communityId: stream.communityId,
            livestreamId: stream.id,
            streamId: stream.id, // legacy alias
            host,
            status: "ENDED",
            endedAt: stream.endedAt?.getTime() ?? Date.now(),
            duration: formatStreamDuration(durationSeconds),
            durationSeconds,
            activeLivestreamCount: Math.min(
              liveCount,
              env.STREAM_MAX_CONCURRENT_PER_COMMUNITY
            ),
            hasActiveLivestream: liveCount > 0,
          },
        })
      );
      logger.info(
        `🔴 [STREAM:ENDED] ✅ community:stream:ended published to Redis community:${stream.communityId}`
      );
    } catch (error) {
      logger.warn(
        `community stream-ended broadcast failed for community=${stream.communityId}: ${String(error)}`
      );
    }
  }
}
