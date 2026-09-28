import { streamKeyRef } from "../lib/stream-key-ref.js";
import { randomBytes } from "node:crypto";

import {
  extractPublishSecret,
  generatePlaybackId,
  generateStreamKey,
  publishSecretMatches,
  resolveSrsName,
} from "../lib/stream-identity.js";

import { logger } from "@aimess/logger";
import {
  publishAdminActivitySafe,
  USER_AUDIT_ACTIONS,
} from "@aimess/messaging";
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
import { LIVE_STATUSES } from "../repositories/livestream.repository.js";
import type { LivestreamBanRepository } from "../repositories/livestream-ban.repository.js";
import type { LivestreamViewerSessionRepository } from "../repositories/livestream-viewer-session.repository.js";
import { buildHlsQualityUrls, buildFlvQualityUrls } from "./srs.service.js";
import type {
  SrsService,
  IngestEndpoints,
  PlaybackUrls,
} from "./srs.service.js";
import {
  CdnService,
  CDN_PROVIDER,
  SRS_PROVIDER,
  cdnPublisherId,
  cdnPublisherMs,
  isCdnStream,
} from "./cdn.service.js";
import type { CommunityGrpcClient } from "../grpc/community.client.js";
import type { redis as RedisClient } from "../config/redis.js";
import { publishStreamEvent } from "../events/index.js";
import { userGrpcClient } from "../grpc/user.client.js";
import { assertNotSystemBanned, isSystemBanned } from "../lib/system-ban.js";

const hostSessionKey = (sessionId: string) => `stream:host-session:${sessionId}`;
// Outlives any realistic broadcast; refreshed on go-live.
const HOST_SESSION_TTL_SEC = 24 * 60 * 60;

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
  /**
   * Which media provider serves this stream: "SRS" or "CDN". Clients do not
   * branch on it — every URL they need is already on this view — but it is the
   * first thing worth knowing in the admin table when one provider misbehaves.
   */
  provider: string;
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
  // ISO timestamp of when the browser publisher reported its camera track
  // ended; null when the source is publishing normally. Lets viewers who
  // join mid-grace render the "camera disconnected" overlay immediately
  // instead of waiting for the next stream:video_lost push.
  videoLostSince: string | null;
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
  /** External source (URL / YOUTUBE modes only) — null for SRS-ingested streams. */
  sourceUrl: string | null;
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
    sourceUrl: s.sourceUrl,
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

/**
 * The `{hlsQualities, flvQualities}` pair for a stream, provider-aware so
 * `toView` and the join-gate snapshot stay in sync. CDN rungs come from the
 * transcode ladder (`buildQualityUrls`, token-signed per rung); SRS rungs are
 * derived from the stored URL pattern. Gated on `hlsUrl` so a stream with no
 * playback yet (YOUTUBE, pre-live) advertises no renditions — same as the SRS
 * helpers returning `{}` on a null URL.
 */
function qualityMapsFor(
  s: Livestream & { provider?: string | null },
  cdn: CdnService
): { hlsQualities: Record<string, string>; flvQualities: Record<string, string> } {
  if (isCdnStream(s) && s.hlsUrl) {
    const q = cdn.buildQualityUrls(resolveSrsName(s));
    return { hlsQualities: q.hls, flvQualities: q.flv };
  }
  return {
    hlsQualities: buildHlsQualityUrls(s.hlsUrl),
    flvQualities: buildFlvQualityUrls(s.flvUrl),
  };
}

function toView(
  s: Livestream & { dashUrl?: string | null; provider?: string | null },
  cdn: CdnService
): StreamView {
  const qualities = qualityMapsFor(s, cdn);
  return {
    id: s.id,
    communityId: s.communityId,
    creatorId: s.creatorId,
    title: s.title,
    description: s.description,
    thumbnail: s.thumbnail,
    sourceType: s.sourceType,
    sourceUrl: s.sourceUrl,
    // Rows created before the CDN split carry no provider and are SRS.
    provider: s.provider ?? SRS_PROVIDER,
    status: s.status,
    commentStatus: s.commentStatus,
    hlsUrl: s.hlsUrl,
    hlsQualities: qualities.hlsQualities,
    flvUrl: s.flvUrl,
    flvQualities: qualities.flvQualities,
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
    private readonly userClient: typeof userGrpcClient = userGrpcClient,
    // CDNetworks (RTMP ingest + HLS/FLV delivery) for OBS/mobile streams.
    // Stateless and dependency-free, so it defaults in place rather than being
    // threaded through server.ts.
    private readonly cdnService: CdnService = new CdnService()
  ) {}

  /**
   * First tick at which the CDN's status API stopped reporting a stream that we
   * still believe is LIVE. Recovers a dropped end callback: the CDN documents
   * no retry, so a lost callback would otherwise pin the row LIVE forever and
   * block that creator's one-active-stream slot.
   *
   * ponytail: per-process and reset on restart — worst case is one extra
   * absence window before an end. Move to Redis if several replicas ever need
   * to agree on the timing.
   */
  private readonly cdnAbsentSince = new Map<string, number>();

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
    /** Protocol the caller will publish with — "whip" (or absent) keeps SRS. */
    ingest?: "whip" | "rtmp";
    /** Test override of STREAM_PROVIDER_DEFAULT. */
    provider?: "SRS" | "CDN";
  }): Promise<CreateStreamResult> {
    // Before anything else: force-ending a banned host's stream is pointless if
    // they can immediately mint another key here.
    await assertNotSystemBanned(this.redis, params.creatorId);

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

    const provider = this.resolveProvider(
      params.sourceType,
      params.ingest,
      params.provider
    );

    // Rate gate BEFORE the lock: creating a stream writes a row and fans a
    // `stream.created` event out to the whole community, so an unthrottled
    // POST /streams is a community-wide notification amplifier. The LIVE
    // concurrency caps below do not bound it because a new row is PENDING and
    // PENDING never occupies a slot.
    await this.assertCreateRateAllowed(params.creatorId);

    const { created, streamKey } = await this.withCreatorStreamLock(
      params.communityId,
      params.creatorId,
      async () => {
        // Two counts run in parallel — all LIVE-only (PENDING never blocks):
        //   activeAnywhere  — creator is already LIVE in any community
        //   activeByCommunity — community's concurrent-stream cap
        const [activeAnywhere, activeByCommunity, pendingByCreator] =
          await Promise.all([
            this.streamRepo.countLiveByCreator(params.creatorId),
            this.streamRepo.countActiveByCommunity(params.communityId),
            this.streamRepo.countPendingByCreator(params.creatorId),
          ]);
        // Global rule: one active stream per user across all communities.
        if (activeAnywhere > 0) {
          throw new ConflictError("STREAM_ALREADY_ACTIVE");
        }
        if (activeByCommunity >= env.STREAM_MAX_CONCURRENT_PER_COMMUNITY) {
          throw new ConflictError("STREAM_COMMUNITY_CONCURRENCY_LIMIT");
        }
        // PENDING rows were exempt from every cap, so `POST /streams` in a loop
        // wrote unbounded rows — each minting a stream key and publishing a
        // `stream.created` event — until the 10-minute stale-PENDING sweeper
        // caught up. The cap is deliberately loose: a broadcaster may abandon
        // one setup and start another, which is two, and anything beyond that
        // is not a person configuring a stream.
        if (pendingByCreator >= env.STREAM_MAX_PENDING_PER_CREATOR) {
          throw new ConflictError("STREAM_ALREADY_ACTIVE");
        }

        // Two DIFFERENT values. `streamKey` authorises publishing and is only
        // ever returned to the owner; `playbackId` is the public name the
        // stream is published and played under. They used to be one value, so
        // the publish credential was the path segment of every viewer's player
        // URL — see lib/stream-identity.ts.
        const streamKey = generateStreamKey();
        const playbackId = generatePlaybackId();

        // YouTube streams embed a remote source — no ingest/playback of ours.
        const playback = isYoutube
          ? null
          : provider === CDN_PROVIDER
            ? this.cdnService.buildPlaybackUrls(playbackId)
            : this.srsService.buildPlaybackUrls(playbackId);

        const created = await this.streamRepo.create({
          playbackId,
          communityId: params.communityId,
          creatorId: params.creatorId,
          title: params.title,
          description: params.description ?? "",
          thumbnail: params.thumbnail ?? null,
          sourceType: params.sourceType,
          sourceUrl: params.sourceUrl ?? null,
          streamKey,
          provider,
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
      ...toView(created, this.cdnService),
      streamKey,
      ingest: isYoutube
        ? {}
        : this.ingestEndpointsFor(created, streamKey),
    };
  }

  /**
   * Picks the media provider for a new stream. Runs once, at create: the row's
   * ingest and playback URLs are minted against the answer, so it can never
   * change afterwards.
   *
   * `sourceType` alone is not enough. PHONE_CAMERA is both the website's
   * WebRTC/WHIP camera and the mobile apps' RTMP camera, and only RTMP can go
   * to the CDN — hence the `ingest` hint. Clients that do not send it (every
   * shipped mobile build) keep landing on SRS.
   */
  private resolveProvider(
    sourceType: string,
    ingest?: "whip" | "rtmp",
    requested?: "SRS" | "CDN"
  ): string {
    // URL/YOUTUBE embeds never touch an ingest server; the CDN has nothing to
    // do for them, and claiming otherwise would mint URLs nobody publishes to.
    const rtmpCapable =
      sourceType === "OBS_RTMP" ||
      (sourceType === "PHONE_CAMERA" && ingest === "rtmp");
    if (!rtmpCapable) {
      if (requested === CDN_PROVIDER) {
        throw new BadRequestError("STREAM_PROVIDER_UNSUPPORTED");
      }
      return SRS_PROVIDER;
    }

    const want = requested ?? env.STREAM_PROVIDER_DEFAULT;
    if (want !== CDN_PROVIDER) return SRS_PROVIDER;
    if (!this.cdnService.isConfigured()) {
      // An explicit request fails loudly; a default that cannot be honoured
      // falls back, so a half-configured environment still streams.
      if (requested === CDN_PROVIDER) {
        throw new BadRequestError("STREAM_PROVIDER_UNAVAILABLE");
      }
      logger.warn(
        "STREAM_PROVIDER_DEFAULT=CDN but CDN_PUSH_DOMAIN/CDN_PLAYBACK_BASE are unset — falling back to SRS"
      );
      return SRS_PROVIDER;
    }
    return CDN_PROVIDER;
  }

  /** Playback URLs minted by the provider that actually serves this row. */
  private playbackUrlsFor(stream: Livestream): PlaybackUrls {
    const name = resolveSrsName(stream);
    return isCdnStream(stream)
      ? this.cdnService.buildPlaybackUrls(name)
      : this.srsService.buildPlaybackUrls(name);
  }

  /** Ingest endpoints minted by the provider that actually serves this row. */
  private ingestEndpointsFor(
    stream: Livestream,
    streamKey: string
  ): IngestEndpoints {
    const name = resolveSrsName(stream);
    return isCdnStream(stream)
      ? this.cdnService.buildIngestEndpoints(name, streamKey)
      : this.srsService.buildIngestEndpoints(name, streamKey);
  }

  /**
   * Everything that can refuse a publish, other than the publish secret itself.
   * Returns a log-safe reason, or null when the publish may proceed.
   *
   * Extracted so the CDN's remote-authentication endpoint answers with exactly
   * the same rules as the SRS `on_publish` hook — a second copy of these four
   * checks would drift the moment one of them changes.
   */
  private async denyPublishReason(stream: Livestream): Promise<string | null> {
    // The hook carries no JWT — it authenticates by stream key alone, so a
    // banned host still holding a key would otherwise re-publish from OBS.
    // Checked before the already-LIVE short-circuit, which allows.
    if (
      await isSystemBanned(this.redis, stream.creatorId, { denyOnError: true })
    ) {
      return `creator=${stream.creatorId} is system-banned`;
    }
    if (stream.status === "ENDED") return "stream is ENDED";

    // Already on air: the caller's own short-circuit handles the bookkeeping,
    // and the two concurrency guards below would otherwise count this very
    // stream against itself.
    if (stream.status === "LIVE") return null;

    const otherActiveStreams =
      await this.streamRepo.countActiveByCommunityAndCreator(
        stream.communityId,
        stream.creatorId,
        stream.id
      );
    if (otherActiveStreams > 0) {
      return `creator=${stream.creatorId} already has an active stream in community=${stream.communityId}`;
    }

    // The community-wide cap, enforced HERE rather than only at create.
    //
    // `createStream` checks it, but a fresh row is PENDING and PENDING never
    // occupies a slot by design — so N different creators could each hold a
    // PENDING row and all publish, putting the community over the cap while
    // `publishCommunityStreamStarted` capped the *reported* count and hid it.
    // PENDING → LIVE is the transition that actually takes the slot.
    //
    // `stream.id` is excluded because a RECONNECTING row already counts itself:
    // without that, resuming a stream in a community at cap would be denied by
    // its own presence in the count.
    //
    // ponytail: count-then-write, like the guard above it. Losing the race needs
    // two publishes inside one DB round trip at exactly the cap; a Redis
    // INCR-with-ceiling keyed on the community and released in finalizeAsEnded
    // is the upgrade if that ever bites.
    if (!(await this.isUnderCommunityCap(stream))) {
      return `community=${stream.communityId} is at its concurrent-stream cap`;
    }

    return null;
  }

  /**
   * Per-creator sliding-window cap on stream creation (Redis INCR + EXPIRE).
   *
   * Fails CLOSED on a Redis error: this guards a community-wide notification
   * fan-out, so an outage must not silently remove it. Creating a stream is a
   * deliberate, low-frequency action, so a brief false rejection during a Redis
   * blip is cheaper than an unthrottled amplifier — and it adds no new failure
   * mode, because `assertNotSystemBanned` above already fails closed on the
   * same client for the same reason (see lib/system-ban.ts). Watch and comment
   * paths keep their fail-open posture.
   */
  private async assertCreateRateAllowed(creatorId: string): Promise<void> {
    const key = `rl:stream-create:${creatorId}`;
    let count: number;
    try {
      count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, env.STREAM_CREATE_RATE_WINDOW_SEC);
      }
    } catch (error) {
      logger.error(
        `stream create rate limiter unavailable (failing closed) creator=${creatorId}: ${String(error)}`
      );
      throw new ConflictError("STREAM_CREATE_RATE_LIMITED");
    }
    if (count > env.STREAM_CREATE_RATE_MAX) {
      logger.warn(
        `stream create rate limit hit creator=${creatorId} count=${count}`
      );
      throw new ConflictError("STREAM_CREATE_RATE_LIMITED");
    }
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
   *
   * `clientId` is SRS's `client_id` for the publishing connection. It is
   * recorded on the row so a late on_unpublish from a SUPERSEDED connection can
   * be told apart from the real one — see {@link handleUnpublish}.
   */
  async handlePublish(
    srsName: string,
    clientId?: string,
    /**
     * The publish secret SRS forwarded from the publish URL's query string, or
     * `"trusted"` for the internal reconciler, which is reacting to a publish
     * SRS has already accepted rather than authorising a new one.
     */
    publishAuth: { secret: string } | "trusted" = { secret: "" }
  ): Promise<boolean> {
    const stream = await this.streamRepo.findBySrsName(srsName);
    if (!stream) {
      logger.warn(
        `on_publish for unknown stream name=${streamKeyRef(srsName)} — denying`
      );
      return false;
    }

    // The publish credential.
    //
    // This hook carries no JWT and is the ONLY gate on who may publish. It used
    // to authenticate on the stream name alone — and that name was also the
    // path segment of every viewer's playback URL, so any viewer could read it
    // out of the player and take over the broadcast. Streams publish under a
    // public name and prove the right to do so with `?secret=`.
    //
    // No grandfather clause: a row with no `playbackId` (created before the
    // split, 31fd2a2c) used to skip this check entirely, and forever — the
    // exemption was keyed on the row's shape rather than on a date, so it also
    // covered any row a restore or a future code path produced without one.
    //
    // The split is already on staging, so pre-split rows CAN exist there; they
    // are simply old, and any that is still LIVE is a stuck row the sweeper
    // should have ended rather than a broadcast worth protecting. The cost of
    // requiring the secret unconditionally is therefore at most a genuinely
    // on-air pre-split stream at deploy time, which the runbook drains.
    if (publishAuth !== "trusted") {
      if (!publishSecretMatches(publishAuth.secret, stream.streamKey)) {
        logger.warn(
          `on_publish denied for stream id=${stream.id}: missing or wrong publish secret`
        );
        return false;
      }
    }
    const denial = await this.denyPublishReason(stream);
    if (denial) {
      logger.warn(`on_publish denied for stream id=${stream.id}: ${denial}`);
      return false;
    }

    // Already LIVE (e.g. markLive was called manually before the hook fired, or
    // a reconnect's on_publish overtook the previous session's on_unpublish) —
    // allow the publish but skip the re-broadcast so status events fire exactly
    // once. The client id is still recorded: this connection is now the one on
    // air, so any on_unpublish still in flight for the previous one is stale.
    if (stream.status === "LIVE") {
      if (clientId && stream.publisherClientId !== clientId) {
        await this.streamRepo.updateById(stream.id, {
          publisherClientId: clientId,
        });
      }
      logger.info(
        `on_publish for already-LIVE stream id=${stream.id} — allowing without re-broadcast`
      );
      return true;
    }

    const isResume = stream.status === "RECONNECTING";

    const playback = this.playbackUrlsFor(stream);
    const updated = await this.streamRepo.updateById(stream.id, {
      status: "LIVE",
      disconnectedAt: null,
      publisherClientId: clientId ?? null,
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
      publishAdminActivitySafe({
        actorId: updated.creatorId,
        action: USER_AUDIT_ACTIONS.STREAM_STARTED,
        targetType: "stream",
        targetId: updated.id,
        after: { communityId: updated.communityId, title: updated.title },
      });
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
   * LIVE → RECONNECTING for every source type. Publisher-drop always gets the
   * grace window (`STREAM_RECONNECT_GRACE_MS`) — network blip on OBS/RTMP
   * ingest, browser tab remount on WHIP, ffmpeg stall on URL restream. All
   * republish paths (OBS built-in RTMP reconnect ~10s, browser useGoLiveBroadcast
   * republish, ffmpeg respawn) resume the same session on the same streamKey.
   * The sweeper finalizes RECONNECTING streams whose grace window expires
   * without a republish.
   *
   * PENDING → ENDED outright (unpublish with no preceding publish = bad state).
   * RECONNECTING/ENDED → no-op (idempotent against duplicate hooks). A second
   * unpublish while already RECONNECTING must NOT reset `disconnectedAt` — a
   * flapping connection that keeps failing to fully republish must not
   * indefinitely extend its own grace window.
   *
   * STALE HOOKS: a WHIP or RTMP reconnect closes the old publisher and opens
   * a new one. SRS dispatches both hooks on background coroutines and Express
   * serves them concurrently, so the OLD connection's on_unpublish can land
   * AFTER the NEW connection's on_publish. Acting on it would demote a stream
   * whose publisher is very much alive — media keeps flowing, the UI sits on
   * "RECONNECTING" forever, and one grace-window later the reconnect-grace
   * sweeper ends a perfectly healthy broadcast. `clientId` (SRS `client_id`)
   * identifies the connection the hook is about: if it doesn't match the one
   * {@link handlePublish} last put on air, the hook is stale and dropped.
   * Null on either side = unknown provenance → honour the hook, which is the
   * pre-existing behaviour.
   */
  async handleUnpublish(streamKey: string, clientId?: string): Promise<void> {
    const stream = await this.streamRepo.findBySrsName(streamKey);
    if (!stream) {
      logger.warn(
        `on_unpublish for unknown stream key=${streamKeyRef(streamKey)} — ignoring`
      );
      return;
    }
    if (stream.status === "ENDED" || stream.status === "RECONNECTING") {
      return;
    }
    if (
      clientId &&
      stream.publisherClientId &&
      stream.publisherClientId !== clientId
    ) {
      logger.info(
        `on_unpublish: ignoring stale hook for stream id=${stream.id} — client=${clientId} was superseded by client=${stream.publisherClientId}`
      );
      return;
    }

    if (stream.status === "LIVE") {
      const updated = await this.streamRepo.updateById(stream.id, {
        status: "RECONNECTING",
        disconnectedAt: new Date(),
      });
      await this.publishStatus(updated.id, "RECONNECTING", updated.communityId);
      logger.info(
        `on_unpublish: stream id=${stream.id} entering RECONNECTING grace window (source=${stream.sourceType})`
      );
      return;
    }

    // PENDING (never actually went live) → straight to ENDED.
    await this.finalizeAsEnded(stream);
  }

  /**
   * CDN "stream start" callback → the same transition SRS's on_publish drives.
   *
   * `"trusted"` because this callback carries no publish secret: the CDN's
   * documented parameters are the stream name, host, app, client IP, edge IP,
   * port and timestamps. Authorisation happens earlier, at
   * {@link authorizeCdnPublish}, which the CDN calls before accepting the
   * publisher — exactly the split SRS has between its hook and this method.
   *
   * `eventMs` is stored as the publisher marker so a late end callback from a
   * superseded session can be told apart from the current one.
   */
  async handleCdnStart(streamName: string, eventMs: number): Promise<boolean> {
    const stream = await this.streamRepo.findBySrsName(streamName);
    if (!stream) {
      logger.warn(
        `CDN start for unknown stream name=${streamKeyRef(streamName)} — ignoring`
      );
      return false;
    }
    if (!isCdnStream(stream)) {
      logger.warn(
        `CDN start for non-CDN stream id=${stream.id} (provider=${stream.provider ?? SRS_PROVIDER}) — ignoring`
      );
      return false;
    }
    this.cdnAbsentSince.delete(stream.id);
    const wasLive = stream.status === "LIVE";
    const allowed = await this.handlePublish(
      streamName,
      cdnPublisherId(eventMs),
      "trusted"
    );
    if (allowed && !wasLive) {
      logger.info(
        `AIMESS_CDN_WENT_LIVE by=HOOK stream=${stream.id} — vendor stream-start callback`
      );
    }
    return allowed;
  }

  /**
   * CDN "stream end" callback → the same transition SRS's on_unpublish drives
   * (LIVE → RECONNECTING with a grace window, PENDING → ENDED).
   *
   * Staleness is decided HERE and not by `handleUnpublish`'s client-id check.
   * `milltime` is an event timestamp, not a connection id, so it differs
   * between the start and end of the very same session — feeding it into that
   * equality check would drop every end callback and nothing would ever end.
   * Instead the end is compared against the marker the start stored, and
   * `handleUnpublish` is then called with no client id so its own check is
   * skipped.
   */
  async handleCdnEnd(streamName: string, eventMs: number): Promise<void> {
    const stream = await this.streamRepo.findBySrsName(streamName);
    if (!stream) {
      logger.warn(
        `CDN end for unknown stream name=${streamKeyRef(streamName)} — ignoring`
      );
      return;
    }
    if (!isCdnStream(stream)) return;

    const startedMs = cdnPublisherMs(stream.publisherClientId);
    if (startedMs !== null && eventMs < startedMs) {
      logger.info(
        `CDN end: ignoring stale callback for stream id=${stream.id} — event=${eventMs} predates publisher=${startedMs}`
      );
      return;
    }
    this.cdnAbsentSince.delete(stream.id);
    await this.handleUnpublish(streamName, undefined);
  }

  /**
   * CDN remote authentication → allow or deny a publish before the edge accepts
   * it. The CDN's only enforcement point: there is no kick API, so refusing
   * here is also how an ended or banned broadcast is eventually evicted (on the
   * encoder's next reconnect).
   *
   * Runs the same checks as the SRS `on_publish` path via
   * {@link denyPublishReason}; the publish secret is only required once
   * `CDN_REQUIRE_PUBLISH_SECRET` is on, because whether the CDN forwards our
   * query string in `url` has to be confirmed against the live service first.
   */
  async authorizeCdnPublish(params: {
    streamName: string;
    url?: string;
  }): Promise<boolean> {
    const stream = await this.streamRepo.findBySrsName(params.streamName);
    if (!stream) {
      logger.warn(
        `CDN auth denied: unknown stream name=${streamKeyRef(params.streamName)}`
      );
      return false;
    }
    if (!isCdnStream(stream)) {
      logger.warn(`CDN auth denied: stream id=${stream.id} is not a CDN stream`);
      return false;
    }

    if (env.CDN_REQUIRE_PUBLISH_SECRET) {
      const queryStart = params.url?.indexOf("?") ?? -1;
      const secret =
        queryStart >= 0 ? extractPublishSecret(params.url?.slice(queryStart)) : "";
      if (!publishSecretMatches(secret, stream.streamKey)) {
        logger.warn(
          `CDN auth denied for stream id=${stream.id}: missing or wrong publish secret`
        );
        return false;
      }
    }

    const denial = await this.denyPublishReason(stream);
    if (denial) {
      logger.warn(`CDN auth denied for stream id=${stream.id}: ${denial}`);
      return false;
    }
    return true;
  }

  /**
   * Coarse DB viewer-count nudge from SRS on_play/on_stop. The authoritative
   * live count is Redis-owned by the gateway; this just keeps a rough DB number
   * for history. Best-effort — never throws into the hook handler.
   */
  async incrementViewer(streamKey: string, delta: number): Promise<void> {
    try {
      const stream = await this.streamRepo.findBySrsName(streamKey);
      if (!stream) return;
      const next = Math.max(0, stream.viewerCount + delta);
      await this.streamRepo.updateById(stream.id, {
        viewerCount: next,
        ...(next > stream.peakViewers ? { peakViewers: next } : {}),
      });
    } catch (error) {
      logger.warn(
        `incrementViewer failed for key=${streamKeyRef(streamKey)}: ${String(error)}`
      );
    }
  }

  /**
   * Common tail for any transition INTO ENDED: flips status, best-effort kicks
   * the SRS publisher, broadcasts the ENDED status, closes out open viewer
   * sessions, and emits `stream.ended`. Shared by {@link stopStream},
   * {@link adminForceEnd}, and {@link sweepStaleReconnectingStreams} — each arrives at "this stream is
   * over" from a different trigger but must finish the same way. `kickStream`
   * is always safe to call even if the stream never had (or no longer has) an
   * active SRS publisher: it's a no-op lookup-then-DELETE, bounded and
   * swallows its own errors (see SrsService.kickStream).
   */
  private async finalizeAsEnded(
    stream: Livestream,
    reason = "HOST_ENDED",
    // Set by the platform-admin force-end, where backoffice-service already
    // audited `livestream.ended` against the admin who ordered it. Mirroring
    // here as well would land two rows for one force-end.
    skipAdminActivity = false,
    // Whether to force-disconnect a CDN publisher that may still be pushing.
    // OFF by default because the CDN's StopLivestreaming API is limited to ONE
    // call per 5 minutes: only the explicit end paths (host End Live, admin
    // force-end, ban, community close) — where the encoder is likely still live
    // — set this true. The natural-end paths (a PENDING timeout, the
    // reconnect-grace sweeper) leave it false: the publisher is already gone, so
    // there is nothing to kick and no reason to spend the scarce budget.
    kickCdnPublisher = false
  ): Promise<Livestream> {
    const updated = await this.streamRepo.updateById(stream.id, {
      status: "ENDED",
      endedAt: new Date(),
    });

    if (isCdnStream(stream)) {
      // MALB's StopLivestreaming (POST /api/live/stop, type=publish) is the
      // disconnect we can call. Best-effort and rate-limited (1/5min), so only
      // fired from the explicit end paths — see kickCdnPublisher above.
      logger.info(
        `AIMESS_CDN_END stream=${stream.id} name=${resolveSrsName(stream)} reason=${reason} kickCdnPublisher=${kickCdnPublisher} — ${kickCdnPublisher ? "calling StopLivestreaming" : "NOT kicking (natural end)"}`
      );
      if (kickCdnPublisher) {
        void this.cdnService.stopPublishing(resolveSrsName(stream));
      }
    } else {
      await this.srsService.kickStream(
        resolveSrsName(stream),
        stream.sourceType
      );
    }

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
    // Only HOST_ENDED is the broadcaster's own doing. An admin force-end, a heartbeat
    // timeout or a reconnect timeout is the platform ending someone else's stream, and
    // attributing those to the broadcaster misreads the trail.
    const hostEnded = reason === "HOST_ENDED";
    if (!skipAdminActivity) {
      publishAdminActivitySafe({
        actorId: hostEnded ? updated.creatorId : null,
        actorType: hostEnded ? "USER" : "SYSTEM",
        action: USER_AUDIT_ACTIONS.STREAM_ENDED,
        targetType: "stream",
        targetId: updated.id,
        after: {
          communityId: updated.communityId,
          creatorId: updated.creatorId,
          durationSeconds: computeDurationSeconds(updated),
          peakViewers: updated.peakViewers,
          reason,
        },
      });
    }
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
    await assertNotSystemBanned(this.redis, requesterId);

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
      ingest: this.ingestEndpointsFor(stream, stream.streamKey),
    };
  }

  async stopStream(id: string, requesterId: string): Promise<StreamView> {
    const stream = await this.streamRepo.findById(id);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    if (stream.creatorId !== requesterId) {
      throw new ForbiddenError("STREAM_NOT_OWNER");
    }

    if (stream.status === "ENDED") {
      return toView(stream, this.cdnService);
    }

    // Host clicked End Live. The encoder (OBS) may still be pushing, so kick it
    // off the CDN — this is the whole point of the feature.
    return toView(
      await this.finalizeAsEnded(stream, "HOST_ENDED", false, true),
      this.cdnService
    );
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
    await assertNotSystemBanned(this.redis, requesterId);

    const stream = await this.streamRepo.findById(id);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    if (stream.creatorId !== requesterId) {
      throw new ForbiddenError("STREAM_NOT_OWNER");
    }
    if (stream.status === "ENDED") {
      throw new BadRequestError("STREAM_ALREADY_ENDED");
    }
    if (stream.status === "LIVE") {
      return toView(stream, this.cdnService);
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

    // Community-wide cap — see the matching guard in handlePublish for why this
    // has to run at the LIVE transition and not only at create.
    if (!(await this.isUnderCommunityCap(stream))) {
      throw new ConflictError("STREAM_COMMUNITY_CONCURRENCY_LIMIT");
    }

    const playback = this.playbackUrlsFor(stream);
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
      publishAdminActivitySafe({
        actorId: updated.creatorId,
        action: USER_AUDIT_ACTIONS.STREAM_STARTED,
        targetType: "stream",
        targetId: updated.id,
        after: { communityId: updated.communityId, title: updated.title },
      });
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

    return toView(updated, this.cdnService);
  }

  /**
   * Admin: force-end a stream. Idempotent — already ENDED streams
   * return { success: false } without error. Otherwise finalizes it ENDED
   * (kicks SRS, broadcasts ENDED status, emits stream.ended) regardless of
   * whether it was LIVE, RECONNECTING, or PENDING.
   */
  async adminForceEnd(
    streamId: string,
    reason: string
  ): Promise<{ success: boolean; status: string }> {
    const stream = await this.streamRepo.findById(streamId);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    if (stream.status === "ENDED") {
      return { success: false, status: stream.status };
    }

    // The reason was accepted and then dropped, so a force-end was indistinguishable
    // from the host ending their own broadcast in every downstream event.
    await this.finalizeAsEnded(stream, reason || "ADMIN_FORCE_ENDED", true, true);

    return { success: true, status: "ENDED" };
  }

  /**
   * Record which auth session started a stream, so revoking that one session
   * (logout, "sign this device out", password change) ends the broadcast it
   * owns without touching one the same user is running from another device.
   * Best-effort: without Redis a revoked host falls back to the publisher
   * dropping (on_unpublish) or an explicit stop.
   */
  async rememberHostSession(streamId: string, sessionId: string): Promise<void> {
    if (!streamId || !sessionId) return;
    const key = hostSessionKey(sessionId);
    try {
      await this.redis
        .multi()
        .sadd(key, streamId)
        .expire(key, HOST_SESSION_TTL_SEC)
        .exec();
    } catch (err) {
      logger.warn(
        `rememberHostSession failed stream=${streamId}: ${String(err)}`
      );
    }
  }

  /**
   * End every still-active stream the revoked session started. SMEMBERS+DEL in
   * one MULTI, so when several replicas hear the same revoke only one of them
   * gets the ids.
   */
  async endStreamsOfRevokedSession(
    userId: string,
    sessionId: string
  ): Promise<{ endedCount: number }> {
    if (!userId || !sessionId) return { endedCount: 0 };
    const key = hostSessionKey(sessionId);
    let streamIds: string[];
    try {
      const results = await this.redis.multi().smembers(key).del(key).exec();
      streamIds = (results?.[0]?.[1] as string[] | undefined) ?? [];
    } catch (err) {
      logger.warn(
        `endStreamsOfRevokedSession: lookup failed session=${sessionId}: ${String(err)}`
      );
      return { endedCount: 0 };
    }
    if (!streamIds.length) return { endedCount: 0 };

    let active: Livestream[];
    try {
      active = await this.streamRepo.findActiveByCreator(userId, undefined);
    } catch (err) {
      logger.warn(
        `endStreamsOfRevokedSession: query failed creator=${userId}: ${String(err)}`
      );
      return { endedCount: 0 };
    }

    let endedCount = 0;
    for (const stream of active) {
      if (!streamIds.includes(stream.id)) continue;
      try {
        await this.finalizeAsEnded(stream, "SESSION_ENDED", false, true);
        endedCount++;
        logger.info(
          `endStreamsOfRevokedSession: ended stream=${stream.id} creator=${userId} session=${sessionId}`
        );
      } catch (err) {
        logger.warn(
          `endStreamsOfRevokedSession: failed to end stream=${stream.id}: ${String(err)}`
        );
      }
    }
    return { endedCount };
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
        await this.finalizeAsEnded(stream, reason, false, true);
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
        await this.finalizeAsEnded(stream, reason, false, true);
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

    return toView(updated, this.cdnService);
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

  /**
   * Cursor-paginated stream list, scoped to ONE community the caller may see.
   *
   * `requesterId` is REQUIRED here: this is the user-facing path. The trusted
   * internal caller uses {@link listStreamsInternal} instead, so a controller
   * that forgets to pass the caller's identity fails loudly rather than
   * silently reopening the enumeration hole below.
   *
   * Every row here carries directly-playable `hlsUrl`/`flvUrl` (and their
   * rendition ladders) through {@link toView}, so this endpoint hands out media
   * access, not just metadata. It therefore enforces the same gates the
   * single-stream read path does:
   *
   *  - `communityId` is REQUIRED. Without it the query degenerates to "every
   *    PENDING/LIVE stream on the platform", which enumerates private
   *    communities and their playback URLs to any authenticated user.
   *  - a community-banned caller gets nothing, matching `getStream`'s ban check
   *    and `checkAccess`'s community-ban gate. Otherwise a user who is 403'd on
   *    `GET /streams/:id` could still read the same hlsUrl out of the list.
   *  - a PRIVATE community requires membership. Non-member viewing is a
   *    deliberate product choice for PUBLIC communities only (see
   *    `checkAccess`'s "Viewing is always allowed" note), and that decision was
   *    never meant to cover discovery of private communities' broadcasts.
   *  - per-stream bans are filtered out of the page (see below).
   *
   * Fail-CLOSED on a community-service error — unlike `checkAccess`, which
   * stays fail-open so an outage cannot black out a stream someone is already
   * watching. Here the failure mode of fail-open is handing every caller a
   * private community's playback URLs, so the right answer on an outage is "no
   * list". See `checkCommunityAccess`.
   */
  async listStreams(params: {
    communityId?: string;
    status?: string;
    limit: number;
    cursor?: string;
    requesterId: string;
  }): Promise<ListStreamsResult> {
    // A user-facing listing is always scoped to one community. The
    // cross-community form is what made this an enumeration oracle, and no
    // client uses it: the UI lists streams within a community.
    if (!params.communityId) {
      throw new BadRequestError("STREAM_COMMUNITY_ID_REQUIRED");
    }

    let access;
    try {
      access = await this.communityClient.checkCommunityAccess(
        params.communityId,
        params.requesterId
      );
    } catch (error) {
      logger.warn(
        `listStreams access check failed (fail-closed) community=${params.communityId} user=${params.requesterId}: ${String(error)}`
      );
      throw new ForbiddenError("STREAM_ACCESS_CHECK_UNAVAILABLE");
    }
    if (access.isBanned) {
      throw new ForbiddenError("STREAM_BANNED");
    }
    if (!access.isMember && !access.isPublicCommunity) {
      throw new ForbiddenError("STREAM_NOT_A_COMMUNITY_MEMBER");
    }

    return this.listStreamsInternal({
      communityId: params.communityId,
      status: params.status,
      limit: params.limit,
      cursor: params.cursor,
      excludeBannedFor: params.requesterId,
    });
  }

  /**
   * UNGATED listing, for trusted in-process and gRPC callers only.
   *
   * Never expose this on a user-facing route: it performs no membership, ban or
   * privacy check, and every row carries playable media URLs. The callers are
   * the `ListCommunityStreams` RPC (which feeds the community's isLive flag,
   * already authorized on the community-service side) and the community-wide
   * mute/ban relays, which must see every live stream in order to kick the
   * target out of it. The REST path goes through {@link listStreams}.
   */
  async listStreamsInternal(params: {
    communityId?: string;
    /** One status, or a set of them — see `listByCommunity`. */
    status?: string | readonly string[];
    limit: number;
    cursor?: string;
    /** When set, drop rows this user is per-stream banned from. */
    excludeBannedFor?: string;
  }): Promise<ListStreamsResult> {
    const rows = await this.streamRepo.listByCommunity({
      communityId: params.communityId,
      status: params.status,
      limit: params.limit + 1,
      cursor: params.cursor,
    });
    const hasMore = rows.length > params.limit;
    const page = hasMore ? rows.slice(0, params.limit) : rows;

    // Per-stream bans, applied as one indexed query over the page — the same
    // gate `getStream` enforces per row. Without it a user banned from a
    // specific stream still reads its playback URL out of the list. Done AFTER
    // paging so a filtered row cannot stall pagination.
    let visible = page;
    if (params.excludeBannedFor) {
      const banned = await this.banRepo.bannedStreamIds(
        params.excludeBannedFor,
        page.map((row) => row.id)
      );
      if (banned.size > 0) {
        visible = page.filter((row) => !banned.has(row.id));
      }
    }
    const items = visible.map((s) => toView(s, this.cdnService));

    // Cursor advances on the LAST ROW READ, not the last row returned —
    // otherwise a page whose tail is entirely banned rows would rewind the
    // cursor and loop forever.
    const nextCursor =
      hasMore && page.length > 0 ? page[page.length - 1]!.id : null;
    return { items, nextCursor, hasMore };
  }

  /**
   * Single stream fetch. When `userId` is provided the caller is gated exactly
   * as they are on the socket join path ({@link checkAccess}): per-stream ban,
   * community-wide ban, and — for a PRIVATE community — membership. The row
   * carries directly-playable `hlsUrl`/`flvUrl`, so this endpoint hands out
   * media access rather than metadata, and it previously enforced only the
   * per-stream ban: any authenticated caller holding a streamId could read a
   * private community's playback URLs straight out of it, bypassing the gate
   * `listStreams` applies to the very same rows.
   *
   * Fail-open on a community-service error, matching `checkAccess`. The live
   * Redis viewer count is merged in when present.
   */
  async getStream(id: string, userId?: string): Promise<StreamView> {
    const stream = await this.streamRepo.findById(id);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");

    if (userId && (await this.banRepo.isBanned(id, userId))) {
      throw new ForbiddenError("STREAM_BANNED");
    }

    if (userId && stream.creatorId !== userId) {
      try {
        const access = await this.communityClient.checkCommunityAccess(
          stream.communityId,
          userId
        );
        if (access.isBanned) throw new ForbiddenError("STREAM_BANNED");
        if (!access.isMember && !access.isPublicCommunity) {
          throw new ForbiddenError("STREAM_NOT_A_COMMUNITY_MEMBER");
        }
      } catch (error) {
        // A deny decided above must not be swallowed by the outage catch.
        if (error instanceof ForbiddenError) throw error;
        logger.warn(
          `getStream: community access check failed for stream=${id} user=${userId}: ${String(error)}`
        );
      }
    }

    const view = toView(stream, this.cdnService);

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
   * Browser publisher reported its camera MediaStreamTrack ended (device
   * unplug, permission revoked). Persist `videoLostAt` so late-joining
   * viewers see the overlay from their join ack, and fan the event to the
   * room over the existing `stream:*` Redis channel — the gateway relays
   * `stream:video_lost` straight to every socket in the stream room.
   *
   * The 60s grace-timer that ends the stream on no recovery lives on the
   * publisher client. A dead publisher client (tab close, crash) drops its
   * SRS connection, so on_unpublish + the reconnect grace end the stream.
   */
  async markVideoLost(id: string, requesterId: string): Promise<void> {
    const stream = await this.streamRepo.findById(id);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    if (stream.creatorId !== requesterId) {
      throw new ForbiddenError("STREAM_NOT_OWNER");
    }
    if (stream.status !== "LIVE") {
      throw new BadRequestError("STREAM_NOT_LIVE");
    }
    const now = new Date();
    await this.streamRepo.updateById(id, { videoLostAt: now });
    try {
      await this.redis.publish(
        `stream:${id}`,
        JSON.stringify({
          event: "stream:video_lost",
          data: {
            streamId: id,
            communityId: stream.communityId,
            videoLostSince: now.toISOString(),
          },
        })
      );
    } catch (error) {
      logger.warn(
        `video_lost broadcast failed for stream=${id}: ${String(error)}`
      );
    }
  }

  async markVideoRestored(id: string, requesterId: string): Promise<void> {
    const stream = await this.streamRepo.findById(id);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    if (stream.creatorId !== requesterId) {
      throw new ForbiddenError("STREAM_NOT_OWNER");
    }
    if (stream.status !== "LIVE") {
      throw new BadRequestError("STREAM_NOT_LIVE");
    }
    await this.streamRepo.updateById(id, { videoLostAt: null });
    try {
      await this.redis.publish(
        `stream:${id}`,
        JSON.stringify({
          event: "stream:video_restored",
          data: { streamId: id, communityId: stream.communityId },
        })
      );
    } catch (error) {
      logger.warn(
        `video_restored broadcast failed for stream=${id}: ${String(error)}`
      );
    }
  }

  /**
   * Persist a video-quality snapshot and relay it to viewers over the same
   * `stream:<id>` Redis channel `publishStatus`/`updateStream` already use
   * (the gateway fans any `stream:*` event straight to the room, so no
   * gateway change is needed for a new event name).
   *
   * Two callers, one method: the browser (WHIP) self-reports via
   * `POST /streams/:id/quality` (`requesterId` set, owner-checked); the OBS sweeper poll (see
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
      // CDN rows get their quality from reconcileCdn's single domain-wide
      // call; asking SRS about a stream it never saw would just log noise.
      if (isCdnStream(stream)) continue;
      try {
        const stats = await this.srsService.getStreamStats(
          resolveSrsName(stream)
        );
        if (!stats) continue;
        await this.reportQuality(stream.id, {
          resolution: `${stats.width}x${stats.height}`,
          bitrateKbps: stats.bitrateKbps,
        });
      } catch (error) {
        logger.warn(
          `pollObsStreamQuality failed for stream=${stream.id}: ${String(error)}`
        );
      }
    }
  }

  /**
   * Background sweeper: reconcile DB↔SRS, auto-end RECONNECTING streams whose
   * reconnect-grace window (`STREAM_RECONNECT_GRACE_MS`) expired without a
   * republish, and auto-cancel PENDING streams that sat unpublished past
   * `STREAM_PENDING_TIMEOUT_MS` (abandoned setup, crashed client, failed
   * publish). A stuck PENDING row otherwise never clears — it permanently
   * occupies that creator's one-active-stream-per-community slot and every
   * subsequent create attempt 409s with STREAM_ALREADY_ACTIVE, even though
   * nothing is actually live. Called periodically from server.ts.
   * Intentionally silent — a single stale stream failure does not block the rest.
   *
   * LIVE streams are never ended here: YOUTUBE/URL embeds end only on an
   * explicit stop or force-end, and SRS-ingested streams leave LIVE only via
   * on_unpublish, which starts the reconnect grace swept below.
   */
  async sweepStaleStreams(): Promise<void> {
    // Reconcile first so a publisher SRS is carrying resumes its RECONNECTING
    // row before the grace sweep could end it.
    await this.reconcileWithSrs();
    // Same ordering rule for the CDN half, and for the same reason.
    await this.reconcileCdn();
    await this.sweepStaleReconnectingStreams();
    await this.sweepStalePendingStreams();
  }

  /**
   * CDN counterpart of {@link reconcileWithSrs}, and the only place CDN stream
   * quality is read.
   *
   * The CDN's lifecycle callbacks have no documented retry and no signature, so
   * this pass is the safety net at both ends:
   * - listed but not LIVE → a start callback was dropped; resume the row.
   * - LIVE but absent for `CDN_ABSENT_TIMEOUT_MS` → an end callback was
   *   dropped; end the row. Absence is trusted here (unlike the SRS pass) only
   *   because it must persist across several ticks AND `listPublishing()`
   *   returns null — not an empty map — whenever the API is unusable.
   *
   * One request per tick covers every stream on the domain: the vendor limit is
   * 100 per 5 minutes and the sweeper ticks every 30 s.
   */
  private async reconcileCdn(): Promise<void> {
    const stats = await this.cdnService.listPublishing();
    // null = no API credentials, or the call failed. Either way the API tells
    // us nothing — fall back to probing each stream's own playback URL if that
    // is switched on, otherwise act on nothing.
    const probing = stats === null && this.cdnService.isProbeEnabled();
    if (stats === null && !probing) return;

    let streams: Livestream[];
    try {
      streams = await this.streamRepo.findActiveByProvider(CDN_PROVIDER);
    } catch (err) {
      logger.warn(`reconcileCdn: DB query failed — ${String(err)}`);
      return;
    }

    const now = Date.now();
    const seen = new Set<string>();

    for (const stream of streams) {
      const name = resolveSrsName(stream);
      seen.add(name);

      try {
        // Two sources, same downstream logic: the API's own list when we have
        // credentials, otherwise one request per stream against its playback
        // URL. `stat` carries quality only in the API case.
        const stat = stats?.get(name) ?? null;
        const publishing = stats
          ? stat !== null
          : await this.cdnService.probeLive(stream.hlsUrl);

        if (publishing) {
          this.cdnAbsentSince.delete(stream.id);
          // RECONNECTING is deliberately NOT resumed from here.
          //
          // After a publisher stops, the CDN status API (and the HLS playlist)
          // keep reporting the stream as "publishing" for 30s–2min — cached
          // segments plus the CDN's own session grace. Trusting that stale
          // "present" to flip RECONNECTING → LIVE fought the reliable end
          // callback and reset the reconnect-grace timer every 30s tick, so an
          // ended stream flapped LIVE↔reconnecting for minutes before finally
          // ending. The end callback is fast (~1s) and authoritative; a genuine
          // reconnect fires its own START callback (handleCdnStart) which
          // resumes LIVE. So a RECONNECTING row is left to those two signals —
          // the start callback resumes it, or the reconnect-grace sweeper ends
          // it. The status API only RECOVERS a dropped FIRST start here, which
          // is unambiguous: a PENDING row never received a start at all.
          if (stream.status === "PENDING") {
            // "trusted" for the same reason the SRS reconciler passes it: the
            // CDN has already accepted this publisher, so there is no publish
            // URL here to read a secret out of.
            await this.handlePublish(name, undefined, "trusted");
            logger.info(
              `AIMESS_CDN_WENT_LIVE by=POLL stream=${stream.id} — status API recovered a missed start callback`
            );
            continue;
          }
          if (stream.status !== "LIVE") {
            // RECONNECTING (or any non-LIVE, non-PENDING) — ignore the status
            // API's presence; wait for a start callback or the grace sweeper.
            continue;
          }
          // Both fields or neither: reportQuality writes what it is given, so
          // a partial sample would blank out the last good reading. The probe
          // path has no quality data at all — only the API reports it.
          if (stat?.resolution && stat.bitrateKbps !== null) {
            await this.reportQuality(stream.id, {
              resolution: stat.resolution,
              bitrateKbps: stat.bitrateKbps,
              ...(stat.fps !== null ? { fps: stat.fps } : {}),
            });
          }
          if (stat?.viewers !== null && stat?.viewers !== undefined) {
            await this.publishCdnViewerCount(stream, stat.viewers);
          }
          continue;
        }

        // PENDING rows are the pending sweeper's business — a stream that has
        // never published is absent by definition.
        if (stream.status !== "LIVE") {
          this.cdnAbsentSince.delete(stream.id);
          continue;
        }

        const since = this.cdnAbsentSince.get(stream.id) ?? now;
        this.cdnAbsentSince.set(stream.id, since);
        if (now - since >= env.CDN_ABSENT_TIMEOUT_MS) {
          this.cdnAbsentSince.delete(stream.id);
          logger.warn(
            `reconcileCdn: stream=${stream.id} absent from the CDN for ${now - since}ms — ending (lost end callback)`
          );
          await this.handleCdnEnd(name, now);
        }
      } catch (err) {
        logger.warn(
          `reconcileCdn: failed for stream=${stream.id} — ${String(err)}`
        );
      }
    }

    // Publishing with no active row: the encoder is burning bandwidth against a
    // stream we consider over, and there is no API to kick it. Logging is the
    // only visibility, and the next reconnect is refused by remote auth. Only
    // the API can see this — the probe path knows nothing beyond our own rows.
    for (const name of stats?.keys() ?? []) {
      if (!seen.has(name)) {
        logger.warn(
          `reconcileCdn: CDN reports name=${streamKeyRef(name)} publishing with no active stream row`
        );
      }
    }
  }

  /**
   * Viewer count as the CDN itself counts it, from the same status response the
   * reconciler already fetches — no extra API call.
   *
   * Published on the stream's Redis channel, which the gateway relays to the
   * room as `stream:viewer_count`: the exact event and shape clients already
   * render, so nothing changes on the frontend. Also persisted so REST reads
   * and the admin table agree with what viewers see.
   *
   * The gateway's own presence-based broadcast must be switched off for this to
   * be the visible number — see VIEWER_COUNT_SOURCE in
   * `api-gateway/src/sockets/namespaces/stream.ns.ts`. With both on, they race
   * and the count flickers between two different answers.
   *
   * Trade-off, measured: this figure lags roughly two minutes behind reality
   * (0 viewers reported at t+65s, correct 5 at t+143s), but it counts EVERY
   * viewer the CDN serves, including anyone playing the raw .m3u8 outside our
   * apps. The socket count is instant but only sees our own clients.
   *
   * Also the only writer of `peakViewers` for CDN streams: SRS on_play/on_stop
   * (incrementViewer) never fires when the CDN serves playback.
   */
  private async publishCdnViewerCount(
    stream: Livestream,
    viewers: number
  ): Promise<void> {
    const streamId = stream.id;
    const count = Math.max(0, viewers);
    try {
      await this.streamRepo.updateById(streamId, {
        viewerCount: count,
        ...(count > stream.peakViewers ? { peakViewers: count } : {}),
      });
      await this.redis.publish(
        `stream:${streamId}`,
        JSON.stringify({
          event: "stream:viewer_count",
          data: { streamId, viewerCount: Math.max(0, viewers) },
        })
      );
      logger.info(
        `AIMESS_CDN_VIEWERS streamId=${streamId} count=${Math.max(0, viewers)} (source=CDN api hists, 30s poll)`
      );
    } catch (error) {
      logger.warn(
        `CDN viewer count publish failed for stream=${streamId}: ${String(error)}`
      );
    }
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
   * is left to on_unpublish + the reconnect-grace sweeper, because acting on
   * it here would mean ending live streams based on an *absence* in the SRS
   * response — and a partial/degraded API reply is indistinguishable from a
   * genuinely empty one. `listPublishers()` returning null on any instance
   * failure is the guard that keeps this pass from acting on bad data at all.
   * Upgrade path: if a lost on_unpublish ever needs recovery, require N
   * consecutive absent observations before ending, rather than trusting a
   * single scan.
   */
  private async reconcileWithSrs(): Promise<void> {
    const publishers = await this.srsService.listPublishers();
    // null = at least one SRS instance was unreachable; skip rather than act on
    // an incomplete picture.
    if (publishers === null) return;
    if (publishers.length === 0) return;

    let streams: Livestream[];
    try {
      streams = await this.streamRepo.findBySrsNames(
        publishers.map((p) => p.streamKey)
      );
    } catch (err) {
      logger.warn(`reconcileWithSrs: DB query failed — ${String(err)}`);
      return;
    }

    // Keyed by the name SRS actually reports, NOT by `streamKey`.
    //
    // `listPublishers()` reads `client.name` — the name a stream is PUBLISHED
    // under, which since the ingest/playback split is the `playbackId`. Keying
    // this map by `streamKey` meant every post-split row was fetched from the
    // DB (findBySrsNames matches either column) and then dropped by the lookup
    // below, so the whole reconciler was inert for new streams: dropped-webhook
    // recovery, orphaned-publisher re-kick and reconnect resume all silently
    // did nothing, and every live publisher logged "unknown name" every tick.
    const bySrsName = new Map(streams.map((s) => [resolveSrsName(s), s]));

    for (const publisher of publishers) {
      const stream = bySrsName.get(publisher.streamKey);

      if (!stream) {
        // Unknown key still publishing. `handlePublish` denies unknown keys, so
        // SRS should already have dropped it — log rather than kick, so a
        // create/publish race can't have its publisher killed mid-handshake.
        logger.warn(
          `reconcileWithSrs: SRS publisher for unknown name=${streamKeyRef(publisher.streamKey)} on ${publisher.apiBase}`
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
          // "trusted": SRS is REPORTING a publish it already accepted, so there
          // is no publish URL to read a secret from. Authorisation happened at
          // the on_publish hook; this only recovers a dropped delivery.
          const allowed = await this.handlePublish(
            publisher.streamKey,
            undefined,
            "trusted"
          );
          logger.info(
            `reconcileWithSrs: recovered missing on_publish stream=${stream.id} status=${stream.status} name=${streamKeyRef(publisher.streamKey)} allowed=${String(allowed)}`
          );
        } catch (err) {
          logger.warn(
            `reconcileWithSrs: failed to recover publish for stream=${stream.id} — ${String(err)}`
          );
        }
        continue;
      }

      // SRS has the publisher and we agree it is LIVE — nothing to repair.
      if (stream.status === "LIVE") continue;

      if (stream.status !== "ENDED" && stream.status !== "CANCELLED") continue;

      const kicked = await this.srsService.kickClientById(
        publisher.apiBase,
        publisher.clientId
      );
      logger.info(
        `reconcileWithSrs: re-kicked orphaned publisher stream=${stream.id} status=${stream.status} name=${streamKeyRef(publisher.streamKey)} success=${String(kicked)}`
      );
    }
  }

  /**
   * Finalizes RECONNECTING streams whose publisher never republished within
   * `STREAM_RECONNECT_GRACE_MS` of the on_unpublish that started the grace
   * window. This is the one place a reconnect-grace stream is actually
   * declared over — see {@link handleUnpublish} (enters the grace window) and
   * {@link handlePublish} (resumes LIVE within it).
   *
   * Before ending anything it re-checks SRS: if the key still has a publisher
   * open, the row is stale bookkeeping (a lost or reordered on_publish hook),
   * not a dead broadcast — resume it rather than killing a stream that is
   * visibly on air. This acts on a publisher's PRESENCE, which a degraded SRS
   * reply can only under-report; the mirror case (absence) is deliberately NOT
   * trusted here, same discipline as {@link reconcileWithSrs}.
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
      `sweepStaleReconnectingStreams: ${stale.length} stream(s) past the reconnect grace window`
    );

    // null = an SRS instance was unreachable; an empty map then means "we know
    // nothing", which degrades to the previous end-everything behaviour.
    const publishers = await this.srsService.listPublishers();
    // Keyed by the name SRS reports (the published name), so the lookup below
    // must use `resolveSrsName` too — see reconcileWithSrs. Reading this map by
    // `stream.streamKey` never matched a post-split row, so the resume branch
    // was unreachable and every stream past its grace window was ended even
    // while SRS still had its publisher open.
    const publishingClientIds = new Map(
      (publishers ?? []).map((p) => [p.streamKey, p.clientId])
    );

    for (const stream of stale) {
      try {
        const srsName = resolveSrsName(stream);
        // CDN reconnect grace. A RECONNECTING CDN row is resumed ONLY by a real
        // start callback (a genuine reconnect) — never by the status API, whose
        // stale "still publishing" would otherwise keep an ended stream alive
        // (see reconcileCdn). So here we simply end it once the grace since
        // disconnect has elapsed with no reconnect. No presence re-check: the
        // status API cannot distinguish "reconnected" from "hasn't caught up
        // yet", and the start callback already covers the real reconnect.
        if (isCdnStream(stream)) {
          const downMs = Date.now() - (stream.disconnectedAt?.getTime() ?? 0);
          if (downMs < env.STREAM_CDN_RECONNECT_GRACE_MS) continue;
          await this.finalizeAsEnded(stream);
          logger.info(
            `sweepStaleReconnectingStreams: ended CDN stream=${stream.id} community=${stream.communityId}`
          );
          continue;
        }
        const clientId = publishingClientIds.get(srsName);
        // "trusted", for the same reason reconcileWithSrs passes it: SRS has
        // ALREADY accepted this publisher — `listPublishers()` is where the
        // clientId came from — so there is no publish URL here to read a secret
        // out of, and authorisation happened at that publisher's on_publish.
        //
        // This used to fall through to the default `{ secret: "" }`, which the
        // secret check then rejected, so the resume branch could never be taken
        // for a stream that had one: the sweeper asked SRS, SRS said "still
        // publishing", and the stream was finalized as ENDED anyway — the exact
        // outcome this re-check exists to prevent.
        if (
          clientId &&
          (await this.handlePublish(srsName, clientId, "trusted"))
        ) {
          logger.info(
            `sweepStaleReconnectingStreams: resumed stream=${stream.id} — SRS still has publisher client=${clientId}`
          );
          continue;
        }
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
        // gotten as far as opening the ingest connection. No-op for CDN rows:
        // that provider has no disconnect API.
        if (!isCdnStream(stream)) {
          await this.srsService.kickStream(
            resolveSrsName(stream),
            stream.sourceType
          );
        }
        const liveStreamCount = await this.streamRepo.countLiveByCommunity(
          updated.communityId
        );
        await this.publishStatus(updated.id, "ENDED", updated.communityId);
        void this.publishCommunityStreamEnded(updated, liveStreamCount);
        // The sweeper is the one end path that bypasses finalizeAsEnded, so it also
        // bypassed the audit row. It never went live — record it as SYSTEM.
        publishAdminActivitySafe({
          actorId: null,
          actorType: "SYSTEM",
          action: USER_AUDIT_ACTIONS.STREAM_ENDED,
          targetType: "stream",
          targetId: updated.id,
          after: {
            communityId: updated.communityId,
            creatorId: updated.creatorId,
            reason: "PENDING_TIMEOUT",
            neverWentLive: true,
          },
        });
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
  /**
   * True when `stream` may occupy a live slot in its community.
   *
   * Shared by the two paths that flip a stream to LIVE. Excludes the stream's
   * own row, so a RECONNECTING stream resuming does not count itself out. Logs
   * on refusal: `handlePublish` answers SRS with a bare deny and `markLive`
   * throws a 409, and neither carries a reason the broadcaster can see, so this
   * line is the only diagnostic when someone asks why a publish was dropped.
   */
  private async isUnderCommunityCap(stream: Livestream): Promise<boolean> {
    const active = await this.streamRepo.countActiveByCommunity(
      stream.communityId,
      stream.id
    );
    if (active < env.STREAM_MAX_CONCURRENT_PER_COMMUNITY) return true;
    logger.warn(
      `go-live denied for stream id=${stream.id}: community=${stream.communityId} already has ${String(active)} live stream(s), cap=${String(env.STREAM_MAX_CONCURRENT_PER_COMMUNITY)}`
    );
    return false;
  }

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
        videoLostSince: null,
      };
    }

    // Bans always win, even for would-be members. A permanent system ban is
    // one of them, read in parallel so the join gate costs no extra round-trip.
    // Fail-open on a Redis error like every other read here: the gateway
    // handshake rejects a banned user's socket before it ever gets this far.
    const [streamBanned, systemBanned] = await Promise.all([
      this.banRepo.isBanned(streamId, userId),
      isSystemBanned(this.redis, userId, { denyOnError: false }),
    ]);
    if (streamBanned || systemBanned) {
      return {
        allowed: false,
        isBanned: true,
        status: "",
        reason: systemBanned ? "ACCOUNT_BANNED" : "BANNED",
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
        videoLostSince: null,
      };
    }

    // Community-wide ban (ADMIN-applied in community-service) is a hard block —
    // same shape as the local per-stream ban, including for the owner (a banned
    // member loses the stream too, no exceptions).
    //
    // The SAME call also decides whether this user may see the stream at all.
    // Viewing used to be ungated by membership entirely ("non-members can watch
    // silently"), which is the right product choice for a PUBLIC community and
    // was never meant to cover a PRIVATE one — but the check did not
    // distinguish them, so any authenticated user who had a streamId could join
    // a private community's broadcast and receive its playback URLs.
    // `listStreams` already gates on exactly this (see checkCommunityAccess
    // there); this closes the same hole on the join path.
    //
    // `checkCommunityAccess` and `checkBan` are the same underlying RPC —
    // `checkCommunityMembership` — so reading membership and visibility here
    // costs nothing over the ban check it replaces.
    //
    // Fail-open on a community-service outage: consistent with every other
    // community-service read in this method, an outage must not black out
    // viewing on its own — the local ban above remains the always-available,
    // synchronous hard gate. (listStreams fails CLOSED on the same call, and
    // deliberately: it hands out a whole community's playback URLs, where this
    // gates one stream the caller already knows the id of.)
    try {
      const communityAccess = await this.communityClient.checkCommunityAccess(
        stream.communityId,
        userId
      );
      if (communityAccess.isBanned) {
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
          videoLostSince: null,
        };
      }
      // Owner exempt: a creator whose membership lapsed still reaches their own
      // stream, matching the owner short-circuit further down.
      if (
        !communityAccess.isMember &&
        !communityAccess.isPublicCommunity &&
        stream.creatorId !== userId
      ) {
        return {
          allowed: false,
          isBanned: false,
          status: "",
          reason: "NOT_MEMBER",
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
          videoLostSince: null,
        };
      }
    } catch (error) {
      logger.warn(
        `checkAccess: community access check failed for stream=${streamId} user=${userId}: ${String(error)}`
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
      ...qualityMapsFor(stream, this.cdnService),
      videoLostSince: stream.videoLostAt
        ? stream.videoLostAt.toISOString()
        : null,
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
    await this.relayToPresentStreams(communityId, userId, (streamId) => ({
      event: isMuted ? "stream:member_muted" : "stream:member_unmuted",
      data: { streamId, userId, mutedUntil },
    }));
  }

  /**
   * Publish an event to every stream in `communityId` that `userId` is actually
   * present in (as a viewer, or as its creator). Shared by the mute and ban
   * relays, whose bodies were otherwise identical — and which both used to ask
   * for `status: "LIVE"` alone.
   *
   * That exact-match filter is the bug this closes: a stream whose publisher is
   * mid-blip sits in RECONNECTING, so it was excluded, and a member banned or
   * muted during a reconnect was never kicked and never told. Every other
   * consumer in the service counts RECONNECTING as still-going; this asks for
   * the same `LIVE_STATUSES` set rather than one status, so it cannot drift
   * again.
   *
   * Best-effort throughout — a relay failure must never fail the
   * community-service caller that triggered the moderation action.
   */
  private async relayToPresentStreams(
    communityId: string,
    userId: string,
    build: (streamId: string) => { event: string; data: unknown }
  ): Promise<void> {
    let liveStreams: StreamView[];
    try {
      ({ items: liveStreams } = await this.listStreamsInternal({
        communityId,
        status: LIVE_STATUSES,
        limit: 50,
      }));
    } catch (error) {
      logger.warn(
        `relayToPresentStreams: listStreams failed for community=${communityId}: ${String(error)}`
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
          JSON.stringify(build(stream.id))
        );
      } catch (error) {
        logger.warn(
          `relayToPresentStreams: publish failed for stream=${stream.id}: ${String(error)}`
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
    await this.relayToPresentStreams(communityId, userId, (streamId) => ({
      event: "stream:banned",
      data: { streamId, userId },
    }));
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

    return toView(updated, this.cdnService);
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
    // Bump the admin livestream list. Every status transition (LIVE, ENDED,
    // CANCELLED, RECONNECTING) may change what the panel's datatable shows, so
    // the single choke point publishStatus is the right place. Payload is empty
    // by contract — the panel refetches on receipt, so the refetch is the source
    // of truth and no field can drift. Fanned out to EVERY /admin socket via a
    // shared `admin:broadcast` room; safe because no data leaves the gateway.
    try {
      await this.redis.publish(
        "admin:broadcast",
        JSON.stringify({ event: "admin:livestreams:changed", data: {} })
      );
    } catch (error) {
      logger.warn(
        `admin livestreams broadcast failed for stream=${streamId}: ${String(error)}`
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
    // The CDN has no "has the first frame arrived yet" probe, and its status
    // API lags ~30s — far longer than this poll's budget. Players fall back to
    // their own retry/backoff, which is what this event only nudges anyway.
    if (isCdnStream(stream)) return;
    void (async () => {
      for (let attempt = 0; attempt < PLAYABLE_POLL_MAX_ATTEMPTS; attempt++) {
        let ready = false;
        try {
          ready = await this.srsService.hasFrames(resolveSrsName(stream));
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
