import { logger } from "@aimess/logger";
import * as amqp from "amqplib";

import { env } from "../config/env.js";

/**
 * Durable queue carrying community chat activity to community-service, which
 * denormalizes it into `Community.lastActivityAt` for inbox-style ordering of
 * `GET /communities/mine`. Publisher (here) and consumer (community-service)
 * MUST assert identical queue args — RabbitMQ queue args are immutable.
 */
const COMMUNITY_ACTIVITY_QUEUE = "community.activity.queue";

export const COMMUNITY_ACTIVITY_EVENT = "community.activity";

export interface CommunityActivityPayload {
  communityId: string;
  /** ISO-8601 timestamp of the latest community message. */
  lastMessageAt: string;
  lastMessageId: string;
  senderUserId?: string;
  senderUsername: string;
  messagePreview: string;
  /** Activity type stored in community-service (e.g. "message", "reaction", "edited"). Defaults to "message". */
  type?: string;
}

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(url: string): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(url);
      connection.on("close", () => {
        channelPromise = null;
      });
      connection.on("error", (err: Error) => {
        logger.error("community.activity publisher connection error", err);
      });
      const channel = await connection.createChannel();
      await channel.assertQueue(COMMUNITY_ACTIVITY_QUEUE, { durable: true });
      return channel;
    })();
  }
  return channelPromise;
}

/**
 * Fire-and-forget publish of a community-activity bump. Best-effort: a failure
 * is logged, never thrown, so a message send never fails on its activity event.
 */
export function publishCommunityActivitySafe(
  data: CommunityActivityPayload
): void {
  const url = env.RABBITMQ_URL;
  if (!url) return; // RabbitMQ not configured — skip (matches event consumer guard)
  void (async () => {
    try {
      const channel = await getChannel(url);
      const payload = JSON.stringify({
        type: COMMUNITY_ACTIVITY_EVENT,
        data,
      });
      channel.sendToQueue(COMMUNITY_ACTIVITY_QUEUE, Buffer.from(payload), {
        persistent: true,
      });
    } catch (error) {
      channelPromise = null;
      logger.warn(
        `Failed to publish community.activity for ${data.communityId}: ${String(error)}`
      );
    }
  })();
}
