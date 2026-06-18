import { logger } from "@aimess/logger";
import * as amqp from "amqplib";

import {
  ChatEvents,
  type ChatGroupMemberAddedPayload,
} from "@aimess/shared-types";

import { env } from "../config/env.js";

/**
 * Durable queue carrying "a member was added to a group" to notifications-service,
 * which pushes/inboxes the added user who is not in the room socket (mirrors the
 * community MEMBER_ADDED fan-out). Best-effort: the in-room SYSTEM message is the
 * primary signal, so a publish failure is logged, never thrown — adding a member
 * must not fail on its notification event. Publisher (here) and consumer
 * (notifications-service) MUST assert identical queue args; queue args are
 * immutable once declared.
 */
const CHAT_GROUP_QUEUE = "chat.group.queue";

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(url: string): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(url);
      connection.on("close", () => {
        channelPromise = null;
      });
      connection.on("error", (err: Error) => {
        logger.error("chat.group publisher connection error", err);
      });
      const channel = await connection.createChannel();
      await channel.assertQueue(CHAT_GROUP_QUEUE, { durable: true });
      return channel;
    })();
  }
  return channelPromise;
}

/**
 * Fire-and-forget group member-added trigger. Best-effort: a failure is logged,
 * never thrown, so adding a member never fails on its notification event.
 */
export function publishGroupMemberAddedSafe(
  data: ChatGroupMemberAddedPayload
): void {
  const url = env.RABBITMQ_URL;
  if (!url) return; // RabbitMQ not configured — skip (push is a fallback channel)
  void (async () => {
    try {
      const channel = await getChannel(url);
      const payload = JSON.stringify({
        type: ChatEvents.GROUP_MEMBER_ADDED,
        data,
      });
      channel.sendToQueue(CHAT_GROUP_QUEUE, Buffer.from(payload), {
        persistent: true,
      });
    } catch (error) {
      channelPromise = null;
      logger.warn(
        `Failed to publish chat.group_member_added for ${data.roomId}: ${String(error)}`
      );
    }
  })();
}
