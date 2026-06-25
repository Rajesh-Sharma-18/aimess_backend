import { logger } from "@aimess/logger";
import amqp from "amqplib";

import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";

const EXCHANGE = "aimess.events";
const QUEUE_NAME = "backoffice.stream.lifecycle.queue";
const DLX_NAME = "backoffice.stream.lifecycle.dlx";
const DLQ_ROUTING_KEY = "backoffice.stream.lifecycle.dead";
const BINDING_KEY = "stream.*";

type StreamCreatedPayload = {
  streamId: string;
  communityId: string;
  creatorId: string;
  title: string;
  description: string;
  thumbnail: string | null;
  sourceType: string;
  status: string;
  hlsUrl: string | null;
  flvUrl: string | null;
  createdAt: string;
};

type StreamUpdatedPayload = {
  streamId: string;
  communityId: string;
  creatorId: string;
  title: string;
  description: string;
  thumbnail: string | null;
  updatedAt: string;
};

type StreamStartedPayload = {
  streamId: string;
  communityId: string;
  creatorId: string;
  livedAt: number;
};

type StreamEndedPayload = {
  streamId: string;
  communityId: string;
  creatorId: string;
  endedAt: number;
  peakViewers: number;
};

export async function handleStreamLifecycleEvent(
  routingKey: string,
  data: Record<string, unknown>
): Promise<void> {
  if (routingKey === "stream.created") {
    const d = data as StreamCreatedPayload;
    if (!d.streamId || !d.communityId || !d.creatorId || !d.title) {
      throw new Error("Malformed stream.created payload");
    }
    // Best-effort: enrich community name + creator username from existing read-models.
    const [community, user] = await Promise.all([
      prisma.communityIndex.findUnique({ where: { id: d.communityId } }),
      prisma.userIndex.findUnique({ where: { userId: d.creatorId } }),
    ]);
    await prisma.livestreamIndex.upsert({
      where: { streamId: d.streamId },
      create: {
        streamId: d.streamId,
        communityId: d.communityId,
        communityName: community?.name ?? "",
        creatorId: d.creatorId,
        creatorUsername: user?.username ?? "",
        title: d.title,
        description: d.description ?? "",
        thumbnailUrl: d.thumbnail ?? null,
        sourceType: d.sourceType ?? "",
        status: d.status ?? "PENDING",
        hlsUrl: d.hlsUrl ?? null,
        flvUrl: d.flvUrl ?? null,
        createdAt: new Date(d.createdAt),
      },
      update: {
        title: d.title,
        description: d.description ?? "",
        thumbnailUrl: d.thumbnail ?? null,
        status: d.status ?? "PENDING",
        hlsUrl: d.hlsUrl ?? null,
        flvUrl: d.flvUrl ?? null,
      },
    });
    logger.info(`stream.created ingested: ${d.streamId}`);
    return;
  }

  if (routingKey === "stream.updated") {
    const d = data as StreamUpdatedPayload;
    if (!d.streamId) throw new Error("Malformed stream.updated payload");
    await prisma.livestreamIndex.upsert({
      where: { streamId: d.streamId },
      create: {
        streamId: d.streamId,
        communityId: d.communityId ?? "",
        creatorId: d.creatorId ?? "",
        title: d.title ?? "",
        description: d.description ?? "",
        thumbnailUrl: d.thumbnail ?? null,
        createdAt: new Date(),
      },
      update: {
        title: d.title,
        description: d.description ?? "",
        thumbnailUrl: d.thumbnail ?? null,
      },
    });
    logger.info(`stream.updated ingested: ${d.streamId}`);
    return;
  }

  if (routingKey === "stream.started") {
    const d = data as StreamStartedPayload;
    if (!d.streamId) throw new Error("Malformed stream.started payload");
    await prisma.livestreamIndex.upsert({
      where: { streamId: d.streamId },
      create: {
        streamId: d.streamId,
        communityId: d.communityId ?? "",
        creatorId: d.creatorId ?? "",
        title: "",
        status: "LIVE",
        livedAt: new Date(d.livedAt),
        createdAt: new Date(d.livedAt),
      },
      update: {
        status: "LIVE",
        livedAt: new Date(d.livedAt),
      },
    });
    logger.info(`stream.started ingested: ${d.streamId}`);
    return;
  }

  if (routingKey === "stream.ended") {
    const d = data as StreamEndedPayload;
    if (!d.streamId) throw new Error("Malformed stream.ended payload");
    const endedAt = new Date(d.endedAt);
    await prisma.livestreamIndex.upsert({
      where: { streamId: d.streamId },
      create: {
        streamId: d.streamId,
        communityId: d.communityId ?? "",
        creatorId: d.creatorId ?? "",
        title: "",
        status: "ENDED",
        endedAt,
        peakViewers: d.peakViewers ?? 0,
        createdAt: endedAt,
      },
      update: {
        status: "ENDED",
        endedAt,
        peakViewers: d.peakViewers ?? 0,
      },
    });
    logger.info(`stream.ended ingested: ${d.streamId}`);
    return;
  }

  // Unknown routing key (e.g. future stream.paused) — ack and discard so it
  // doesn't accumulate in the DLQ every time a new event type is introduced.
  logger.warn(
    `stream lifecycle consumer: unknown routing key "${routingKey}" — acking and discarding`
  );
}

export async function startStreamLifecycleConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertExchange(DLX_NAME, "direct", { durable: true });
  await channel.assertQueue(QUEUE_NAME, {
    durable: true,
    deadLetterExchange: DLX_NAME,
    deadLetterRoutingKey: DLQ_ROUTING_KEY,
  });
  await channel.assertExchange(EXCHANGE, "topic", { durable: true });
  await channel.bindQueue(QUEUE_NAME, EXCHANGE, BINDING_KEY);
  await channel.prefetch(10);

  logger.info("Stream lifecycle consumer started");

  void channel.consume(QUEUE_NAME, (message) => {
    if (!message) return;

    void (async () => {
      try {
        const parsed = JSON.parse(message.content.toString()) as {
          type: string;
          data: Record<string, unknown>;
        };
        await handleStreamLifecycleEvent(parsed.type, parsed.data);
        channel.ack(message);
      } catch (error) {
        logger.error(
          "Stream lifecycle consumer failed to process message",
          error
        );
        channel.nack(message, false, false);
      }
    })();
  });
}
