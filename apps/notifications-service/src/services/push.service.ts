import { logger } from "@aimess/logger";
import { DEFAULT_LOCALE, t, type SupportedLocale } from "@aimess/constants";
import {
  AdminUserEvents,
  AuthEvents,
  CommunityEvents,
  FriendshipEvents,
} from "@aimess/shared-types";

import { createChatNotificationClient } from "../grpc/chat-notification.client.js";
import { isSessionActiveForRequest } from "../lib/session-active-cache.js";
import { sendPush } from "../providers/firebase/sendPush.js";
import { sendVoipPush } from "../providers/apns/sendVoipPush.js";
import { deviceTokenService } from "./device-token.service.js";
import type { DeviceTokenRow } from "../repositories/device-token.repository.js";
import {
  isCommunityActiveMember,
  isCommunityNotificationEnabled,
} from "./notification-eligibility.service.js";
import {
  evaluateDelivery,
  getNotificationSettings,
  getUserLocale,
  type DeliveryDecision,
  type NotificationCategory,
} from "./notification-settings.service.js";
import type { LocalizedCopy } from "../lib/notification-copy.js";

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
 *
 * Kick and community-deleted used to sit here, which made the `bypassSettings`
 * flags at their producers dead code and left a kicked user with no signal at
 * all. They are now delivered like MEMBER_BANNED, which they are siblings of.
 */
const NOTIFY_SUPPRESSED_TYPES = new Set<string>([]);

/**
 * Account-integrity events the user may never silence, whatever their category
 * toggles or quiet hours say. This list IS the policy — producers no longer
 * each carry their own `bypassSettings: true`, which is how admin ban/suspend/
 * unban ended up silently suppressible for anyone with System notifications off.
 *
 * Informational SYSTEM events (ANNOUNCEMENT, MAINTENANCE, UPDATE_REQUIRED) are
 * deliberately absent: they are exactly what the System toggle is for.
 */
const NON_SUPPRESSIBLE_TYPES = new Set<string>([
  AuthEvents.SECURITY_NEW_LOGIN,
  AuthEvents.PASSWORD_CHANGED,
  AuthEvents.EMAIL_CHANGED,
  AdminUserEvents.USER_BANNED,
  AdminUserEvents.USER_SUSPENDED,
  AdminUserEvents.USER_UNBANNED,
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
  // ── Social ──────────────────────────────────────────────────────────────
  FriendshipEvents.FRIEND_REQUESTED,
  FriendshipEvents.FRIEND_ACCEPTED,
  FriendshipEvents.FRIEND_REJECTED,
  FriendshipEvents.FRIEND_CANCELLED,
  CommunityEvents.MEMBER_BANNED,
  CommunityEvents.MEMBER_KICKED,
  CommunityEvents.DELETED,
  // Call HISTORY — one row per call per participant, written by the
  // `call.activity` projection (consumers/call.consumer.ts) from the canonical
  // terminal CallTimelineStatus. The live ring (CALL_INCOMING) and the
  // missed-call push (CALL_MISSED) stay push-only: they are live events, and
  // letting either write here too would put two cards on one call.
  "call.activity",

  // ── System / account-level ──────────────────────────────────────────────
  // These map to the SYSTEM tab in the Notification Center (categoryWhere).
  // Every type added here must also be covered by categoryWhere("SYSTEM").
  AuthEvents.SECURITY_NEW_LOGIN,
  AuthEvents.PASSWORD_CHANGED,
  AuthEvents.EMAIL_CHANGED,
  AdminUserEvents.USER_BANNED,
  AdminUserEvents.USER_SUSPENDED,
  AdminUserEvents.USER_UNBANNED,
  "ANNOUNCEMENT",
  "MAINTENANCE",
  "UPDATE_REQUIRED",
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
  /**
   * PREFERRED. A copy builder from `notification-copy.ts`, invoked here once the
   * RECIPIENT's language is known. Consumers pass this instead of pre-rendered
   * strings so a single event fanned out to users with different languages
   * produces a different sentence per user — the actor's language never leaks
   * into anyone else's notification.
   */
  copy?: LocalizedCopy;
  /** Pre-rendered title. Only for text that is data, not copy (a person's name). */
  title?: string;
  /** Pre-rendered body. Prefer `copy` — this cannot be localized. */
  body?: string;
  /**
   * Notification-Center heading. `null` = render the row with NO heading (the
   * body is already a self-describing sentence). `undefined` = reuse `title`.
   * Never affects the FCM tray notification, which always needs a title.
   */
  inboxTitle?: string | null;
  /** Actor that triggered the notification (optional). */
  actorId?: string;
  /** Extra string→string context (entity ids, roster, etc.). */
  data?: Record<string, string>;
  /**
   * Additional `data` entries that are USER-FACING TEXT (e.g. the friend-request
   * card's `resolution` line), so they must be rendered in the recipient's
   * language like `copy`. Merged over `data`.
   */
  localizedData?: (locale: SupportedLocale) => Record<string, string>;

  /** Canonical deep-link for navigation on notification click. */
  deepLink?: string;
  /** FCM collapse key — collapse multiple notifs for same conversation. */
  collapseKey?: string;
  /**
   * APNs thread-id for notification grouping (iOS). Stable identifier shared by
   * all notifications belonging to the same conversation. Format: type_id
   * (e.g. chat_conv123, group_group789, community_comm456).
   */
  apnsThreadId?: string;
  /**
   * Chat/conversation type for client-side foreground suppression and navigation.
   * Used to determine notification grouping and enable clients to suppress
   * duplicate banners when user is already viewing the conversation.
   */
  chatType?: "PERSONAL" | "GROUP" | "COMMUNITY";
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
   * Use ONLY for mechanical sends the user never sees as a notification —
   * read-receipt and call-cancellation data pushes — and for community
   * kick/ban/delete, which must also skip the ACTIVE-membership gate because
   * the recipient is by definition no longer a member.
   *
   * Do NOT use it for security alerts: add the type to NON_SUPPRESSIBLE_TYPES
   * instead, so the policy stays in one auditable place.
   * Inbox row is still persisted; FCM is still sent.
   */
  bypassSettings?: boolean;
  /**
   * When the caller already knows the user's showPreview=false, pass the
   * generic body here. When push.service detects showPreview=false in the
   * fetched settings, body is replaced with this value (or "New message").
   * The title is never modified.
   */
  showPreviewOverride?: string | ((locale: SupportedLocale) => string);
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
  /**
   * When true, a recipient's registered VOIP (iOS PushKit) token is sent an
   * APNs VoIP push instead of being skipped. MUST be true only for an actual
   * live-ringing event (incoming call / cancel-the-ring) — Apple requires
   * every VoIP push to trigger CallKit's incoming-call UI, and can revoke the
   * app's VoIP entitlement if VoIP pushes are used for anything else (missed
   * call, chat message, etc.).
   */
  allowVoip?: boolean;
  /**
   * Inbox-only: write the Notification-Center row and send NO push.
   *
   * The mirror image of `skipInbox`. Used by the call-history projection,
   * whose live counterpart (the ring, the missed-call alert) was already
   * pushed by its own producer — pushing again here would notify twice for
   * one call. Settings/quiet-hours gating still applies to the row.
   */
  skipPush?: boolean;
  /**
   * Skip the device that originated the action. The read-dismiss push uses it so the device
   * where the conversation was read is not told to dismiss what it already cleared.
   */
  excludeDeviceId?: string;
  /**
   * APNs notification category — iOS maps this to registered UNNotificationCategory
   * actions (e.g. "Accept" / "Decline" buttons). Pass "INCOMING_CALL" for call rings.
   * Ignored on Android and data-only pushes.
   */
  apnsCategory?: string;
}

/**
 * Deliver one notification to one recipient:
 *   1. check the per-category setting + quiet hours (allow-on-failure), unless
 *      bypassSettings=true or the type is non-suppressible. Category OFF stops
 *      here; quiet hours only stops the push at step 4,
 *   2. persist an inbox row via chat-service CreateNotification (best-effort),
 *   3. apply showPreview masking to the provider payload only,
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
    actorId,
    data: rawData,
    deepLink,
    collapseKey,
    apnsThreadId,
    ttl,
    priority,
    bypassSettings = false,
    showPreviewOverride,
    skipInbox = false,
    skipPush = false,
    dataOnly = false,
    allowVoip = false,
    excludeDeviceId,
    apnsCategory,
  } = input;

  // Resolve the RECIPIENT's language before any copy is materialized. Cached in
  // Redis alongside their notification settings, so this is the same round-trip
  // the settings gate below already pays.
  const locale = await getUserLocale(userId).catch(() => DEFAULT_LOCALE);
  const rendered = input.copy?.(locale);
  const title = rendered?.title ?? input.title ?? "";
  const inboxTitleOverride =
    input.inboxTitle !== undefined ? input.inboxTitle : rendered?.inboxTitle;

  const body = rendered?.body ?? input.body ?? "";
  const data = input.localizedData
    ? { ...(rawData ?? {}), ...input.localizedData(locale) }
    : rawData;

  // `bypassSettings` remains for mechanical, non-user-facing sends (read
  // receipts, call cancellations) that would be nonsense to gate. Security and
  // account-integrity events are exempted by TYPE instead, so the policy is
  // auditable in one list rather than spread across producers.
  const skipSettingsGate = bypassSettings || NON_SUPPRESSIBLE_TYPES.has(type);

  let decision: DeliveryDecision = "ALLOW";
  let showPreview = true;

  if (!skipSettingsGate) {
    try {
      const settings = await getNotificationSettings(userId);
      decision = evaluateDelivery(settings, category);
      showPreview = settings.showPreview !== false;
    } catch (error) {
      // getNotificationSettings already allows-on-open; defensive catch only.
      logger.warn(`settings check failed for ${userId}; allowing`);
      logger.warn(error);
    }
  }

  // Category OFF means "I do not want this class of thing" — kill the push and
  // the inbox row. Quiet hours means "not right now", so it only silences the
  // push further down and the inbox row is still written to be found later.
  if (decision === "CATEGORY_OFF") {
    logger.info(
      `Notification suppressed by category setting: user=${userId} type=${type} category=${category}`
    );
    return;
  }

  // ACTIVE-membership gate first (fail-closed): LEFT / BANNED / PENDING /
  // missing members never get community FCM or inbox pushes. Preference
  // toggles are checked second. Lifecycle events that intentionally target
  // non-members skip both via COMMUNITY_MEMBERSHIP_GATE_EXEMPT_TYPES.
  if (!bypassSettings && !COMMUNITY_MEMBERSHIP_GATE_EXEMPT_TYPES.has(type)) {
    const communityId = data?.communityId;
    if (communityId) {
      try {
        const isActive = await isCommunityActiveMember(userId, communityId);
        if (!isActive) {
          logger.info(
            `Notification suppressed: user=${userId} is not an ACTIVE member of community=${communityId} type=${type}`
          );
          return;
        }
      } catch (error) {
        // Fail-closed: never notify a possibly-former member when the
        // membership oracle errors out.
        logger.warn(
          `community membership check failed for ${userId}; suppressing`
        );
        logger.warn(error);
        return;
      }

      const prefField =
        input.communityPrefField ?? defaultCommunityPrefField(category);
      if (prefField) {
        try {
          const enabled = await isCommunityNotificationEnabled(
            userId,
            communityId,
            prefField
          );
          if (!enabled) {
            logger.info(
              `Notification suppressed by community preference: user=${userId} community=${communityId} field=${prefField} type=${type}`
            );
            return;
          }
        } catch (error) {
          // Preference oracle is also fail-closed (membership is encoded
          // there too) — suppress rather than notify former members.
          logger.warn(`community pref check failed for ${userId}; suppressing`);
          logger.warn(error);
          return;
        }
      }
    }
  }

  // Preview masking is a lock-screen concern — it hides the message from
  // whoever is looking over the user's shoulder. The Notification Center is
  // already behind the app's own auth, so the inbox row keeps the real body and
  // only the provider payload below is masked. Title is left unchanged either way.
  const pushBody = showPreview
    ? body
    : typeof showPreviewOverride === "function"
      ? showPreviewOverride(locale)
      : (showPreviewOverride ?? t("NOTIF_CHAT_NEW_MESSAGE", locale));

  // Persist the inbox row (best-effort; circuit-breaker-wrapped). Skipped
  // for chat-activity pushes (skipInbox) and for any type not on the
  // Notification Center allowlist — the Notification Center is
  // important-events-only, everything else stays FCM+realtime-only.
  if (!skipInbox && INBOX_ALLOWED_TYPES.has(type)) {
    try {
      const inboxTitle = inboxTitleOverride;
      await chatNotificationClient.createNotification({
        userId,
        actorId,
        type,
        title,
        body,
        data: {
          ...(data ?? {}),
          ...(inboxTitle === null
            ? { suppressTitle: "true" }
            : inboxTitle
              ? { inboxTitle }
              : {}),
        },
      });
    } catch (error) {
      logger.warn(`CreateNotification inbox write failed for ${userId}`);
      logger.warn(error);
    }
  }

  // Inbox-only projection (call history): the row IS the deliverable and there
  // is no device to wake — anything time-critical about the same call was
  // already pushed by the ring / missed-call producer.
  if (skipPush) return;

  // Quiet hours: the inbox row above is written and the badge bumps, but no
  // device is woken. The user finds it waiting when the window ends.
  if (decision === "QUIET_HOURS") {
    logger.info(
      `Push suppressed by quiet hours (inbox row kept): user=${userId} type=${type}`
    );
    return;
  }

  // Load all device tokens for this user.
  let rawTokens: DeviceTokenRow[];
  try {
    rawTokens = await deviceTokenService.getTokensForUser(userId);
  } catch (error) {
    logger.warn(`Failed to load device tokens for ${userId}`);
    logger.warn(error);
    return;
  }

  // Deduplicate tokens before sending — prevents duplicate pushes when the same
  // token appears more than once in the store.
  const deduped = [...new Map(rawTokens.map((t) => [t.token, t])).values()];
  const visible = excludeDeviceId
    ? deduped.filter((t) => t.deviceId !== excludeDeviceId)
    : deduped;

  // Last line of defence against the reported symptom: a device whose session
  // was revoked (logout, remote sign-out, password change, ban, deletion) must
  // never receive a push, even if the RabbitMQ cleanup event was lost. The
  // Redis active-session cache is authoritative and FAILS OPEN — only an
  // explicit "revoked" marker drops a token, so a Redis outage or a legacy row
  // with no sessionId can never silence a live device.
  const tokens = (
    await Promise.all(
      visible.map(async (row) => {
        if (!row.sessionId) return row;
        if (await isSessionActiveForRequest(row.sessionId)) return row;
        // The event never arrived; delete the row now so this is a one-time cost.
        await deviceTokenService.pruneToken(row.token).catch(() => undefined);
        logger.info(
          `[push:deliver] dropped token of revoked session=${row.sessionId} user=${userId}`
        );
        return null;
      })
    )
  ).filter((row): row is DeviceTokenRow => row !== null);

  // HOP 4 (final) of the push pipeline. tokens=0 means this user has NO
  // registered device, so nothing can ever be delivered no matter what the rest
  // of the backend does — fix registration in the browser, not here.
  if (tokens.length === 0) {
    logger.warn(
      `[push:deliver] user=${userId} type=${type} tokens=0 — NO registered device, nothing sent`
    );
    return;
  }
  logger.info(
    `[push:deliver] user=${userId} type=${type} tokens=${tokens.length}`
  );

  // If there is at least one VoIP token, CallKit will handle the call ring on
  // iOS. When there is none, we fall back to a notification-bearing FCM push
  // so the user sees at least a banner on a killed iOS app.
  const hasVoipToken = tokens.some((t) => t.tokenType === "VOIP");

  await Promise.all(
    tokens.map(async ({ token, tokenType, platform }) => {
      // VOIP tokens are iOS PushKit tokens registered only for call ringing —
      // they must go over raw APNs, never FCM (FCM doesn't reach PushKit), and
      // ONLY for an event explicitly marked allowVoip (see PushInput docs).
      // A VOIP token is not a valid FCM channel either, so anything else for
      // that token is skipped rather than misdelivered.
      if (tokenType === "VOIP" && !allowVoip) return;

      // ponytail: iOS without a VoIP token gets a notification-carrying FCM
      // push for call rings so a killed app shows a banner. When a VoIP token
      // exists, CallKit handles it and we keep dataOnly to avoid a double ring.
      const effectiveDataOnly =
        dataOnly &&
        !(
          tokenType === "FCM" &&
          platform === "IOS" &&
          allowVoip &&
          !hasVoipToken
        );

      const result =
        tokenType === "VOIP"
          ? await sendVoipPush({ token, data: data ?? {}, ttl })
          : await sendPush({
              token,
              title,
              body: pushBody,
              data,
              deepLink,
              // The community avatar already rides in `data` on every community
              // push — reuse it as the tray image so the OS stops falling back
              // to the app logo. Non-community pushes simply have no key here.
              imageUrl: data?.communityAvatarUrl,
              collapseKey,
              apnsThreadId,
              ttl,
              priority,
              dataOnly: effectiveDataOnly,
              platform,
              apnsCategory,
            });
      if (result.invalidToken) {
        try {
          await deviceTokenService.pruneToken(token);
          logger.info(`Pruned dead device token for user=${userId}`);
        } catch (error) {
          logger.warn(`Failed to prune dead token for user=${userId}`);
          logger.warn(error);
        }
        return;
      }

      // Accepted by FCM/APNs → the device is reachable. Refresh the liveness
      // stamp (throttled to once a day) so the stale-token sweeper never
      // reaps a device that is simply long-lived.
      if (result.messageId !== null || tokenType === "VOIP") {
        await deviceTokenService.touchToken(token).catch(() => undefined);
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
