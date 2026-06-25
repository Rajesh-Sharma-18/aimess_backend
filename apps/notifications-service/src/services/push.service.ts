import { logger } from "@aimess/logger";

import { createChatNotificationClient } from "../grpc/chat-notification.client.js";
import { sendPush } from "../providers/firebase/sendPush.js";
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

  /** Canonical deep-link for navigation on notification click. */
  deepLink?: string;
  /** FCM collapse key — collapse multiple notifs for same conversation. */
  collapseKey?: string;
  /** FCM message TTL in seconds (default 86400 = 24h). */
  ttl?: number;
  /** FCM delivery priority. Calls use 'high', messages 'normal'. */
  priority?: "high" | "normal";
  /**
   * When true, skip the notification-settings/quiet-hours gate entirely.
   * Use ONLY for non-toggleable critical events (kick, ban, delete, calls).
   * Inbox row is still persisted; FCM is still sent.
   */
  bypassSettings?: boolean;
  /**
   * When the caller already knows the user's showPreview=false, pass the
   * generic body here. When push.service detects showPreview=false in the
   * fetched settings, body is replaced with this value (or "New message").
   * The title is never modified.
   */
  showPreviewOverride?: string;
}

/**
 * Deliver one notification to one recipient:
 *   1. check per-category setting + quiet hours (allow-on-failure),
 *      unless bypassSettings=true,
 *   2. apply showPreview masking if setting is false,
 *   3. persist an inbox row via chat-service CreateNotification (best-effort),
 *   4. fan a push out to every (deduplicated) device token, pruning dead tokens.
 * Never throws — push delivery must not poison the consumer (which would DLQ).
 */
export async function pushToUser(input: PushInput): Promise<void> {
  const {
    userId,
    category,
    type,
    title,
    actorId,
    data,
    deepLink,
    collapseKey,
    ttl,
    priority,
    bypassSettings = false,
    showPreviewOverride,
  } = input;

  let body = input.body;

  let allowed = true;
  // NotificationSettings from gRPC does not yet expose showPreview at the
  // proto level, so we read it as an optional extra field and default to true.
  let showPreview = true;

  if (!bypassSettings) {
    try {
      const settings = await getNotificationSettings(userId);
      allowed = isDeliveryAllowed(settings, category);
      showPreview = settings.showPreview !== false;
    } catch (error) {
      // getNotificationSettings already allows-on-open; defensive catch only.
      logger.warn(`settings check failed for ${userId}; allowing`);
      logger.warn(error);
    }
  }

  if (!allowed) {
    logger.info(
      `Notification suppressed by settings/quiet-hours: user=${userId} type=${type}`
    );
    return;
  }

  // Apply preview masking — title is intentionally left unchanged.
  if (!showPreview) {
    body = showPreviewOverride ?? "New message";
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

  // Load all device tokens for this user.
  let rawTokens: string[];
  try {
    rawTokens = await deviceTokenService.getTokensForUser(userId);
  } catch (error) {
    logger.warn(`Failed to load device tokens for ${userId}`);
    logger.warn(error);
    return;
  }

  // Deduplicate tokens before sending — prevents duplicate pushes when the same
  // token appears more than once in the store.
  const tokens = [...new Set(rawTokens)];

  await Promise.all(
    tokens.map(async (token) => {
      const result = await sendPush({
        token,
        title,
        body,
        data,
        deepLink,
        collapseKey,
        ttl,
        priority,
      });
      if (result.invalidToken) {
        try {
          await deviceTokenService.pruneToken(token);
          logger.info(`Pruned dead device token for user=${userId}`);
        } catch (error) {
          logger.warn(`Failed to prune dead token for user=${userId}`);
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
