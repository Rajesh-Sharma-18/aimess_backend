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

async function getChannel(): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(env.RABBITMQ_URL);
      const channel = await connection.createChannel();
      await channel.assertExchange(SESSION_DLX, "direct", { durable: true });
      await channel.assertQueue(SESSION_QUEUE, {
        durable: true,
        deadLetterExchange: SESSION_DLX,
        deadLetterRoutingKey: SESSION_DLQ_ROUTING_KEY,
      });
      return channel;
    })();
  }
  return channelPromise;
}

async function publishSessionDeviceRevoked(
  payload: SessionRevokedPayload
): Promise<void> {
  const channel = await getChannel();
  const message = JSON.stringify({
    type: "session.device_revoked",
    data: payload,
  });
  channel.sendToQueue(SESSION_QUEUE, Buffer.from(message), {
    persistent: true,
  });
}

async function publishAllSessionsRevoked(
  payload: AllSessionsRevokedPayload
): Promise<void> {
  const channel = await getChannel();
  const message = JSON.stringify({
    type: "session.all_revoked",
    data: payload,
  });
  channel.sendToQueue(SESSION_QUEUE, Buffer.from(message), {
    persistent: true,
  });
}

/** Fire-and-forget; logout must not fail if the broker is down. */
export function publishSessionDeviceRevokedSafe(
  payload: SessionRevokedPayload
): void {
  void publishSessionDeviceRevoked(payload).catch((error) => {
    logger.error("Failed to publish session.device_revoked event");
    logger.error(error);
  });
}

/** Fire-and-forget; logout must not fail if the broker is down. */
export function publishAllSessionsRevokedSafe(
  payload: AllSessionsRevokedPayload
): void {
  void publishAllSessionsRevoked(payload).catch((error) => {
    logger.error("Failed to publish session.all_revoked event");
    logger.error(error);
  });
}
