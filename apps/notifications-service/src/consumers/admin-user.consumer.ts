import { logger } from "@aimess/logger";
import {
  type AdminUserNotifyPayload,
  type NotificationNavigation,
} from "@aimess/shared-types";
import amqp from "amqplib";

import { env } from "../config/env.js";
import { pushToUser } from "../services/push.service.js";

/**
 * auth-service re-publishes admin ban/suspend/unban actions (after force-logout)
 * to this plain durable queue as notify-ready messages. We deliver each to the
 * affected user via pushToUser (settings/quiet-hours gate → inbox row → realtime
 * bridge → FCM-if-offline). Account-state notifications gate on the system
 * category. Envelope: JSON.stringify({ type, data }) where data is the
 * notify-ready payload published by auth-service publish-admin-user-notify.ts.
 */
const ADMIN_USER_NOTIFY_QUEUE = "admin.user.notify.queue";

async function handleAdminUserNotify(
  type: string,
  data: unknown
): Promise<void> {
  const p = data as AdminUserNotifyPayload;
  if (!p?.userId || !p.title || !p.body) {
    logger.warn(`admin.user.notify message missing required fields: ${type}`);
    return;
  }

  const actorId =
    typeof p.data?.actorId === "string" ? p.data.actorId : undefined;

  await pushToUser({
    userId: p.userId,
    category: "systemEnabled",
    type,
    actorId,
    title: p.title,
    body: p.body,
    data: {
      ...p.data,
      navigation: JSON.stringify({
        screen: "ACCOUNT_STATUS",
      } satisfies NotificationNavigation),
    },
  });
}

export async function startAdminUserConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertQueue(ADMIN_USER_NOTIFY_QUEUE, { durable: true });
  await channel.prefetch(10);

  logger.info("Admin-user notification consumer started");

  void channel.consume(ADMIN_USER_NOTIFY_QUEUE, (message) => {
    if (!message) return;

    void (async () => {
      try {
        const parsed = JSON.parse(message.content.toString()) as {
          type: string;
          data: unknown;
        };
        await handleAdminUserNotify(parsed.type, parsed.data);
        channel.ack(message);
      } catch (error) {
        logger.error("Admin-user consumer failed to process message", error);
        channel.nack(message, false, false);
      }
    })();
  });
}
