import * as amqp from "amqplib";
import { logger } from "@aimess/logger";

import { env } from "../config/env.js";

/**
 * Thin, lazy RabbitMQ publisher for livestream lifecycle events. No-ops when
 * `RABBITMQ_URL` is unconfigured so the service runs standalone in dev. Mirrors
 * the chat-service `publish-*` style: one shared channel, best-effort, never
 * throws into the caller (a failed publish must not fail go-live / end-stream).
 *
 * Topic exchange `aimess.events`; messages published persistent so durable
 * consumers can survive a broker restart. Routing keys: `stream.started`,
 * `stream.ended`.
 */
const EXCHANGE = "aimess.events";

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(url: string): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(url);
      connection.on("close", () => {
        channelPromise = null;
      });
      connection.on("error", (err: Error) => {
        logger.error("stream events publisher connection error", err);
        channelPromise = null;
      });
      const channel = await connection.createChannel();
      await channel.assertExchange(EXCHANGE, "topic", { durable: true });
      return channel;
    })();
  }
  return channelPromise;
}

/**
 * Fire-and-forget publish of a stream lifecycle event to `aimess.events`.
 * No-ops when RabbitMQ is not configured; logs (never throws) on failure.
 */
export function publishStreamEvent(
  routingKey: string,
  payload: Record<string, unknown>
): void {
  const url = env.RABBITMQ_URL;
  if (!url) return; // RabbitMQ not configured — skip.
  void (async () => {
    try {
      const channel = await getChannel(url);
      const body = JSON.stringify({ type: routingKey, data: payload });
      channel.publish(EXCHANGE, routingKey, Buffer.from(body), {
        persistent: true,
      });
      logger.info(
        `[LIVE-SIDEBAR:STREAM] RabbitMQ published routingKey=${routingKey} streamId=${String(payload.streamId ?? "")} communityId=${String(payload.communityId ?? "")} creatorId=${String(payload.creatorId ?? "")}`
      );
    } catch (error) {
      channelPromise = null;
      logger.warn(
        `Failed to publish stream event ${routingKey}: ${String(error)}`
      );
    }
  })();
}
