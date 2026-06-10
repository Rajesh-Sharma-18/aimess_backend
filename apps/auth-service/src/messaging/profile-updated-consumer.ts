import { logger } from "@aimess/logger";
import amqp from "amqplib";

import {
  UserEvents,
  type UserProfileUpdatedPayload,
} from "@aimess/shared-types";

import { env } from "../config/env.js";
import { authRepository } from "../repositories/auth.repository.js";

const EXCHANGE = "user.profile_updated";
const QUEUE = "user.profile_updated.auth.queue";
const DLX = "user.profile_updated.auth.queue.dlx";
const DLQ = "user.profile_updated.auth.queue.dlq";
const DLQ_ROUTING_KEY = "user.profile_updated.auth.queue.dead";

const PREFETCH = 10;

/**
 * Retry amqp.connect with exponential backoff (2s → 4s → … → 30s cap) to cover
 * the Docker/pnpm-dev startup race where RabbitMQ is still initialising.
 */
async function connectWithRetry(
  url: string,
  retries = 8
): Promise<amqp.ChannelModel> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await amqp.connect(url);
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = Math.min(2000 * attempt, 30_000);
      logger.warn(
        `RabbitMQ connection attempt ${String(attempt)}/${String(retries)} failed — retrying in ${String(delay / 1000)}s`
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  /* istanbul ignore next */
  throw new Error("connectWithRetry: unreachable");
}

/**
 * Consumes user.profile_updated events from user-service and mirrors the
 * profile-completion flag onto AuthUser, so the login response can tell the
 * client whether to route the user to the edit-profile screen.
 */
export async function startProfileUpdatedConsumer(): Promise<void> {
  const connection = await connectWithRetry(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertExchange(EXCHANGE, "fanout", { durable: true });

  await channel.assertExchange(DLX, "direct", { durable: true });
  await channel.assertQueue(DLQ, { durable: true });
  await channel.bindQueue(DLQ, DLX, DLQ_ROUTING_KEY);

  await channel.assertQueue(QUEUE, {
    durable: true,
    deadLetterExchange: DLX,
    deadLetterRoutingKey: DLQ_ROUTING_KEY,
  });
  await channel.bindQueue(QUEUE, EXCHANGE, "");

  await channel.prefetch(PREFETCH);

  logger.info(`Auth-service consumer listening on ${QUEUE}`);

  void channel.consume(QUEUE, (message) => {
    if (!message) return;

    void (async () => {
      try {
        const parsed = JSON.parse(message.content.toString()) as {
          type: string;
          data: UserProfileUpdatedPayload;
        };

        if (parsed.type !== UserEvents.USER_PROFILE_UPDATED) {
          logger.warn(`Unknown event type: ${parsed.type}`);
          channel.ack(message);
          return;
        }

        if (typeof parsed.data?.isProfileCompleted !== "boolean") {
          // Pre-deploy event without the field can never succeed on retry.
          logger.error(
            "Discarding user.profile_updated message without isProfileCompleted"
          );
          channel.nack(message, false, false);
          return;
        }

        await authRepository.markProfileCompletion(
          parsed.data.userId,
          parsed.data.isProfileCompleted
        );
        channel.ack(message);
      } catch (error) {
        if (error instanceof SyntaxError) {
          // Malformed body — dead-letter so the consumer is not wedged.
          logger.error(
            "Discarding malformed user.profile_updated message body"
          );
          logger.error(error);
          channel.nack(message, false, false);
          return;
        }

        // Transient failure (DB down) — dead-letter for later replay.
        logger.error("Failed to process user.profile_updated event");
        logger.error(error);
        channel.nack(message, false, false);
      }
    })();
  });
}
