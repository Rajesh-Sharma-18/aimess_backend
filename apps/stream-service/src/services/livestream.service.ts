import { randomBytes } from "node:crypto";

import { logger } from "@aimess/logger";
import {
  ForbiddenError,
  NotFoundError,
  ConflictError,
  BadRequestError,
} from "@aimess/errors";

import { env } from "../config/env.js";
import type { Livestream } from "../generated/prisma/index.js";
import type { LivestreamRepository } from "../repositories/livestream.repository.js";
import type { SrsService, IngestEndpoints } from "./srs.service.js";
import type { CommunityGrpcClient } from "../grpc/community.client.js";
import type { redis as RedisClient } from "../config/redis.js";
import { publishStreamEvent } from "../events/index.js";

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
  hlsUrl: string | null;
  flvUrl: string | null;
  viewerCount: number;
  peakViewers: number;
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

function toView(s: Livestream): StreamView {
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
    livedAt: s.livedAt,
    endedAt: s.endedAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export class LivestreamService {
  constructor(
    private readonly streamRepo: LivestreamRepository,
    private readonly srsService: SrsService,
    private readonly communityClient: CommunityGrpcClient,
    private readonly redis: typeof RedisClient,
    private readonly eventPublisher: typeof publishStreamEvent = publishStreamEvent
  ) {}

  /**
   * Go-live: authorize the creator (membership gate, optional), enforce the
   * per-community concurrency cap, mint a stream key + playback URLs and persist
   * a PENDING stream. Returns the record plus owner-only ingest endpoints.
   */
  async createStream(params: {
    communityId: string;
    creatorId: string;
    title: string;
    description?: string;
    sourceType: string;
    sourceUrl?: string;
  }): Promise<CreateStreamResult> {
    if (env.STREAM_REQUIRE_MEMBERSHIP) {
      const membership = await this.communityClient.validateMembership(
        params.communityId,
        params.creatorId
      );
      if (!membership.isMember) {
        throw new ForbiddenError("STREAM_NOT_A_COMMUNITY_MEMBER");
      }
    }

    const active = await this.streamRepo.countActiveByCommunity(
      params.communityId
    );
    if (active >= env.STREAM_MAX_CONCURRENT_PER_COMMUNITY) {
      throw new ConflictError("STREAM_COMMUNITY_CONCURRENCY_LIMIT");
    }

    if (params.sourceType === "URL" && !params.sourceUrl) {
      throw new BadRequestError("STREAM_SOURCE_URL_REQUIRED");
    }

    const streamKey = randomBytes(16).toString("hex");
    const playback = this.srsService.buildPlaybackUrls(streamKey);

    const created = await this.streamRepo.create({
      communityId: params.communityId,
      creatorId: params.creatorId,
      title: params.title,
      description: params.description ?? "",
      sourceType: params.sourceType,
      sourceUrl: params.sourceUrl ?? null,
      streamKey,
      status: "PENDING",
      hlsUrl: playback.hlsUrl,
      flvUrl: playback.flvUrl,
    });

    return {
      ...toView(created),
      streamKey,
      ingest: this.srsService.buildIngestEndpoints(streamKey),
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

    const playback = this.srsService.buildPlaybackUrls(streamKey);
    const updated = await this.streamRepo.updateById(stream.id, {
      status: "LIVE",
      livedAt: new Date(),
      hlsUrl: playback.hlsUrl,
      flvUrl: playback.flvUrl,
    });

    await this.publishStatus(updated.id, "LIVE");
    this.eventPublisher("stream.started", {
      streamId: updated.id,
      communityId: updated.communityId,
      creatorId: updated.creatorId,
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

    await this.publishStatus(updated.id, "ENDED");
    this.eventPublisher("stream.ended", {
      streamId: updated.id,
      communityId: updated.communityId,
      creatorId: updated.creatorId,
      endedAt: updated.endedAt?.getTime() ?? Date.now(),
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

    await this.publishStatus(updated.id, "ENDED");
    this.eventPublisher("stream.ended", {
      streamId: updated.id,
      communityId: updated.communityId,
      creatorId: updated.creatorId,
      endedAt: updated.endedAt?.getTime() ?? Date.now(),
      peakViewers: updated.peakViewers,
    });

    return toView(updated);
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

  /** Single stream, with the live Redis viewer count merged in when present. */
  async getStream(id: string): Promise<StreamView> {
    const stream = await this.streamRepo.findById(id);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    const view = toView(stream);

    try {
      const liveCount = await this.redis.get(`stream:viewers:${id}`);
      if (liveCount !== null) {
        const parsed = Number(liveCount);
        if (Number.isFinite(parsed)) view.viewerCount = parsed;
      }
    } catch (error) {
      logger.warn(
        `live viewer count read failed for stream=${id}: ${String(error)}`
      );
    }

    return view;
  }

  /** Backs community-service `isLive` enrichment (fail-open caller side). */
  async getActiveStreamsByCommunityIds(
    communityIds: string[]
  ): Promise<string[]> {
    return this.streamRepo.findLiveCommunityIds(communityIds);
  }

  private async publishStatus(streamId: string, status: string): Promise<void> {
    try {
      await this.redis.publish(
        `stream:${streamId}`,
        JSON.stringify({
          event: "stream:status",
          data: { streamId, status },
        })
      );
    } catch (error) {
      logger.warn(
        `status broadcast failed for stream=${streamId}: ${String(error)}`
      );
    }
  }
}
