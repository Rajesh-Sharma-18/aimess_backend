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

interface StreamStartedData {
  streamId: string;
  communityId: string;
  creatorId: string;
  title?: string;
  livedAt: number;
}

interface StreamEndedData {
  streamId: string;
  communityId: string;
  creatorId: string;
  endedAt: number;
  peakViewers: number;
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

  // Bind both routing keys to the same queue.
  await channel.bindQueue(QUEUE, EXCHANGE, "stream.started");
  await channel.bindQueue(QUEUE, EXCHANGE, "stream.ended");

  await channel.prefetch(PREFETCH);

  logger.info(
    `[stream-live-consumer] Listening on queue=${QUEUE} prefetch=${PREFETCH} — ready to fan out stream live status to community members`
  );

  channel.consume(QUEUE, async (message) => {
    if (!message) return;

    let parsed: { type: string; data: StreamStartedData | StreamEndedData };
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

      if (type !== "stream.started" && type !== "stream.ended") {
        logger.info(
          `🔴 [STREAM:CONSUMER] ⏭ ignoring unrelated event type=${type}`
        );
        channel.ack(message);
        return;
      }

      const { communityId, streamId } = data;
      const isStarted = type === "stream.started";
      const socketEvent = isStarted
        ? "community:stream:started"
        : "community:stream:ended";

      const memberIds =
        await communityRepository.findActiveMemberIds(communityId);

      logger.info(
        `🔴 [STREAM:CONSUMER] found ${String(memberIds.length)} active members in community=${communityId} — fanning out ${socketEvent}`
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
      const socketPayload = isStarted
        ? {
            communityId,
            streamId,
            ...((data as StreamStartedData).title
              ? { title: (data as StreamStartedData).title }
              : {}),
            livedAt: (data as StreamStartedData).livedAt,
          }
        : { communityId, streamId };

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
