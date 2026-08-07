import { logger } from "@aimess/logger";
import * as amqp from "amqplib";

import { env } from "../config/env.js";

/**
 * Durable queue carrying "this user read this conversation" to notifications-service, which
 * sends a silent dismiss push to the reader's OTHER devices so a tray notification for an
 * already-read conversation does not linger there.
 *
 * The equivalent socket signal (`read_sync`) only reaches devices with a live connection, which
 * is exactly the set that does NOT have a stale notification problem. Publisher and consumer
 * MUST assert identical queue args; RabbitMQ queue args are immutable once declared.
 */
const CHAT_READ_QUEUE = "chat.read.queue";

export const CHAT_CONVERSATION_READ_EVENT = "chat.conversation_read";

export interface ConversationReadPayload {
  readerId: string;
  conversationId: string;
  conversationType: "PRIVATE" | "GROUP" | "COMMUNITY";
  /** epoch ms */
  readAt: number;
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
        logger.error("chat.read publisher connection error", err);
      });
      const channel = await connection.createChannel();
      await channel.assertQueue(CHAT_READ_QUEUE, { durable: true });
      return channel;
    })();
  }
  return channelPromise;
}

/** Fire-and-forget. A failure is logged, never thrown — a read must never fail on its push event. */
export function publishConversationReadSafe(p: ConversationReadPayload): void {
  const url = env.RABBITMQ_URL;
  if (!url) return;
  void (async () => {
    try {
      const channel = await getChannel(url);
      channel.sendToQueue(
        CHAT_READ_QUEUE,
        Buffer.from(
          JSON.stringify({ type: CHAT_CONVERSATION_READ_EVENT, data: p })
        ),
        { persistent: true }
      );
    } catch (error) {
      logger.warn(
        `publishConversationReadSafe failed room=${p.conversationId}: ${String(error)}`
      );
    }
  })();
}
