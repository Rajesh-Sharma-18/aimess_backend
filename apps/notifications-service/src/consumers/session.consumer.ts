import { logger } from "@aimess/logger";
import amqp from "amqplib";

import { env } from "../config/env.js";
import { deviceTokenRepository } from "../repositories/device-token.repository.js";

// Mirrors auth-service publish-session-revoked.ts (durable queue + DLX). The
// DLX args MUST match the publisher or RabbitMQ throws PRECONDITION_FAILED.
const SESSION_QUEUE = "session.queue";
const SESSION_DLX = "session.queue.dlx";
const SESSION_DLQ_ROUTING_KEY = "session.queue.dead";

export async function handleSessionEvent(
  type: string,
  data: unknown
): Promise<void> {
  switch (type) {
    case "session.device_revoked": {
      const { userId, deviceId, sessionId } = data as {
        userId: string;
        deviceId?: string | null;
        sessionId?: string | null;
      };
      // sessionId is the accurate match — it is stamped on the row at
      // registration time from the same JWT. deviceId is only a fallback for
      // rows registered before sessionId existed; auth-service's Session
      // .deviceId is a sha256(userAgent|ip) fingerprint that will not match a
      // client-generated deviceId, so on its own it silently deletes nothing.
      if (sessionId) {
        await deviceTokenRepository.deleteByUserIdAndSessionId(
          userId,
          sessionId
        );
      }
      if (deviceId) {
        await deviceTokenRepository.deleteByUserIdAndDeviceId(userId, deviceId);
      }
      logger.info("Device token cleared on logout");
      break;
    }

    case "session.all_revoked": {
      // exceptSessionId is set by "sign out from all OTHER devices": that
      // session is still signed in and must keep receiving push.
      const { userId, exceptSessionId } = data as {
        userId: string;
        exceptSessionId?: string | null;
      };
      await deviceTokenRepository.deleteAllByUserId(userId, exceptSessionId);
      logger.info("Device token cleared on logout");
      break;
    }

    default:
      logger.warn(`Unknown session event type: ${type}`);
  }
}

export async function startSessionConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertExchange(SESSION_DLX, "direct", { durable: true });
  await channel.assertQueue(SESSION_QUEUE, {
    durable: true,
    deadLetterExchange: SESSION_DLX,
    deadLetterRoutingKey: SESSION_DLQ_ROUTING_KEY,
  });
  await channel.prefetch(10);

  logger.info("Session consumer started");

  void channel.consume(SESSION_QUEUE, (message) => {
    if (!message) return;

    void (async () => {
      try {
        const parsed = JSON.parse(message.content.toString()) as {
          type: string;
          data: unknown;
        };
        await handleSessionEvent(parsed.type, parsed.data);
        channel.ack(message);
      } catch (error) {
        logger.error("Session consumer failed to process message", error);
        channel.nack(message, false, false);
      }
    })();
  });
}
