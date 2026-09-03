import { logger } from "@aimess/logger";
import amqp from "amqplib";

import { UserEvents, type UserPurgedPayload } from "@aimess/shared-types";

import { env } from "../config/env.js";

/**
 * `user.purged` — the account's personal data has been erased for good.
 *
 * Published by the purge sweeper once the 30-day grace period has elapsed and
 * auth-service has anonymised its own row. Every service holding a copy of that
 * user's identifying data erases its own on receipt.
 *
 * A fanout exchange, unlike the single queue `user.deleted` uses: deletion had
 * exactly one consumer, whereas the personal data of one user is copied into
 * several services (profile, denormalised chat and community snapshots, device
 * tokens). Each binds its own durable queue, so a service that is down when the
 * event fires still purges when it comes back — which for an erasure obligation
 * is the difference between late and never.
 */
const USER_PURGED_EXCHANGE = "user.purged";
const USER_PURGED_DLX = "user.purged.dlx";

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(): Promise<amqp.Channel> {
  channelPromise ??= (async () => {
    const connection = await amqp.connect(env.RABBITMQ_URL);
    const channel = await connection.createChannel();
    await channel.assertExchange(USER_PURGED_EXCHANGE, "fanout", {
      durable: true,
    });
    await channel.assertExchange(USER_PURGED_DLX, "fanout", { durable: true });
    // A dropped connection must not leave a permanently dead cached channel —
    // the next publish reconnects instead of failing forever.
    connection.on("close", () => {
      channelPromise = null;
    });
    connection.on("error", () => {
      channelPromise = null;
    });
    return channel;
  })();
  return channelPromise;
}

export async function publishUserPurged(
  data: UserPurgedPayload
): Promise<void> {
  const channel = await getChannel();
  const payload = JSON.stringify({ type: UserEvents.USER_PURGED, data });
  channel.publish(USER_PURGED_EXCHANGE, "", Buffer.from(payload), {
    persistent: true,
  });
}

/**
 * Publish, reporting whether it worked.
 *
 * NOT fire-and-forget, unlike the other publishers here. If this event is lost,
 * every other service keeps that user's personal data indefinitely and nothing
 * ever retries — so the sweeper needs to know, and leaves the account for the
 * next tick rather than marking the erasure complete.
 */
export async function tryPublishUserPurged(
  data: UserPurgedPayload
): Promise<boolean> {
  try {
    await publishUserPurged(data);
    return true;
  } catch (error) {
    logger.error("Failed to publish user.purged event");
    logger.error(error);
    return false;
  }
}

export { USER_PURGED_EXCHANGE, USER_PURGED_DLX };
