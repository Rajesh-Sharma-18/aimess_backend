import { logger } from "@aimess/logger";
import amqp from "amqplib";

import { env } from "../config/env.js";

const SESSION_QUEUE = "session.queue";

/**
 * Dead-letter topology for session.queue. Must stay in sync with the
 * notifications-service consumer; queue arguments are immutable once declared
 * so both sides MUST assert identical deadLetter* args or RabbitMQ throws
 * PRECONDITION_FAILED.
 */
const SESSION_DLX = "session.queue.dlx";
const SESSION_DLQ_ROUTING_KEY = "session.queue.dead";

export interface SessionRevokedPayload {
  userId: string;
  /**
   * The revoked session. This is what notifications-service matches on: it
   * stamps the registering JWT's sessionId onto every device-token row.
   */
  sessionId: string;
  /**
   * Session.deviceId — a sha256(userAgent|ip) fingerprint. Kept only so rows
   * registered before device tokens carried a sessionId can still be matched;
   * it does NOT equal the client-generated deviceId sent at registration.
   */
  deviceId?: string | null;
}

export interface AllSessionsRevokedPayload {
  userId: string; // clear ALL tokens for this user
  /** Session to spare — set by "sign out from all OTHER devices". */
  exceptSessionId?: string;
}

let channelPromise: Promise<amqp.Channel> | null = null;

/**
 * Drop the memoized channel so the next publish dials a fresh connection.
 *
 * Without this the cached promise keeps resolving to a channel whose socket is
 * already dead, so ONE broker blip silently breaks every subsequent
 * device-token cleanup for the lifetime of the process — every logout from
 * then on leaves its push token registered.
 */
function resetChannel(current: Promise<amqp.Channel>): void {
  if (channelPromise === current) channelPromise = null;
}

async function getChannel(): Promise<amqp.Channel> {
  if (!channelPromise) {
    const pending = (async () => {
      const connection = await amqp.connect(env.RABBITMQ_URL);
      const channel = await connection.createChannel();
      await channel.assertExchange(SESSION_DLX, "direct", { durable: true });
      await channel.assertQueue(SESSION_QUEUE, {
        durable: true,
        deadLetterExchange: SESSION_DLX,
        deadLetterRoutingKey: SESSION_DLQ_ROUTING_KEY,
      });
      channel.on("close", () => resetChannel(pending));
      channel.on("error", () => resetChannel(pending));
      connection.on("close", () => resetChannel(pending));
      connection.on("error", () => resetChannel(pending));
      return channel;
    })();
    // A failed dial must not be cached either.
    pending.catch(() => resetChannel(pending));
    channelPromise = pending;
  }
  return channelPromise;
}

async function publish(type: string, data: unknown): Promise<void> {
  const message = Buffer.from(JSON.stringify({ type, data }));

  // One retry on a fresh channel: the first send after an idle broker restart
  // fails on the stale socket, and losing it means the device keeps its push
  // token forever. The queue is durable, so a message that lands is never lost.
  for (let attempt = 0; attempt < 2; attempt++) {
    const pending = channelPromise;
    try {
      const channel = await getChannel();
      channel.sendToQueue(SESSION_QUEUE, message, { persistent: true });
      return;
    } catch (error) {
      if (pending) resetChannel(pending);
      channelPromise = null;
      if (attempt === 1) throw error;
    }
  }
}

/** Fire-and-forget; logout must not fail if the broker is down. */
export function publishSessionDeviceRevokedSafe(
  payload: SessionRevokedPayload
): void {
  void publish("session.device_revoked", payload).catch((error) => {
    logger.error("Failed to publish session.device_revoked event");
    logger.error(error);
  });
}

/** Fire-and-forget; logout must not fail if the broker is down. */
export function publishAllSessionsRevokedSafe(
  payload: AllSessionsRevokedPayload
): void {
  void publish("session.all_revoked", payload).catch((error) => {
    logger.error("Failed to publish session.all_revoked event");
    logger.error(error);
  });
}
