import { logger } from "@aimess/logger";

import { createChatNotificationClient } from "../grpc/chat-notification.client.js";
import { sendPush } from "../providers/firebase/sendPush.js";
import { redis } from "../config/redis.js";
import { deviceTokenService } from "./device-token.service.js";
import {
  getNotificationSettings,
  isDeliveryAllowed,
  type NotificationCategory,
} from "./notification-settings.service.js";

const chatNotificationClient = createChatNotificationClient();

export interface PushInput {
  userId: string;
  category: NotificationCategory;
  /** Domain event type, persisted on the inbox row (e.g. community.member_added). */
  type: string;
  title: string;
  body: string;
  /** Actor that triggered the notification (optional). */
  actorId?: string;
  /** Extra string→string context (entity ids, roster, etc.). */
  data?: Record<string, string>;
}

/**
 * Deliver one notification to one recipient:
 *   1. check per-category setting + quiet hours (allow-on-failure),
 *   2. persist an inbox row via chat-service CreateNotification (best-effort),
 *   3. fan a push out to every device token, pruning dead tokens.
 * Never throws — push delivery must not poison the consumer (which would DLQ).
 */
export async function pushToUser(input: PushInput): Promise<void> {
  const { userId, category, type, title, body, actorId, data } = input;

  let allowed = true;
  try {
    const settings = await getNotificationSettings(userId);
    allowed = isDeliveryAllowed(settings, category);
  } catch (error) {
    // getNotificationSettings already allows-on-open; defensive catch only.
    logger.warn(`settings check failed for ${userId}; allowing`);
    logger.warn(error);
  }

  if (!allowed) {
    logger.info(
      `Notification suppressed by settings/quiet-hours: user=${userId} type=${type}`
    );
    return;
  }

  // Presence-aware routing: skip FCM when the user has an active socket
  // connection. The api-gateway sets user:online:{userId} (TTL 300 s) on
  // connect and refreshes it on every presence:heartbeat; the key is deleted
  // on clean disconnect. If the key exists, the user will receive the event
  // via the real-time socket channel and does not need a push notification.
  try {
    const isOnline = await redis.exists(`user:online:${userId}`);
    if (isOnline) {
      logger.debug(`FCM skipped — user ${userId} is online via socket`);
      // Still persist the inbox row so the notification appears in-app.
    } else {
      // Offline path: fall through to FCM below.
    }
    if (isOnline) {
      // Persist inbox row then return — no FCM needed.
      try {
        await chatNotificationClient.createNotification({
          userId,
          actorId,
          type,
          title,
          body,
          data,
        });
      } catch (error) {
        logger.warn(`CreateNotification inbox write failed for ${userId}`);
        logger.warn(error);
      }
      return;
    }
  } catch (error) {
    logger.warn(
      `Redis presence check failed for ${userId}; sending FCM anyway`
    );
    logger.warn(error);
  }

  // Persist the inbox row (best-effort; circuit-breaker-wrapped).
  try {
    await chatNotificationClient.createNotification({
      userId,
      actorId,
      type,
      title,
      body,
      data,
    });
  } catch (error) {
    logger.warn(`CreateNotification inbox write failed for ${userId}`);
    logger.warn(error);
  }

  // Fan out push to all of the user's devices; prune dead tokens.
  let tokens: string[];
  try {
    tokens = await deviceTokenService.getTokensForUser(userId);
  } catch (error) {
    logger.warn(`Failed to load device tokens for ${userId}`);
    logger.warn(error);
    return;
  }

  await Promise.all(
    tokens.map(async (token) => {
      const result = await sendPush({ token, title, body, data });
      if (result.invalidToken) {
        try {
          await deviceTokenService.pruneToken(token);
          logger.info(`Pruned dead device token for ${userId}`);
        } catch (error) {
          logger.warn(`Failed to prune dead token for ${userId}`);
          logger.warn(error);
        }
      }
    })
  );
}

/** Fan a single notification out to many recipients (deduplicated). */
export async function pushToUsers(
  userIds: string[],
  build: (userId: string) => PushInput
): Promise<void> {
  const unique = [...new Set(userIds.filter(Boolean))];
  await Promise.all(unique.map((userId) => pushToUser(build(userId))));
}
