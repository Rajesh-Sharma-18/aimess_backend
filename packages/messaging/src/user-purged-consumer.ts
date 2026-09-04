import amqp from "amqplib";

import { UserEvents, type UserPurgedPayload } from "@aimess/shared-types";

/**
 * Bind a service to `user.purged` and erase its copy of that user's data.
 *
 * Shared rather than copied per service because the erasure obligation is the
 * same everywhere and the failure mode is silent: a service that never binds
 * simply keeps the personal data forever, and nothing reports it. One
 * implementation means one place where the topology, the retry policy and the
 * poison-message handling are correct.
 *
 * A fanout exchange with a per-service durable queue. Durable matters more here
 * than for most events: if a service is down when a user is purged, the erasure
 * has to happen when it comes back, not be lost — for a deletion obligation the
 * difference is late versus never.
 */

const USER_PURGED_EXCHANGE = "user.purged";
const USER_PURGED_DLX = "user.purged.dlx";
const PREFETCH = 10;

export type UserPurgedConsumerOptions = {
  rabbitUrl: string;
  /** Names this service's queue, e.g. "user-service". */
  serviceName: string;
  /** Erase this service's copy of the user's personal data. */
  onPurge: (payload: UserPurgedPayload) => Promise<void>;
  logger: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string | unknown) => void;
  };
};

async function connectWithRetry(
  url: string,
  logger: UserPurgedConsumerOptions["logger"],
  retries = 8
): Promise<amqp.ChannelModel> {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await amqp.connect(url);
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = Math.min(2000 * attempt, 30_000);
      logger.warn(
        `user.purged consumer: connection attempt ${String(attempt)}/${String(
          retries
        )} failed — retrying in ${String(delay / 1000)}s`
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("connectWithRetry: unreachable");
}

export async function startUserPurgedConsumer(
  options: UserPurgedConsumerOptions
): Promise<void> {
  const { rabbitUrl, serviceName, onPurge, logger } = options;
  const queue = `user.purged.${serviceName}.queue`;
  const dlq = `${queue}.dlq`;

  const connection = await connectWithRetry(rabbitUrl, logger);
  const channel = await connection.createChannel();

  await channel.assertExchange(USER_PURGED_EXCHANGE, "fanout", {
    durable: true,
  });
  await channel.assertExchange(USER_PURGED_DLX, "fanout", { durable: true });
  await channel.assertQueue(dlq, { durable: true });
  await channel.bindQueue(dlq, USER_PURGED_DLX, "");

  await channel.assertQueue(queue, {
    durable: true,
    deadLetterExchange: USER_PURGED_DLX,
  });
  await channel.bindQueue(queue, USER_PURGED_EXCHANGE, "");
  await channel.prefetch(PREFETCH);

  logger.info(`${serviceName} consumer listening on ${queue}`);

  void channel.consume(queue, (message) => {
    if (!message) return;

    void (async () => {
      try {
        const parsed = JSON.parse(message.content.toString()) as {
          type: string;
          data: UserPurgedPayload;
        };

        if (parsed.type !== UserEvents.USER_PURGED) {
          logger.warn(`Unknown event type on ${queue}: ${parsed.type}`);
          channel.ack(message);
          return;
        }

        await onPurge(parsed.data);
        channel.ack(message);
      } catch (error) {
        if (error instanceof SyntaxError) {
          // A malformed body can never succeed on retry; dead-letter it rather
          // than wedging the queue behind a poison message.
          logger.error(`Discarding malformed ${queue} message body`);
          logger.error(error);
          channel.nack(message, false, false);
          return;
        }

        // Transient failure. Dead-lettered rather than dropped: an unerased
        // account is a standing obligation, so the message has to survive
        // somewhere an operator can replay it.
        logger.error(`Failed to process user.purged in ${serviceName}`);
        logger.error(error);
        channel.nack(message, false, false);
      }
    })();
  });
}
