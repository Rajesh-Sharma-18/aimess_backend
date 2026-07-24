import { logger } from "@aimess/logger";
import { CommunityEvents, FriendshipEvents } from "@aimess/shared-types";

import { createChatNotificationClient } from "../grpc/chat-notification.client.js";
import { sendPush } from "../providers/firebase/sendPush.js";
import { deviceTokenService } from "./device-token.service.js";
import { isCommunityNotificationEnabled } from "./notification-eligibility.service.js";
import {
  getNotificationSettings,
  isDeliveryAllowed,
  type NotificationCategory,
} from "./notification-settings.service.js";

type CommunityPrefField =
  | "chatEnabled"
  | "streamEnabled"
  | "announcementEnabled";

/**
 * Category → per-community preference field, used when a caller doesn't pass
 * `communityPrefField` explicitly. `chatEnabled` (private/group DMs) and the
 * other non-community categories have no community mapping.
 */
function defaultCommunityPrefField(
  category: NotificationCategory
): CommunityPrefField | undefined {
  if (category === "liveStreamEnabled") return "streamEnabled";
  if (category === "communityEnabled") return "announcementEnabled";
  return undefined;
}

const chatNotificationClient = createChatNotificationClient();

/**
 * Notification types that must never reach the `notify` socket (or the
 * inbox), nor FCM. Checked first in `pushToUser` so no DB row, FCM send, or
 * socket event is ever produced for these types.
 *
 * Join Rejected / Unban / Stream Started are deliberately NOT here — the
 * Notification Center business requirement lists them as required entries
 * (see `friend.consumer.ts` / `community.consumer.ts`), so they must reach
 * the inbox + push like any other business event.
 */
const NOTIFY_SUPPRESSED_TYPES = new Set<string>([
  CommunityEvents.MEMBER_KICKED,
  CommunityEvents.DELETED,
]);

/**
 * Notification Center allowlist — only these event types are persisted as an
 * inbox row (and therefore ever surface from `GET /api/v1/chat/notifications`
 * or the `notification:new`/`notification:count_update` socket events).
 * Everything else (community messages, member joined/left/added/removed,
 * role changes, mutes, reports, livestream, etc.) still gets FCM push same as
 * before — this only gates the Notification Center write. Extensible: add a
 * type here to enable it in the inbox without touching any producer.
 */
const INBOX_ALLOWED_TYPES = new Set<string>([
  FriendshipEvents.FRIEND_REQUESTED,
  FriendshipEvents.FRIEND_ACCEPTED,
  CommunityEvents.MEMBER_BANNED,
]);

/**
 * Notification types that intentionally target a non-ACTIVE recipient for a
 * community (invitee, rejected join requester, unbanned former member). The
 * community preference/membership oracle would return enabled=false for them,
 * so these skip that gate while still honoring global settings/quiet-hours.
 * Kick/ban/delete use `bypassSettings` instead (critical, non-toggleable).
 */
const COMMUNITY_MEMBERSHIP_GATE_EXEMPT_TYPES = new Set<string>([
  CommunityEvents.JOIN_REQUEST_APPROVED,
  CommunityEvents.JOIN_REQUEST_REJECTED,
  CommunityEvents.INVITE_SENT,
  CommunityEvents.MEMBER_UNBANNED,
]);

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
   * Data-only push: omit the FCM `notification` block so the OS doesn't draw a
   * tray notification and the app is woken to own the UI (full-screen call
   * intent). Required for the call ring/cancel wake on a killed Android app.
   */
  dataOnly?: boolean;
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
  /**
   * When true, skip the `CreateNotification` inbox write (and the
   * `notification:new`/`notification:count_update` `/notify` socket events
   * chat-service's gRPC handler fires from it) — FCM push and unread-badge
   * flows for the underlying feature (e.g. per-conversation unread counts)
   * are untouched, since those never read the Notification collection.
   * The Notification Center is business-events-only; chat activity
   * (messages, reactions, replies, typing, read receipts, edits, deletes)
   * must never appear there. Use for any chat-activity push.
   */
  skipInbox?: boolean;
  /**
   * Explicit per-community preference field to gate on (chatEnabled for
   * community chat messages, streamEnabled for livestream, announcementEnabled
   * for everything else). Only takes effect when `data.communityId` is set.
   * Defaults from `category` via `defaultCommunityPrefField` when omitted —
   * pass this explicitly whenever `category` doesn't already disambiguate
   * (e.g. community chat messages currently share the `communityEnabled`
   * category with generic community events but must gate on `chatEnabled`).
   */
  communityPrefField?: CommunityPrefField;
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
  if (NOTIFY_SUPPRESSED_TYPES.has(input.type)) {
    return;
  }

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
    skipInbox = false,
    dataOnly = false,
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

  // Per-community notification-preference + ACTIVE-membership gate
  // (Chat/Community/Live Stream toggles on the community's own mute-setting
  // row, and membership must be ACTIVE). Independent of, and in addition to,
  // the global per-category settings check above. Lifecycle events that
  // intentionally target non-members (invites, join decisions, unban) skip
  // this gate via COMMUNITY_MEMBERSHIP_GATE_EXEMPT_TYPES.
  if (!bypassSettings && !COMMUNITY_MEMBERSHIP_GATE_EXEMPT_TYPES.has(type)) {
    const communityId = data?.communityId;
    const prefField =
      input.communityPrefField ?? defaultCommunityPrefField(category);
    if (communityId && prefField) {
      try {
        const enabled = await isCommunityNotificationEnabled(
          userId,
          communityId,
          prefField
        );
        if (!enabled) {
          logger.info(
            `Notification suppressed by community preference/membership: user=${userId} community=${communityId} field=${prefField} type=${type}`
          );
          return;
        }
      } catch (error) {
        // Fail-open: an oracle outage never suppresses a notification.
        logger.warn(`community pref check failed for ${userId}; allowing`);
        logger.warn(error);
      }
    }
  }

  // Apply preview masking — title is intentionally left unchanged.
  if (!showPreview) {
    body = showPreviewOverride ?? "New message";
  }

  // Persist the inbox row (best-effort; circuit-breaker-wrapped). Skipped
  // for chat-activity pushes (skipInbox) and for any type not on the
  // Notification Center allowlist — the Notification Center is
  // important-events-only, everything else stays FCM+realtime-only.
  if (!skipInbox && INBOX_ALLOWED_TYPES.has(type)) {
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
        dataOnly,
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
