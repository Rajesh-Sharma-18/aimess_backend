import { logger } from "@aimess/logger";
import amqp from "amqplib";
import { type NotificationNavigation } from "@aimess/shared-types";

import { redis } from "../config/redis.js";
import { env } from "../config/env.js";
import { pushToUsers } from "../services/push.service.js";

/**
 * Queue 2 of the Announcements delivery pipeline. backoffice-service publishes
 * one resolved batch of recipient userIds (≤100) per message; we fan the
 * announcement out via the existing `pushToUsers` helper — identical to how
 * the community consumer fans out to a pre-resolved member roster.
 */
const NOTIFICATION_ANNOUNCEMENT_QUEUE = "notification.announcement.queue";
const BATCH_LOCK_TTL_SECONDS = 3600;

export interface NotificationAnnouncementBatchPayload {
  announcementId: string;
  title: string;
  body: string;
  /** Defaults to "ANNOUNCEMENT" for backward compatibility with older publishers. */
  kind?: "ANNOUNCEMENT" | "MAINTENANCE" | "UPDATE_REQUIRED";
  /**
   * Which device platforms to deliver to. Resolved against the recipient's
   * LIVE device-token rows (one per registered session, deleted on logout /
   * session revoke), so "ANDROID" reaches a user's Android session and leaves
   * their iOS and Web sessions alone. Defaults to "ALL" for older publishers.
   */
  deviceType?: "ALL" | "ANDROID" | "IOS" | "WEB";
  userIds: string[];
  batchId: string;
}

/**
 * Exported separately from the `channel.consume` wiring so tests can call it
 * directly without a real amqp connection.
 */
export async function handleAnnouncementBatch(
  data: NotificationAnnouncementBatchPayload
): Promise<void> {
  const acquired = await redis.set(
    `announce:notify:${data.batchId}`,
    "1",
    "EX",
    BATCH_LOCK_TTL_SECONDS,
    "NX"
  );
  if (!acquired) {
    logger.info(
      `Duplicate announcement notification batch skipped: ${data.batchId}`
    );
    return;
  }

  const kind = data.kind ?? "ANNOUNCEMENT";
  const deviceType = data.deviceType ?? "ALL";

  // `userIds` is already the device-correct audience: backoffice-service
  // resolved it from auth-service's live SESSIONS for this device type, which
  // is what "send to iOS" means. This service does not re-decide who — it only
  // decides which of that person's devices to wake, via `platforms` below.
  await pushToUsers(data.userIds, (userId) => ({
    userId,
    category: "systemEnabled",
    type: kind,
    // The recipient was chosen because they have a live session of this type;
    // this keeps the PUSH on that platform too, so a user signed in on both iOS
    // and web gets an iOS-targeted announcement on the iPhone only.
    platforms: deviceType === "ALL" ? undefined : [deviceType],
    // Clicking the announcement lands on the web app's notifications route —
    // the same destination the native clients reach via `navigation.screen`.
    ...(env.WEB_APP_BASE_URL
      ? { webLink: `${env.WEB_APP_BASE_URL}/notifications` }
      : {}),
    title: data.title,
    body: data.body,
    // Informational, not account-integrity: the System toggle and quiet hours
    // both apply. Security events are exempted by NON_SUPPRESSIBLE_TYPES.
    data: {
      type: kind,
      announcementId: data.announcementId,
      navigation: JSON.stringify({
        screen: "NOTIFICATIONS",
      } satisfies NotificationNavigation),
    },
  }));
}

export async function startAnnouncementConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  // backoffice-service publishes to a plain durable queue (NOT an exchange).
  // Args MUST match the publisher
  // (apps/backoffice-service/src/messaging/publish-notification-announcement-batch.ts).
  await channel.assertQueue(NOTIFICATION_ANNOUNCEMENT_QUEUE, { durable: true });
  await channel.prefetch(20);

  logger.info("Announcement notification consumer started");

  void channel.consume(NOTIFICATION_ANNOUNCEMENT_QUEUE, (message) => {
    if (!message) return;

    void (async () => {
      try {
        const parsed = JSON.parse(message.content.toString()) as {
          type: string;
          data: NotificationAnnouncementBatchPayload;
        };
        if (parsed.type === "notification.announcement_batch") {
          await handleAnnouncementBatch(parsed.data);
        } else {
          logger.warn(`Unknown announcement event type: ${parsed.type}`);
        }
        channel.ack(message);
      } catch (error) {
        // pushToUsers never throws; a failure here is a parse/programming
        // error — drop rather than spin.
        logger.error(
          "Announcement notification consumer failed to process message",
          error
        );
        channel.nack(message, false, false);
      }
    })();
  });
}
