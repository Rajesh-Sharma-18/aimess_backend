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
import type { LivestreamViewerSessionRepository } from "../repositories/livestream-viewer-session.repository.js";
import { buildHlsQualityUrls, buildFlvQualityUrls } from "./srs.service.js";
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
  /**
   * ABR variant playlists keyed by rendition ("1080p" | "720p" | "480p" | "360p").
   * `hlsUrl` is the master playlist; players that just want auto-switching should
   * load it directly. This map is for UIs that expose a manual quality picker.
   * Empty `{}` when the stream has no ABR ladder (YOUTUBE, URL mode with no
   * transcode, or a local dev environment where SRS_HLS_ABR_MASTER=false).
   */
  hlsQualities: Record<string, string>;
  flvUrl: string | null;
  /**
   * Manual FLV quality URLs keyed by rung ("Source" | "480p" | "360p"). Unlike
   * `hlsQualities` there is no auto/ABR tier — "Source" is the untranscoded
   * feed. Empty `{}` when SRS_FLV_ABR is off or the stream has no FLV (YOUTUBE).
   */
  flvQualities: Record<string, string>;
  dashUrl: string | null;
  youtubeVideoId: string | null;
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

/** Owner-only re-fetch of the same publish credentials minted at creation. */
export interface PublishCredentialsResult {
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
  hlsQualities: Record<string, string>;
  flvUrl: string | null;
  flvQualities: Record<string, string>;
}

/** A ban row as exposed over REST. */
export interface BanView {
  userId: string;
  username: string | null;
  displayName: string | null;
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
  /** Distinct-user count from LivestreamViewerSession — matches AdminListViewerSessions' total. */
  uniqueViewerCount: number;
  /** Last known quality snapshot (self-reported or SRS-polled) — null until the first report arrives. */
  lastKnownResolution: string | null;
  lastKnownBitrateKbps: number | null;
  lastKnownFps: number | null;
}

/**
 * Stream duration in seconds.
 *  - never went live (no livedAt) → 0
 *  - LIVE or RECONNECTING → now − livedAt (a reconnect-grace blip is still
 *    part of the same ongoing session, not a pause in its runtime)
 *  - ENDED → endedAt − livedAt (0 if it ended before going live)
 */
function computeDurationSeconds(s: Livestream): number {
  if (!s.livedAt) return 0;
  const start = s.livedAt.getTime();
  const end = s.endedAt
    ? s.endedAt.getTime()
    : s.status === "LIVE" || s.status === "RECONNECTING"
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
    // Populated by the caller (needs a DB round-trip); toAdminRow stays pure.
    uniqueViewerCount: 0,
    lastKnownResolution: s.lastKnownResolution,
    lastKnownBitrateKbps: s.lastKnownBitrateKbps,
    lastKnownFps: s.lastKnownFps,
  };
}

function extractYoutubeVideoId(url: string | null): string | null {
  if (!url) return null;
  const short = url.match(/youtu\.be\/([^?&/]+)/);
  if (short) return short[1];
  const long = url.match(/[?&]v=([^?&]+)/);
  if (long) return long[1];
  return null;
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
    hlsQualities: buildHlsQualityUrls(s.hlsUrl),
    flvUrl: s.flvUrl,
    flvQualities: buildFlvQualityUrls(s.flvUrl),
    dashUrl: s.dashUrl ?? null,
    youtubeVideoId: extractYoutubeVideoId(s.sourceUrl),
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

// SRS accepts an RTMP/WHIP publish (on_publish fires / markLive is called)
// before any media has actually flowed, so HLS/FLV can 404 for a moment right
// after go-live. These bound the best-effort poll that watches for the first
// real frame and tells viewers once playback will actually work.
const PLAYABLE_POLL_INTERVAL_MS = 500;
const PLAYABLE_POLL_MAX_ATTEMPTS = 10;

// A plain MEMBER cannot go live; only ADMIN/MODERATOR may broadcast. Checked
// on go-live and re-checked (via forceEndStreamsByCreator) whenever a role
// changes so an in-progress stream ends the moment the host drops below this.
const LIVESTREAM_HOST_ROLES = new Set(["ADMIN", "MODERATOR"]);
export function canStartLivestream(role: string): boolean {
  return LIVESTREAM_HOST_ROLES.has(role);
}

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
    private readonly viewerSessionRepo: LivestreamViewerSessionRepository,
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
      // A CLOSED/SUSPENDED community blocks new go-lives even for an ACTIVE
      // member — going live is a write operation like any other.
      if (membership.isCommunityClosed) {
        throw new ForbiddenError("COMMUNITY_IS_CLOSED");
      }
      // Only ADMIN/MODERATOR may broadcast — a plain MEMBER cannot start
      // (or keep) a livestream.
      if (!canStartLivestream(membership.role)) {
        throw new ForbiddenError("STREAM_ROLE_NOT_ALLOWED");
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
        // Two counts run in parallel — all LIVE-only (PENDING never blocks):
        //   activeAnywhere  — creator is already LIVE in any community
        //   activeByCommunity — community's concurrent-stream cap
        const [activeAnywhere, activeByCommunity] = await Promise.all([
          this.streamRepo.countLiveByCreator(params.creatorId),
          this.streamRepo.countActiveByCommunity(params.communityId),
        ]);
        // Global rule: one active stream per user across all communities.
        if (activeAnywhere > 0) {
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
   *
   * A stream in RECONNECTING (mid reconnect-grace after a prior on_unpublish)
   * resumes LIVE here instead of starting fresh: `livedAt` is preserved (same
   * broadcast session, continuous duration) and `stream.started` /
   * `community:stream:started` are NOT re-emitted, since the community-facing
   * "this stream is live" state never actually changed during the blip.
   */
  async handlePublish(streamKey: string): Promise<boolean> {
    const stream = await this.streamRepo.findByStreamKey(streamKey);
    if (!stream) {
      logger.warn(`on_publish for unknown stream key=${streamKey} — denying`);
      return false;
    }
    if (stream.status === "ENDED") {
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

    const isResume = stream.status === "RECONNECTING";

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
      disconnectedAt: null,
      // Resume: keep the original livedAt so duration/history stay continuous
      // across the blip. Fresh publish: stamp it for the first time.
      ...(isResume ? {} : { livedAt: new Date() }),
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
    // Media may need a moment to re-establish after a reconnect too, so
    // re-poll for the first frame on resume just as on a fresh publish.
    this.notifyWhenPlayable(updated);

    if (isResume) {
      logger.info(
        `on_publish: stream id=${stream.id} resumed within reconnect grace window`
      );
    } else {
      // Open a viewer session for the host as the stream first goes LIVE, so
      // the host is always counted in `uniqueViewerCount` and surfaced in the
      // admin viewer list — even though they publish via SRS/RTMP and never
      // emit `stream:join` themselves. Idempotent: a subsequent socket-based
      // host join reuses this same open session (see recordJoin).
      void this.recordHostViewerJoin(updated.id, updated.creatorId);
      const startedAt = updated.livedAt?.getTime() ?? Date.now();
      const liveStreamCount = await this.streamRepo.countLiveByCommunity(
        updated.communityId
      );
      void this.publishCommunityStreamStarted(updated, liveStreamCount);
      this.eventPublisher("stream.started", {
        streamId: updated.id,
        communityId: updated.communityId,
        creatorId: updated.creatorId,
        title: updated.title,
        sourceType: updated.sourceType,
        sourceUrl: updated.sourceUrl ?? null,
        hlsUrl: updated.hlsUrl ?? null,
        flvUrl: updated.flvUrl ?? null,
        dashUrl: updated.dashUrl ?? null,
        youtubeVideoId: extractYoutubeVideoId(updated.sourceUrl),
        status: "LIVE",
        livedAt: startedAt,
        startedAt,
        liveStreamCount,
      });
    }

    return true;
  }

  /**
   * SRS on_unpublish hook: the publisher dropped.
   *
   * Source-type-aware behaviour on LIVE → …:
   *   - PHONE_CAMERA (WHIP): LIVE → RECONNECTING. Browser-refresh / mobile-blip
   *     is the exact case the grace window (`STREAM_RECONNECT_GRACE_MS`) was
   *     designed for — the tab remounts and republishes with the same
   *     streamKey within seconds, and viewers see "Reconnecting…" instead of
   *     a dead stream. The sweeper finalizes RECONNECTING streams whose grace
   *     window expires without a republish.
   *   - OBS_RTMP: LIVE → ENDED immediately. OBS Stop and OBS network drops
   *     both look identical to SRS (RTMP close), and OBS users predominantly
   *     mean it when they stop — the 45s "waiting to reconnect" limbo is
   *     confusing UX for an OBS session that was clearly stopped on purpose.
   *     If an OBS streamer with a genuine network blip loses their stream,
   *     they can restart it (rarely mid-broadcast anyway; OBS is typically
   *     wired ethernet at a desk).
   *   - URL / YOUTUBE: LIVE → ENDED. Neither carries a browser-side
   *     reconnect concept; the source is either publishable or it isn't.
   *
   * RECONNECTING/ENDED → no-op: idempotent against a duplicate or
   * retried on_unpublish. Critically, a second unpublish while already
   * RECONNECTING must NOT reset `disconnectedAt` — a flapping connection that
   * keeps failing to fully republish must not indefinitely extend its own
   * grace window.
   * NOTE: heartbeats are intentionally ignored while RECONNECTING (see
   * {@link recordHeartbeat}) so a still-open companion app cannot keep
   * `lastHeartbeatAt` fresh and prevent the heartbeat sweeper from acting as
   * a backstop if the reconnect sweep misses a stale stream.
   *
   * RECONNECTING/ENDED/CANCELLED → no-op (idempotent against duplicate hooks).
   * PENDING → finalized outright (unpublish with no preceding publish = bad state).
   */
  async handleUnpublish(streamKey: string): Promise<void> {
    const stream = await this.streamRepo.findByStreamKey(streamKey);
    if (!stream) {
      logger.warn(
        `on_unpublish for unknown stream key=${streamKey} — ignoring`
      );
      return;
    }
    if (stream.status === "ENDED" || stream.status === "RECONNECTING") {
      return;
    }

    if (stream.status === "LIVE" && stream.sourceType === "PHONE_CAMERA") {
      const updated = await this.streamRepo.updateById(stream.id, {
        status: "RECONNECTING",
        disconnectedAt: new Date(),
      });
      await this.publishStatus(updated.id, "RECONNECTING", updated.communityId);
      logger.info(
        `on_unpublish: stream id=${stream.id} entering RECONNECTING grace window (source=PHONE_CAMERA)`
      );
      return;
    }

    // OBS_RTMP / URL / YOUTUBE / PENDING → straight to ENDED.
    await this.finalizeAsEnded(stream);
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
   * Common tail for any transition INTO ENDED: flips status, best-effort kicks
   * the SRS publisher, broadcasts the ENDED status, closes out open viewer
   * sessions, and emits `stream.ended`. Shared by {@link stopStream},
   * {@link adminForceEnd}, {@link sweepStaleLiveStreams}, and
   * {@link sweepStaleReconnectingStreams} — each arrives at "this stream is
   * over" from a different trigger but must finish the same way. `kickStream`
   * is always safe to call even if the stream never had (or no longer has) an
   * active SRS publisher: it's a no-op lookup-then-DELETE, bounded and
   * swallows its own errors (see SrsService.kickStream).
   */
  private async finalizeAsEnded(
    stream: Livestream,
    reason = "HOST_ENDED"
  ): Promise<Livestream> {
    const updated = await this.streamRepo.updateById(stream.id, {
      status: "ENDED",
      endedAt: new Date(),
    });

    await this.srsService.kickStream(stream.streamKey, stream.sourceType);

    const liveStreamCount = await this.streamRepo.countLiveByCommunity(
      updated.communityId
    );
    await this.publishStatus(updated.id, "ENDED", updated.communityId, {
      creatorId: stream.creatorId,
    });
    void this.publishCommunityStreamEnded(updated, liveStreamCount, reason);
    void this.closeOpenViewerSessions(
      updated.id,
      updated.endedAt ?? new Date()
    );
    this.eventPublisher("stream.ended", {
      streamId: updated.id,
      communityId: updated.communityId,
      creatorId: updated.creatorId,
      endedAt: updated.endedAt?.getTime() ?? Date.now(),
      durationSeconds: computeDurationSeconds(updated),
      peakViewers: updated.peakViewers,
      liveStreamCount,
      reason,
    });

    return updated;
  }

  /**
   * Manual stop by the owner. Ends the stream (including one mid
   * reconnect-grace — an explicit stop always overrides the grace window),
   * asks SRS to drop the publisher, and broadcasts the ENDED status. SRS will
   * also fire on_unpublish, which is a no-op once ENDED.
   */
  /**
   * Owner-only re-fetch of publish credentials — lets a PHONE_CAMERA broadcaster
   * resume after a page reload with the same `streamKey`/WHIP URL minted at
   * creation, instead of starting a new stream.
   */
  async getPublishCredentials(
    id: string,
    requesterId: string
  ): Promise<PublishCredentialsResult> {
    const stream = await this.streamRepo.findById(id);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    if (stream.creatorId !== requesterId) {
      throw new ForbiddenError("STREAM_NOT_OWNER");
    }
    if (stream.sourceType !== "PHONE_CAMERA") {
      throw new BadRequestError("STREAM_NOT_PHONE_CAMERA_SOURCE");
    }
    if (stream.status === "ENDED") {
      throw new BadRequestError("STREAM_ALREADY_ENDED");
    }

    return {
      streamKey: stream.streamKey,
      ingest: this.srsService.buildIngestEndpoints(stream.streamKey),
    };
  }

  async stopStream(id: string, requesterId: string): Promise<StreamView> {
    const stream = await this.streamRepo.findById(id);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    if (stream.creatorId !== requesterId) {
      throw new ForbiddenError("STREAM_NOT_OWNER");
    }

    if (stream.status === "ENDED") {
      return toView(stream);
    }

    return toView(await this.finalizeAsEnded(stream));
  }

  /**
   * Manual go-live by the owner. Used when SRS has no on_publish hook (e.g.
   * hosted SRS without callback support). Flips PENDING→LIVE, stamps playback
   * URLs, broadcasts stream:status, and emits stream.started. Idempotent if
   * already LIVE.
   *
   * A stream in RECONNECTING resumes the same way {@link handlePublish} does
   * on a webhook-driven resume: `livedAt` is preserved and `stream.started` /
   * `community:stream:started` are not re-emitted, since this is a mixed
   * webhook/manual environment resuming the same session, not a fresh go-live.
   */
  async markLive(id: string, requesterId: string): Promise<StreamView> {
    const stream = await this.streamRepo.findById(id);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    if (stream.creatorId !== requesterId) {
      throw new ForbiddenError("STREAM_NOT_OWNER");
    }
    if (stream.status === "ENDED") {
      throw new BadRequestError("STREAM_ALREADY_ENDED");
    }
    if (stream.status === "LIVE") {
      return toView(stream);
    }

    const isResume = stream.status === "RECONNECTING";

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
      disconnectedAt: null,
      ...(isResume ? {} : { livedAt: new Date() }),
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
    this.notifyWhenPlayable(updated);

    if (isResume) {
      logger.info(
        `markLive: stream id=${id} resumed within reconnect grace window`
      );
    } else {
      // Host viewer session — see handlePublish for the rationale.
      void this.recordHostViewerJoin(updated.id, updated.creatorId);
      const startedAt = updated.livedAt?.getTime() ?? Date.now();
      const liveStreamCount = await this.streamRepo.countLiveByCommunity(
        updated.communityId
      );
      void this.publishCommunityStreamStarted(updated, liveStreamCount);
      this.eventPublisher("stream.started", {
        streamId: updated.id,
        communityId: updated.communityId,
        creatorId: updated.creatorId,
        title: updated.title,
        sourceType: updated.sourceType,
        sourceUrl: updated.sourceUrl ?? null,
        hlsUrl: updated.hlsUrl ?? null,
        flvUrl: updated.flvUrl ?? null,
        dashUrl: updated.dashUrl ?? null,
        youtubeVideoId: extractYoutubeVideoId(updated.sourceUrl),
        status: "LIVE",
        livedAt: startedAt,
        startedAt,
        liveStreamCount,
      });
    }

    return toView(updated);
  }

  /**
   * Admin: force-end a stream. Idempotent — already ENDED streams
   * return { success: false } without error. Otherwise finalizes it ENDED
   * (kicks SRS, broadcasts ENDED status, emits stream.ended) regardless of
   * whether it was LIVE, RECONNECTING, or PENDING.
   */
  async adminForceEnd(
    streamId: string,
    _reason: string
  ): Promise<{ success: boolean; status: string }> {
    const stream = await this.streamRepo.findById(streamId);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    if (stream.status === "ENDED") {
      return { success: false, status: stream.status };
    }

    await this.finalizeAsEnded(stream);

    return { success: true, status: "ENDED" };
  }

  /**
   * Best-effort bulk force-end: every non-terminal (PENDING/LIVE/RECONNECTING)
   * stream owned by `creatorId`, optionally scoped to one `communityId`.
   * Called (via gRPC) when the creator's account is banned/suspended/deleted
   * (unscoped — end every stream everywhere) or when a community-wide
   * ban/kick removes their membership in ONE community (scoped — leave any
   * stream they're legitimately still broadcasting in a different community
   * untouched). Same `finalizeAsEnded` tail as {@link adminForceEnd} — a
   * PENDING stream ends up ENDED here too, matching adminForceEnd's existing
   * "deliberate moderation action" precedent. One failure never blocks the
   * rest; never throws to the caller.
   */
  async forceEndStreamsByCreator(
    creatorId: string,
    communityId: string | undefined,
    reason: string
  ): Promise<{ endedCount: number }> {
    let streams: Livestream[];
    try {
      streams = await this.streamRepo.findActiveByCreator(
        creatorId,
        communityId
      );
    } catch (err) {
      logger.warn(
        `forceEndStreamsByCreator: query failed for creator=${creatorId}: ${String(err)}`
      );
      return { endedCount: 0 };
    }
    if (!streams.length) return { endedCount: 0 };

    let endedCount = 0;
    for (const stream of streams) {
      try {
        await this.finalizeAsEnded(stream, reason);
        endedCount++;
        logger.info(
          `forceEndStreamsByCreator: ended stream=${stream.id} creator=${creatorId} community=${stream.communityId} reason=${reason}`
        );
      } catch (err) {
        logger.warn(
          `forceEndStreamsByCreator: failed to end stream=${stream.id}: ${String(err)}`
        );
      }
    }
    return { endedCount };
  }

  /**
   * Best-effort bulk force-end of every non-terminal stream in one community.
   * Called (via gRPC) when the community is deleted or closed/suspended — a
   * stream cannot legitimately keep running once its home community disallows
   * activity. Same `finalizeAsEnded` tail as {@link forceEndStreamsByCreator} —
   * one failure never blocks the rest; never throws to the caller.
   */
  async forceEndStreamsByCommunity(
    communityId: string,
    reason: string
  ): Promise<{ endedCount: number }> {
    let streams: Livestream[];
    try {
      streams = await this.streamRepo.findActiveByCommunity(communityId);
    } catch (err) {
      logger.warn(
        `forceEndStreamsByCommunity: query failed for community=${communityId}: ${String(err)}`
      );
      return { endedCount: 0 };
    }
    if (!streams.length) return { endedCount: 0 };

    let endedCount = 0;
    for (const stream of streams) {
      try {
        await this.finalizeAsEnded(stream, reason);
        endedCount++;
        logger.info(
          `forceEndStreamsByCommunity: ended stream=${stream.id} creator=${stream.creatorId} community=${communityId} reason=${reason}`
        );
      } catch (err) {
        logger.warn(
          `forceEndStreamsByCommunity: failed to end stream=${stream.id}: ${String(err)}`
        );
      }
    }
    return { endedCount };
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
   * Owner deletes the stream record. Only PENDING and ENDED streams
   * may be deleted — a LIVE stream (or one mid reconnect-grace, still the same
   * ongoing session) must be stopped first.
   */
  async deleteStream(id: string, requesterId: string): Promise<void> {
    const stream = await this.streamRepo.findById(id);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    if (stream.creatorId !== requesterId) {
      throw new ForbiddenError("STREAM_NOT_OWNER");
    }
    if (stream.status === "LIVE" || stream.status === "RECONNECTING") {
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
      view.viewerCount = await this.redis.hlen(sessionKey(id));
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
   * client while the stream is LIVE — also accepted during RECONNECTING, since
   * the heartbeat signals "the owner's client is alive", which remains true
   * during a brief publisher blip and keeps `lastHeartbeatAt` fresh for when
   * the stream resumes LIVE.
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
   * Persist a video-quality snapshot and relay it to viewers over the same
   * `stream:<id>` Redis channel `publishStatus`/`updateStream` already use
   * (the gateway fans any `stream:*` event straight to the room, so no
   * gateway change is needed for a new event name).
   *
   * Two callers, one method: the browser (WHIP) self-reports via
   * `POST /streams/:id/quality` (`requesterId` set, owner-checked like
   * {@link recordHeartbeat}); the OBS sweeper poll (see
   * {@link pollObsStreamQuality}) calls it system-side with no requester.
   */
  async reportQuality(
    id: string,
    quality: { resolution: string; bitrateKbps: number; fps?: number },
    opts?: { requesterId?: string }
  ): Promise<void> {
    const stream = await this.streamRepo.findById(id);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    if (opts?.requesterId && stream.creatorId !== opts.requesterId) {
      throw new ForbiddenError("STREAM_NOT_OWNER");
    }
    if (stream.status !== "LIVE") throw new BadRequestError("STREAM_NOT_LIVE");

    await this.streamRepo.updateById(id, {
      lastKnownResolution: quality.resolution,
      lastKnownBitrateKbps: quality.bitrateKbps,
      lastKnownFps: quality.fps ?? null,
      qualityUpdatedAt: new Date(),
    });

    try {
      await this.redis.publish(
        `stream:${id}`,
        JSON.stringify({
          event: "stream:quality",
          data: {
            streamId: id,
            resolution: quality.resolution,
            bitrateKbps: quality.bitrateKbps,
            fps: quality.fps ?? null,
          },
        })
      );
    } catch (error) {
      logger.warn(
        `quality broadcast failed for stream=${id}: ${String(error)}`
      );
    }
  }

  /**
   * System-side counterpart of {@link reportQuality} for OBS/RTMP streams —
   * there is no browser peer connection to self-report from, so this polls
   * SRS's own stats directly. Called from the stream sweeper's existing 30s
   * tick (see `jobs/stream-sweeper.ts`); best-effort, never throws.
   */
  async pollObsStreamQuality(): Promise<void> {
    const streams = await this.streamRepo.findLiveBySourceType("OBS_RTMP");
    for (const stream of streams) {
      try {
        const stats = await this.srsService.getStreamStats(stream.streamKey);
        if (!stats) continue;
        await this.reportQuality(stream.id, {
          resolution: `${stats.width}x${stats.height}`,
          bitrateKbps: stats.bitrateKbps,
        });
        // SRS is still receiving frames, which is the ONLY trustworthy liveness
        // signal an OBS stream has: the host is broadcasting from OBS, not from
        // the app, so the client-driven heartbeat may stop the moment they
        // switch windows or the phone backgrounds the app. Treat "the publisher
        // is demonstrably still sending" as the heartbeat, or the sweeper ends
        // a perfectly healthy broadcast at STREAM_HEARTBEAT_TIMEOUT_MS.
        await this.streamRepo.updateById(stream.id, {
          lastHeartbeatAt: new Date(),
        });
      } catch (error) {
        logger.warn(
          `pollObsStreamQuality failed for stream=${stream.id}: ${String(error)}`
        );
      }
    }
  }

  /**
   * Background sweeper: auto-end LIVE streams whose host hasn't heartbeated in
   * `STREAM_HEARTBEAT_TIMEOUT_MS`, auto-end RECONNECTING streams whose
   * reconnect-grace window (`STREAM_RECONNECT_GRACE_MS`) expired without a
   * republish, and auto-cancel PENDING streams that sat unpublished past
   * `STREAM_PENDING_TIMEOUT_MS` (abandoned setup, crashed client, failed
   * publish). A stuck PENDING row otherwise never clears — it permanently
   * occupies that creator's one-active-stream-per-community slot and every
   * subsequent create attempt 409s with STREAM_ALREADY_ACTIVE, even though
   * nothing is actually live. Called periodically from server.ts.
   * Intentionally silent — a single stale stream failure does not block the rest.
   */
  async sweepStaleStreams(): Promise<void> {
    await this.sweepStaleLiveStreams();
    await this.sweepStaleReconnectingStreams();
    await this.sweepStalePendingStreams();
    await this.reconcileWithSrs();
  }

  /**
   * Repairs DB↔SRS drift (edge cases 1.7 / 5.2).
   *
   * `kickStream` is best-effort and swallows its own errors — if the DELETE
   * fails (SRS unhealthy, wrong instance, request timed out) the DB says ENDED
   * while SRS happily keeps the publisher connected, burning bandwidth and
   * leaving the streamer's encoder convinced it is still on air. Nothing
   * previously retried that kick.
   *
   * This pass lists every publisher SRS actually has open, resolves them
   * against the DB in one batch query, and re-kicks any whose stream is already
   * terminal. It runs on the existing 30s sweeper tick, so a failed kick
   * self-heals within one tick instead of never.
   *
   * It ALSO recovers a missing on_publish (PENDING/RECONNECTING → LIVE) when
   * SRS is already carrying the publisher. That makes livestreams work against
   * an SRS whose hooks point at a different deployment, where the hook can
   * never reach us — see the inline note in the loop below.
   *
   * ponytail: the kick path is deliberately ONE-DIRECTIONAL — it only ends SRS sessions the DB
   * says are already over. The mirror case (DB says LIVE, SRS has no publisher)
   * is left to the heartbeat + reconnect-grace sweepers above, because acting on
   * it here would mean ending live streams based on an *absence* in the SRS
   * response — and a partial/degraded API reply is indistinguishable from a
   * genuinely empty one. `listPublishers()` returning null on any instance
   * failure is the guard that keeps this pass from acting on bad data at all.
   * Upgrade path: if the webhook-loss case ever needs faster recovery than the
   * 5-minute heartbeat timeout, require N consecutive absent observations
   * before ending, rather than trusting a single scan.
   */
  private async reconcileWithSrs(): Promise<void> {
    const publishers = await this.srsService.listPublishers();
    // null = at least one SRS instance was unreachable; skip rather than act on
    // an incomplete picture.
    if (publishers === null || publishers.length === 0) return;

    let streams: Livestream[];
    try {
      streams = await this.streamRepo.findByStreamKeys(
        publishers.map((p) => p.streamKey)
      );
    } catch (err) {
      logger.warn(`reconcileWithSrs: DB query failed — ${String(err)}`);
      return;
    }

    const byKey = new Map(streams.map((s) => [s.streamKey, s]));

    for (const publisher of publishers) {
      const stream = byKey.get(publisher.streamKey);

      if (!stream) {
        // Unknown key still publishing. `handlePublish` denies unknown keys, so
        // SRS should already have dropped it — log rather than kick, so a
        // create/publish race can't have its publisher killed mid-handshake.
        logger.warn(
          `reconcileWithSrs: SRS publisher for unknown streamKey=${publisher.streamKey} on ${publisher.apiBase}`
        );
        continue;
      }

      // ── SRS is publishing but we still think it is pending ────────────────
      // Normally on_publish flips PENDING → LIVE the instant the publisher
      // connects. That hook can never arrive when SRS is shared with another
      // deployment: SRS calls every configured hook URL and rejects the publish
      // if ANY returns non-zero, so a second environment cannot be added to the
      // list without each one denying the other's stream keys.
      //
      // Recovering it here makes the hook an optimisation rather than a
      // requirement — worst case a stream goes LIVE one sweeper tick (30s) late
      // instead of never. It also self-heals a genuinely dropped hook delivery.
      //
      // handlePublish is safe to call repeatedly: it no-ops on an already-LIVE
      // stream and resumes a RECONNECTING one without re-broadcasting.
      if (stream.status === "PENDING" || stream.status === "RECONNECTING") {
        try {
          const allowed = await this.handlePublish(publisher.streamKey);
          logger.info(
            `reconcileWithSrs: recovered missing on_publish stream=${stream.id} status=${stream.status} key=${publisher.streamKey} allowed=${String(allowed)}`
          );
        } catch (err) {
          logger.warn(
            `reconcileWithSrs: failed to recover publish for stream=${stream.id} — ${String(err)}`
          );
        }
        continue;
      }

      if (stream.status !== "ENDED" && stream.status !== "CANCELLED") continue;

      const kicked = await this.srsService.kickClientById(
        publisher.apiBase,
        publisher.clientId
      );
      logger.info(
        `reconcileWithSrs: re-kicked orphaned publisher stream=${stream.id} status=${stream.status} key=${publisher.streamKey} success=${String(kicked)}`
      );
    }
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
        await this.finalizeAsEnded(stream);
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

  /**
   * Finalizes RECONNECTING streams whose publisher never republished within
   * `STREAM_RECONNECT_GRACE_MS` of the on_unpublish that started the grace
   * window. This is the one place a reconnect-grace stream is actually
   * declared over — see {@link handleUnpublish} (enters the grace window) and
   * {@link handlePublish} (resumes LIVE within it).
   */
  private async sweepStaleReconnectingStreams(): Promise<void> {
    const cutoff = new Date(Date.now() - env.STREAM_RECONNECT_GRACE_MS);
    let stale: Awaited<
      ReturnType<typeof this.streamRepo.findStaleReconnectingStreams>
    >;
    try {
      stale = await this.streamRepo.findStaleReconnectingStreams(cutoff);
    } catch (err) {
      logger.warn(
        `sweepStaleReconnectingStreams: DB query failed — ${String(err)}`
      );
      return;
    }
    if (!stale.length) return;

    logger.info(
      `sweepStaleReconnectingStreams: finalizing ${stale.length} stream(s) whose reconnect grace expired`
    );
    for (const stream of stale) {
      try {
        await this.finalizeAsEnded(stream);
        logger.info(
          `sweepStaleReconnectingStreams: ended stream=${stream.id} community=${stream.communityId}`
        );
      } catch (err) {
        logger.warn(
          `sweepStaleReconnectingStreams: failed to end stream=${stream.id} — ${String(err)}`
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
      `sweepStalePendingStreams: ending ${stale.length} stale PENDING stream(s)`
    );
    for (const stream of stale) {
      try {
        const updated = await this.streamRepo.updateById(stream.id, {
          status: "ENDED",
          endedAt: new Date(),
        });
        // Best-effort — a PENDING stream never published, but a client may have
        // gotten as far as opening the ingest connection.
        await this.srsService.kickStream(stream.streamKey, stream.sourceType);
        const liveStreamCount = await this.streamRepo.countLiveByCommunity(
          updated.communityId
        );
        await this.publishStatus(updated.id, "ENDED", updated.communityId);
        void this.publishCommunityStreamEnded(updated, liveStreamCount);
        this.eventPublisher("stream.ended", {
          streamId: updated.id,
          communityId: updated.communityId,
          creatorId: updated.creatorId,
          endedAt: updated.endedAt?.getTime() ?? Date.now(),
          durationSeconds: 0,
          peakViewers: 0,
          liveStreamCount,
        });
        logger.info(
          `sweepStalePendingStreams: ended stream=${stream.id} community=${stream.communityId}`
        );
      } catch (err) {
        logger.warn(
          `sweepStalePendingStreams: failed to end stream=${stream.id} — ${String(err)}`
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
   * Backs `liveStreamCount`/`hasActiveLivestream` on GET /communities/mine
   * and the chat-service community rooms list. Returns the LIVE-or-RECONNECTING
   * count per community (communities with 0 such streams are omitted).
   * Fail-open caller side.
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
    excludeStreamIds?: string[];
    dateFrom?: Date;
    dateTo?: Date;
    sortField:
      | "createdAt"
      | "viewerCount"
      | "durationSeconds"
      | "title"
      | "status";
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
      excludeStreamIds: params.excludeStreamIds,
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
    const [items, uniqueCounts] = await Promise.all([
      Promise.all(rows.map((r) => this.toAdminRowLive(r))),
      this.viewerSessionRepo.countDistinctUsersByStreamIds(
        rows.map((r) => r.id)
      ),
    ]);
    for (const item of items) {
      item.uniqueViewerCount = uniqueCounts.get(item.id) ?? 0;
    }
    return { items, total };
  }

  /**
   * {@link toAdminRow} plus a live Redis overlay for LIVE (or reconnect-grace)
   * rows — mirrors {@link adminGetStream}. Without this, `viewerCount` on such
   * a row is the stored DB column, which `incrementViewer` only nudges via the
   * coarse SRS on_play/on_stop hook (a rough per-hit counter, not a
   * unique-viewer count) and can drift far from the real number of people
   * currently watching. RECONNECTING is included because viewers typically
   * haven't left during a brief publisher blip — Bounded per call to one page
   * of rows, so the extra Redis round-trips are cheap.
   */
  private async toAdminRowLive(s: Livestream): Promise<AdminStreamRow> {
    const row = toAdminRow(s);
    if (s.status === "LIVE" || s.status === "RECONNECTING") {
      try {
        row.viewerCount = await this.redis.hlen(sessionKey(s.id));
      } catch (error) {
        logger.warn(
          `admin live viewer count read failed for stream=${s.id}: ${String(error)}`
        );
      }
    }
    return row;
  }

  /**
   * Backoffice admin single-stream fetch (source of truth). Returns null when
   * the id is unknown. Overlays the live Redis viewer count for LIVE streams so
   * the detail page matches the realtime count.
   */
  async adminGetStream(streamId: string): Promise<AdminStreamRow | null> {
    const stream = await this.streamRepo.findById(streamId);
    if (!stream) return null;
    const row = await this.toAdminRowLive(stream);
    row.uniqueViewerCount =
      await this.viewerSessionRepo.countDistinctUsers(streamId);
    return row;
  }

  /**
   * Owner lists the users currently watching the stream, enriched with
   * username/display-name/avatar (best-effort, via user-service) and each
   * viewer's join time (best-effort, from Redis — null if unavailable). The
   * userId set and join-time hash are both maintained by api-gateway:
   * `stream:session:users:<streamId>` (Hash, userId -> open-socket refcount)
   * and `stream:session:joined:<streamId>` (Hash, userId -> epoch ms).
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
      userIds = await this.redis.hkeys(sessionKey(id));
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
   * Fire-and-forget durable viewer-session record for the HOST as their stream
   * goes LIVE. Called from `handlePublish`/`markLive` on a fresh (non-resume)
   * transition so `LivestreamViewerSession` always contains the host —
   * otherwise `viewerCount` (and the admin viewer list) would silently miss
   * them, since the host publishes via SRS/RTMP and never emits `stream:join`.
   * Idempotent (see {@link LivestreamViewerSessionRepository.recordJoin}), so
   * a later socket-based host join reuses this same open row and
   * `closeAllOpenForStream` closes it alongside every viewer on ENDED.
   */
  private async recordHostViewerJoin(
    streamId: string,
    creatorId: string
  ): Promise<void> {
    try {
      await this.viewerSessionRepo.recordJoin(streamId, creatorId);
    } catch (error) {
      logger.warn(
        `recordHostViewerJoin failed for stream=${streamId}: ${String(error)}`
      );
    }
  }

  /**
   * Durable join record (called by the gateway, fire-and-forget, right after
   * the Redis `SADD` on `stream:join`). Redis stays the source of truth for
   * CURRENT live presence/count; this is the persisted history the admin panel
   * reads. Idempotent — a rejoin while already open reuses the open session
   * (see {@link LivestreamViewerSessionRepository.recordJoin}).
   */
  async recordViewerJoin(streamId: string, userId: string): Promise<void> {
    try {
      await this.viewerSessionRepo.recordJoin(streamId, userId);
    } catch (error) {
      logger.warn(
        `recordViewerJoin failed for stream=${streamId} user=${userId}: ${String(error)}`
      );
    }
  }

  /**
   * Close the durable viewer session (called by the gateway, fire-and-forget,
   * from `stream:leave`, socket `disconnect`, and ban-kick). No-op when there
   * is no open session for this user (duplicate leave, or a leave for a stream
   * the socket never actually joined).
   */
  async recordViewerLeave(streamId: string, userId: string): Promise<void> {
    try {
      await this.viewerSessionRepo.recordLeave(streamId, userId);
    } catch (error) {
      logger.warn(
        `recordViewerLeave failed for stream=${streamId} user=${userId}: ${String(error)}`
      );
    }
  }

  /**
   * Best-effort close-out of every still-open viewer session when a stream
   * ends, so an unexpected disconnect (crash, network drop, no `stream:leave`)
   * never leaves a session open forever. Called from every ENDED transition —
   * owner stop, SRS on_unpublish, admin force-end, and the stale-stream
   * sweeper. Never throws into the caller.
   */
  private async closeOpenViewerSessions(
    streamId: string,
    endedAt: Date
  ): Promise<void> {
    try {
      await this.viewerSessionRepo.closeAllOpenForStream(streamId, endedAt);
    } catch (error) {
      logger.warn(
        `closeOpenViewerSessions failed for stream=${streamId}: ${String(error)}`
      );
    }
  }

  /**
   * Admin: paginated, PER-USER viewer history for a stream (the "Livestream
   * User List" screen). A rejoin/reconnect produces multiple underlying
   * session rows, but this returns exactly one aggregated entry per unique
   * user — see {@link LivestreamViewerSessionRepository.listByStream}.
   */
  async adminListViewerSessions(
    streamId: string,
    params: {
      page: number;
      limit: number;
      sortField: "joinedAt" | "watchDurationSeconds";
      sortDir: "asc" | "desc";
    }
  ): Promise<{
    sessions: Array<{
      userId: string;
      joinedAt: Date;
      leftAt: Date | null;
      watchDurationSeconds: number;
    }>;
    total: number;
  }> {
    const skip = (params.page - 1) * params.limit;
    const { rows, total } = await this.viewerSessionRepo.listByStream(
      streamId,
      {
        skip,
        take: params.limit,
        sortField: params.sortField,
        sortDir: params.sortDir,
      }
    );
    const now = Date.now();
    return {
      sessions: rows.map((r) => ({
        userId: r.userId,
        joinedAt: r.joinedAt,
        leftAt: r.leftAt,
        // Aggregated total already sums every CLOSED session for this user;
        // top up with the currently-open session's live elapsed time (if
        // any), same as the pre-aggregation per-row live-compute.
        watchDurationSeconds:
          r.watchDurationSeconds +
          (r.openSessionJoinedAt
            ? Math.max(
                0,
                Math.round((now - r.openSessionJoinedAt.getTime()) / 1000)
              )
            : 0),
      })),
      total,
    };
  }

  /**
   * Returns true when the creator has a LIVE or RECONNECTING stream in any
   * community. Backs the `CheckCreatorHasActiveStream` gRPC RPC consumed by
   * community-service to populate `currentUserIsStreaming` in API responses.
   */
  async hasActiveStreamByCreator(creatorId: string): Promise<boolean> {
    const count = await this.streamRepo.countLiveByCreator(creatorId);
    return count > 0;
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
        hlsQualities: {},
        flvUrl: null,
        flvQualities: {},
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
        hlsQualities: {},
        flvUrl: null,
        flvQualities: {},
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
          hlsQualities: {},
          flvUrl: null,
          flvQualities: {},
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
      hlsQualities: buildHlsQualityUrls(stream.hlsUrl),
      flvUrl: stream.flvUrl,
      flvQualities: buildFlvQualityUrls(stream.flvUrl),
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
      // A community-service outage (throw) is treated as "member, not closed"
      // so viewers aren't locked out of live streams during infra hiccups.
      let isMember: boolean;
      let isCommunityClosed: boolean;
      try {
        const membership = await this.communityClient.validateMembership(
          stream.communityId,
          userId
        );
        isMember = membership.isMember;
        isCommunityClosed = membership.isCommunityClosed;
      } catch (error) {
        logger.warn(
          `checkAccess: community service unavailable for stream=${streamId} user=${userId}: ${String(error)}`
        );
        isMember = true; // fail-open — don't black out live streams
        isCommunityClosed = false;
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
        canComment:
          (isMember ? canComment : false) && !isMuted && !isCommunityClosed,
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
   * Admin bans a user from the stream and community-wide. Authorization
   * (ADMIN-only, cannot ban another admin) is enforced by community-service.
   * Also writes a local per-stream ban record and publishes `stream:banned`
   * so the gateway kicks live sockets in real time.
   */
  async banUser(
    streamId: string,
    requesterId: string,
    targetUserId: string,
    reason?: string
  ): Promise<void> {
    const stream = await this.streamRepo.findById(streamId);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");

    // Community-service enforces ADMIN-only and blocks banning another admin.
    const result = await this.communityClient.banMember(
      stream.communityId,
      requesterId,
      targetUserId,
      reason ?? ""
    );
    if (!result.ok) {
      throw moderationErrorToAppError(result.errorCode);
    }

    let snapshotUsername: string | null = null;
    let snapshotDisplayName: string | null = null;
    try {
      const [snap] = await this.userClient.bulkGetUserSnapshots([targetUserId]);
      if (snap) {
        snapshotUsername = snap.username ?? null;
        snapshotDisplayName = snap.displayName ?? null;
      }
    } catch (error) {
      logger.warn(
        `ban user snapshot failed for user=${targetUserId}: ${String(error)}`
      );
    }

    await this.banRepo.ban({
      livestreamId: streamId,
      bannedUserId: targetUserId,
      bannedBy: requesterId,
      reason: reason ?? null,
      snapshotUsername,
      snapshotDisplayName,
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

  /** Admin lifts a ban — community-wide and local per-stream. Idempotent. */
  async unbanUser(
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

    await this.banRepo.unban(streamId, targetUserId);
  }

  /** Admin lists who is banned from the stream. */
  async listBans(streamId: string, requesterId: string): Promise<BanView[]> {
    const stream = await this.streamRepo.findById(streamId);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    const membership = await this.communityClient.validateMembership(
      stream.communityId,
      requesterId
    );
    if (membership.role !== "ADMIN") {
      throw new ForbiddenError("STREAM_NOT_OWNER");
    }
    const bans = await this.banRepo.listByStream(streamId);
    return bans.map((b) => ({
      userId: b.bannedUserId,
      username: b.snapshotUsername ?? null,
      displayName: b.snapshotDisplayName ?? null,
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
            (await this.redis.hexists(sessionKey(stream.id), userId)) === 1;
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
            (await this.redis.hexists(sessionKey(stream.id), userId)) === 1;
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
      viewerCount = await this.redis.hlen(sessionKey(streamId));
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
    // Extra fields so the gateway can send targeted events to the broadcaster's
    // socket. For LIVE: includes hlsUrl/flvUrl/startedAt for stream:broadcast:live.
    // For ENDED: only creatorId is needed so the gateway can find and notify the
    // broadcaster even if they've already left the stream room (e.g. after a ban kick).
    broadcasterCtx?: {
      creatorId: string;
      hlsUrl?: string | null;
      flvUrl?: string | null;
      startedAt?: number;
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
   * Fire-and-forget: poll SRS for the first real frame after a stream goes
   * LIVE and broadcast `stream:playable` once confirmed, so viewers who land
   * on the watch page in the first instant (the broadcaster included) know to
   * hold off mounting the player instead of racing an empty HLS/FLV source.
   * Bounded to {@link PLAYABLE_POLL_MAX_ATTEMPTS} — if SRS never reports
   * frames (e.g. the publisher dropped immediately), this simply gives up;
   * the player's own retry/backoff logic remains the fallback either way.
   * Skipped for sources SRS never ingests (URL/YOUTUBE embeds).
   */
  private notifyWhenPlayable(stream: Livestream): void {
    if (stream.sourceType === "URL" || stream.sourceType === "YOUTUBE") return;
    void (async () => {
      for (let attempt = 0; attempt < PLAYABLE_POLL_MAX_ATTEMPTS; attempt++) {
        let ready = false;
        try {
          ready = await this.srsService.hasFrames(stream.streamKey);
        } catch (error) {
          logger.warn(
            `notifyWhenPlayable: hasFrames check failed for stream=${stream.id}: ${String(error)}`
          );
        }
        if (ready) {
          try {
            await this.redis.publish(
              `stream:${stream.id}`,
              JSON.stringify({
                event: "stream:playable",
                data: { streamId: stream.id, communityId: stream.communityId },
              })
            );
          } catch (error) {
            logger.warn(
              `stream:playable broadcast failed for stream=${stream.id}: ${String(error)}`
            );
          }
          return;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, PLAYABLE_POLL_INTERVAL_MS)
        );
      }
      logger.info(
        `notifyWhenPlayable: gave up waiting for frames on stream=${stream.id} after ${String(PLAYABLE_POLL_MAX_ATTEMPTS)} attempts`
      );
    })();
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
    stream: Livestream,
    liveStreamCount: number
  ): Promise<void> {
    logger.info(
      `🔴 [STREAM:LIVE] publishCommunityStreamStarted → Redis channel=community:${stream.communityId} streamId=${stream.id} title="${stream.title ?? ""}"`
    );
    try {
      const host = await this.resolveHost(stream.creatorId);
      const cappedCount = Math.min(
        liveStreamCount,
        env.STREAM_MAX_CONCURRENT_PER_COMMUNITY
      );
      const startedAt = stream.livedAt?.getTime() ?? Date.now();
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
            sourceType: stream.sourceType,
            sourceUrl: stream.sourceUrl ?? null,
            hlsUrl: stream.hlsUrl ?? null,
            flvUrl: stream.flvUrl ?? null,
            dashUrl: stream.dashUrl ?? null,
            youtubeVideoId: extractYoutubeVideoId(stream.sourceUrl),
            status: "LIVE",
            startedAt,
            livedAt: startedAt,
            liveStreamCount: cappedCount,
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
   * `hasActiveLivestream`/`liveStreamCount`, not the event's presence.
   */
  private async publishCommunityStreamEnded(
    stream: Livestream,
    liveStreamCount: number,
    reason = "HOST_ENDED"
  ): Promise<void> {
    try {
      const host = await this.resolveHost(stream.creatorId);
      const cappedCount = Math.min(
        liveStreamCount,
        env.STREAM_MAX_CONCURRENT_PER_COMMUNITY
      );
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
            liveStreamCount: cappedCount,
            hasActiveLivestream: cappedCount > 0,
            reason, // e.g. HOST_ENDED, MEMBER_BANNED, MEMBER_REMOVED, ROLE_UPDATED
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
