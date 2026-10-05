import { logger } from "@aimess/logger";
import amqp from "amqplib";

import {
  UserEvents,
  type UserProfileUpdatedPayload,
} from "@aimess/shared-types";

import { env } from "../config/env.js";

const EXCHANGE = "user.profile_updated";

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(env.RABBITMQ_URL);
      const channel = await connection.createChannel();
      await channel.assertExchange(EXCHANGE, "fanout", { durable: true });
      return channel;
    })();
  }
  return channelPromise;
}

async function publish(data: UserProfileUpdatedPayload): Promise<void> {
  const channel = await getChannel();
  const payload = JSON.stringify({
    type: UserEvents.USER_PROFILE_UPDATED,
    data,
  });
  channel.publish(EXCHANGE, "", Buffer.from(payload), { persistent: true });
}

function publishSafe(data: UserProfileUpdatedPayload): void {
  void publish(data).catch((error) => {
    logger.error("Failed to publish user.profile_updated");
    logger.error(error);
  });
}

export function publishProfileUpdatedSafe(
  data: UserProfileUpdatedPayload
): void {
  // Consumers write `username` into member snapshots other people read. Until
  // the profile is complete it is only the registration-reserved handle, not
  // one the user allocated — same rule as `allocatedUsername`.
  publishSafe({ ...data, username: data.isProfileCompleted ? data.username : "" });
}
