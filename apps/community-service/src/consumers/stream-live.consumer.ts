import { logger } from "@aimess/logger";
import amqp from "amqplib";
import { publishChatUserEvent } from "@aimess/redis";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";
import { communityRepository } from "../repositories/community.repository.js";

/**
 * Consumes `stream.started` and `stream.ended` events from the `aimess.events`
 * topic exchange and fans them out to every active community member via their
 * personal `user:<userId>` Redis channel.
 *
 * Why this is needed: the stream-service also publishes these events directly to
 * the `community:<communityId>` Redis channel, but that only reaches clients who
 * have explicitly joined the community room (community:join). Users browsing the
 * community list sidebar or home screen are connected to /community but haven't
 * joined specific community rooms — they miss the live indicator update entirely
 * and have to refresh. This consumer closes that gap by delivering the event to
 * every member's personal channel regardless of which room they're in.
 */

const EXCHANGE = "aimess.events";
const QUEUE = "stream.live.community.queue";
const DLX = "stream.live.community.queue.dlx";
const DLQ = "stream.live.community.queue.dlq";
const DLQ_ROUTING_KEY = "stream.live.community.queue.dead";

const PREFETCH = 5;
const STREAM_STARTED = "stream.started";
const STREAM_ENDED = "stream.ended";
const STREAM_UPDATED = "stream.updated";

interface StreamStartedData {
  streamId: string;
  communityId: string;
  creatorId: string;
  title?: string;
  sourceType?: string;
  sourceUrl?: string | null;
  hlsUrl?: string | null;
  flvUrl?: string | null;
  dashUrl?: string | null;
  youtubeVideoId?: string | null;
  status?: string;
  livedAt?: number;
  startedAt?: number;
  liveStreamCount?: number;
}

interface StreamEndedData {
  streamId: string;
  communityId: string;
  creatorId: string;
  endedAt: number;
  peakViewers: number;
  liveStreamCount?: number;
  reason?: string;
}

interface StreamUpdatedData {
  streamId: string;
  communityId: string;
  creatorId: string;
  title?: string;
  description?: string;
  thumbnail?: string | null;
  updatedAt?: string;
}

type StreamLiveData = StreamStartedData | StreamEndedData | StreamUpdatedData;

export function buildStreamSocketPayload(
  type: string,
  data: StreamLiveData
): Record<string, unknown> {
  const { communityId, streamId } = data;
  if (type === STREAM_STARTED) {
    const d = data as StreamStartedData;
    const startedAt = d.startedAt ?? d.livedAt ?? Date.now();
    return {
      communityId,
      livestreamId: streamId,
      streamId,
      title: d.title ?? null,
      ...(d.sourceType ? { sourceType: d.sourceType } : {}),
      sourceUrl: d.sourceUrl ?? null,
      hlsUrl: d.hlsUrl ?? null,
      flvUrl: d.flvUrl ?? null,
      dashUrl: d.dashUrl ?? null,
      youtubeVideoId: d.youtubeVideoId ?? null,
      status: d.status ?? "LIVE",
      livedAt: startedAt,
      startedAt,
      hasActiveLivestream: true,
      liveStreamCount: d.liveStreamCount ?? 1,
    };
  }
  if (type === STREAM_ENDED) {
    const d = data as StreamEndedData;
    return {
      communityId,
      streamId,
      liveStreamCount: d.liveStreamCount ?? 0,
      ...(d.reason ? { reason: d.reason } : {}),
    };
  }
  return { communityId, streamId };
}

export async function startStreamLiveConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  // Assert the shared topic exchange (idempotent — already exists from stream-service).
  await channel.assertExchange(EXCHANGE, "topic", { durable: true });

  // Dead-letter topology so poison messages don't block the queue.
  await channel.assertExchange(DLX, "direct", { durable: true });
  await channel.assertQueue(DLQ, { durable: true });
  await channel.bindQueue(DLQ, DLX, DLQ_ROUTING_KEY);

  await channel.assertQueue(QUEUE, {
    durable: true,
    deadLetterExchange: DLX,
    deadLetterRoutingKey: DLQ_ROUTING_KEY,
  });

  // Bind livestream status/metadata routing keys to the same queue.
  await channel.bindQueue(QUEUE, EXCHANGE, STREAM_STARTED);
  await channel.bindQueue(QUEUE, EXCHANGE, STREAM_ENDED);
  await channel.bindQueue(QUEUE, EXCHANGE, STREAM_UPDATED);

  await channel.prefetch(PREFETCH);

  logger.info(
    `[stream-live-consumer] Listening on queue=${QUEUE} prefetch=${PREFETCH} — ready to fan out stream live status to community members`
  );

  channel.consume(QUEUE, async (message) => {
    if (!message) return;

    let parsed: { type: string; data: StreamLiveData };
    try {
      parsed = JSON.parse(message.content.toString()) as typeof parsed;
    } catch (error) {
      logger.error("[stream-live-consumer] Discarding malformed message body");
      logger.error(error);
      channel.nack(message, false, false);
      return;
    }

    try {
      const { type, data } = parsed;

      logger.info(
        `🔴 [STREAM:CONSUMER] RabbitMQ message received type=${type} streamId=${(data as StreamStartedData).streamId} communityId=${(data as StreamStartedData).communityId}`
      );

      if (
        type !== STREAM_STARTED &&
        type !== STREAM_ENDED &&
        type !== STREAM_UPDATED
      ) {
        logger.info(
          `🔴 [STREAM:CONSUMER] ⏭ ignoring unrelated event type=${type}`
        );
        channel.ack(message);
        return;
      }

      const { communityId } = data;
      const isStarted = type === STREAM_STARTED;
      const isEnded = type === STREAM_ENDED;
      const socketEvent = isStarted
        ? "community:stream:started"
        : isEnded
          ? "community:stream:ended"
          : "community:stream:updated";

      // The host does not need a banner for their own stream, and a member who
      // muted this community's streams must not get the "went live" one either
      // — the sibling push consumer (stream-lifecycle.consumer) already filters
      // on exactly this and these two paths were disagreeing.
      //
      // ENDED / UPDATED are deliberately NOT mute-filtered: they clear or
      // correct live state that a muted member can still be holding from the
      // community list REST payload, and suppressing them strands a stale badge.
      const [activeIds, mutedIds] = await Promise.all([
        communityRepository.findActiveMemberIds(communityId),
        isStarted
          ? communityRepository.findStreamMutedMemberIds(communityId)
          : Promise.resolve<string[]>([]),
      ]);
      const muted = new Set(mutedIds);
      const memberIds = activeIds.filter(
        (id) => id !== data.creatorId && !muted.has(id)
      );

      logger.info(
        `🔴 [STREAM:CONSUMER] ${String(memberIds.length)}/${String(activeIds.length)} active members eligible in community=${communityId} (host + ${String(muted.size)} stream-muted excluded) — fanning out ${socketEvent}`
      );

      if (memberIds.length === 0) {
        logger.warn(
          `🔴 [STREAM:CONSUMER] ⚠ no active members found for community=${communityId} — nothing to fan out`
        );
        channel.ack(message);
        return;
      }

      // Fan out to every active member's personal channel. Each publish is
      // independently guarded — a single user channel failure must not abort
      // the rest of the fan-out.
      const socketPayload = buildStreamSocketPayload(type, data);

      await Promise.allSettled(
        memberIds.map((memberId) =>
          publishChatUserEvent(
            redis,
            memberId,
            socketEvent,
            socketPayload
          ).catch((err: unknown) => {
            logger.warn(
              `🔴 [STREAM:CONSUMER] ❌ ${socketEvent} fan-out FAILED user=${memberId} community=${communityId}: ${String(err)}`
            );
          })
        )
      );

      logger.info(
        `🔴 [STREAM:CONSUMER] ✅ ${socketEvent} fanned out to ${String(memberIds.length)} members of community=${communityId} via user:* channels`
      );

      channel.ack(message);
    } catch (error) {
      logger.error(
        "[stream-live-consumer] Failed to process stream live event"
      );
      logger.error(error);
      channel.nack(message, false, false);
    }
  });
}
