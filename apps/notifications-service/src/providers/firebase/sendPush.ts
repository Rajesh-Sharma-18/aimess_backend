import { messaging } from "./firebase.js";
import { logger } from "@aimess/logger";

interface SendPushParams {
  token: string;
  title: string;
  body: string;
  /** Optional string→string data payload delivered alongside the notification. */
  data?: Record<string, string>;
  /** Canonical deep-link for click-to-navigate (web + native). */
  deepLink?: string;
  /**
   * Large image / avatar shown by the OS (FCM `notification.image`, APNs
   * `fcm_options.image`, Web Push `icon`). Must be an already-resolved absolute
   * https URL — object keys are not fetchable by the device. Ignored on
   * data-only pushes, where the app draws the tray entry itself.
   */
  imageUrl?: string;
  /**
   * Collapse key — a pending notification is REPLACED by a later one carrying
   * the same key rather than stacking beside it. Applied on all three
   * platforms: `android.collapseKey`, APNs `apns-collapse-id`, Web Push
   * `Topic`. Max 64 bytes (the APNs limit; longer keys skip the APNs header).
   */
  collapseKey?: string;
  /**
   * APNs thread-id for grouping notifications on iOS. All notifications with
   * the same thread-id are grouped together. Format: type_id.
   */
  apnsThreadId?: string;
  /** Message TTL in seconds. Default: 86 400 (24 h). */
  ttl?: number;
  /** FCM delivery priority. Use 'high' for calls/time-sensitive events. */
  priority?: "high" | "normal";
  /**
   * When true, omit the `notification` block so the OS doesn't draw a tray
   * notification — the app is woken to own the UI (e.g. full-screen call intent).
   */
  dataOnly?: boolean;
  /** Token platform ("ANDROID" | "IOS" | "WEB"). Decides whether the tray entry is
   *  drawn by the OS or by the app — see the Android note in the body below. */
  platform?: string;
  /**
   * APNs notification category identifier. iOS uses this to look up registered
   * UNNotificationCategory actions (e.g. Accept / Decline buttons on a call
   * notification). No-op on Android and data-only pushes.
   */
  apnsCategory?: string;
}

/**
 * FCM error codes that mean the token is permanently dead → prune it.
 *
 * Deliberately EXCLUDED even though they also fail the send:
 * `messaging/mismatched-credential`, `messaging/third-party-auth-error` and
 * `messaging/authentication-error` are SERVER misconfigurations (wrong service
 * account, bad APNs cert). Treating them as dead tokens would wipe every
 * registration in the database the moment a credential is rotated wrong.
 */
const INVALID_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-recipient",
  // Token was minted for a different FCM sender — unusable by this project no
  // matter how many times we retry.
  "messaging/sender-id-mismatch",
  // Ambiguous: also raised for a malformed payload. Kept because a malformed
  // token is by far its most common cause here (payloads are built identically
  // for every recipient, so a payload bug fails every send, not one token).
  "messaging/invalid-argument",
]);

/** Transient transport failures — retrying helps, unlike a dead token or bad payload. */
const RETRYABLE_CODES = new Set([
  "messaging/server-unavailable",
  "messaging/internal-error",
  "messaging/unknown-error",
  "messaging/quota-exceeded",
]);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * FCM's transport fails transiently far more often than permanently, and a single
 * throw used to lose the notification outright — the caller only logs it, nothing
 * retries, and the RabbitMQ message is already being ACKed. Three attempts with
 * backoff. Anything non-retryable (dead token, malformed payload) rethrows at once
 * so the caller's INVALID_TOKEN_CODES classifier still runs unchanged.
 */
async function sendWithRetry(
  message: Parameters<typeof messaging.send>[0]
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await messaging.send(message);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (attempt >= 2 || !RETRYABLE_CODES.has(code)) throw error;
      logger.warn(`FCM transient failure (${code}) — retry ${attempt + 1}/2`);
      await sleep(200 * 2 ** attempt);
    }
  }
}

export interface SendPushResult {
  /** The FCM message id when delivered, else null. */
  messageId: string | null;
  /** True when the failure indicates the token should be removed from the store. */
  invalidToken: boolean;
}

export async function sendPush({
  token,
  title,
  body,
  data,
  deepLink,
  imageUrl,
  collapseKey,
  apnsThreadId,
  ttl = 86_400,
  priority = "normal",
  dataOnly = false,
  platform,
  apnsCategory,
}: SendPushParams): Promise<SendPushResult> {
  // Merge deepLink into the data map so native clients can read it.
  const enrichedData: Record<string, string> = {
    ...(data ?? {}),
    ...(deepLink ? { deepLink } : {}),
  };

  const isAndroid = String(platform ?? "").toUpperCase() === "ANDROID";
  const kind = String(enrichedData.type ?? "").toUpperCase();
  // A `notification` block makes this a NOTIFICATION message on Android: when the app is
  // backgrounded or killed the OS draws the tray entry itself and onMessageReceived is never
  // called — so the client cannot group by conversation, attach avatars, or offer Reply.
  // Android therefore goes data-only across the board and the app owns the presentation.
  // iOS keeps the block (no Notification Service Extension to rebuild it there).
  //
  // The avatar is why this cannot stay scoped to messages. `imageUrl` below is an AVATAR
  // (communityAvatarUrl || conversationAvatar || callerAvatar), but `notification.image` is the
  // OS's ONLY image slot and renders full-bleed — Android has no way to express "circular large
  // icon" from a push payload. Every OS-drawn card therefore came out as the app launcher icon
  // beside the entity's avatar blown up to full width. The client puts it in the icon slot, but
  // only ever sees the push when it owns the rendering.
  const androidOwnsRendering = isAndroid;
  const omitNotification = dataOnly || androidOwnsRendering;

  // The localized copy lived in the `notification` block the client no longer receives, so carry
  // it in the data map. MESSAGE is excluded on purpose: it renders from `preview`/`contentType`
  // into MessagingStyle, and a raw title/body would override that composed text.
  if (androidOwnsRendering && kind !== "MESSAGE") {
    if (title) enrichedData.pushTitle = title;
    if (body) enrichedData.pushBody = body;
  }

  // Background pushes must always be priority 5 — Apple silently drops or
  // delays background notifications sent with priority 10.
  const apnsPriority = dataOnly ? "5" : priority === "high" ? "10" : "5";
  const webUrgency = priority === "high" ? "high" : "normal";
  // A data-only Android push is only woken promptly at high priority; at normal it is held
  // until the device leaves Doze, which would make messages arrive minutes late.
  const androidPriority =
    priority === "high" || androidOwnsRendering ? "high" : "normal";

  // Only absolute http(s) URLs are fetchable by the OS; an object key or a
  // relative path would make FCM reject the whole message.
  const image = /^https?:\/\//i.test(imageUrl ?? "") ? imageUrl : undefined;

  try {
    const messageId = await sendWithRetry({
      token,
      ...(omitNotification
        ? {}
        : {
            notification: {
              title,
              body,
            },
          }),

      // ── Android ──────────────────────────────────────────────────────────
      android: {
        priority: androidPriority,
        ttl: ttl * 1000,
        ...(collapseKey ? { collapseKey } : {}),
        ...(omitNotification || !image
          ? {}
          : { notification: { imageUrl: image } }),
      },

      // ── APNs (iOS) ───────────────────────────────────────────────────────
      apns: {
        headers: {
          "apns-priority": apnsPriority,
          "apns-push-type": dataOnly ? "background" : "alert",
          "apns-expiration": String(Math.floor(Date.now() / 1000) + ttl),
          ...(apnsThreadId ? { "apns-thread-id": apnsThreadId } : {}),
          // APNs' own collapse mechanism — the iOS half of `android.collapseKey`
          // above and Web Push's `Topic` below. Without it iOS was the ONE
          // platform where a queued notification was never replaced: a
          // CALL_INCOMING stored by APNs for an unreachable device outlived its
          // own CALL_CANCELLED and was delivered afterwards, ringing the phone
          // for a call that had already been declined. Every producer that sets
          // `collapseKey` (call.consumer, read.consumer) was already written
          // against replace-not-stack semantics; this is what makes iOS honour
          // them.
          //
          // APNs caps the id at 64 BYTES and rejects the whole request with
          // `BadCollapseId` if it is longer — dropping the notification
          // entirely. Every current key is a 41–48 byte `<prefix>:<uuid>`, but
          // omitting an oversized one degrades to the previous (stacking)
          // behaviour instead of losing the push.
          ...(collapseKey && Buffer.byteLength(collapseKey) <= 64
            ? { "apns-collapse-id": collapseKey }
            : {}),
        },
        payload: {
          aps: dataOnly
            ? { contentAvailable: true }
            : {
                sound: "default",
                ...(apnsCategory ? { category: apnsCategory } : {}),
                // REQUIRED for the image below: iOS only invokes the app's
                // Notification Service Extension when mutable-content is 1, and
                // the NSE is what downloads `fcm_options.image` and attaches it.
                // Without this flag the image field is delivered and ignored,
                // which is why community/group pushes showed no picture. Set
                // only when there IS an image, so alert-only pushes keep their
                // current (cheaper, NSE-free) delivery path.
                ...(image ? { mutableContent: true } : {}),
              },
        },
        // Downloaded and attached by the app's Notification Service Extension
        // (paired with mutable-content above; harmless when no NSE exists).
        ...(omitNotification || !image
          ? {}
          : { fcmOptions: { imageUrl: image } }),
      },

      // ── Web push ─────────────────────────────────────────────────────────
      webpush: {
        // Gated on !dataOnly, NOT on omitNotification. Presence of any
        // webpush.notification (even title-less, icon/badge only) makes FCM's JS
        // SDK render the push itself using its own defaults ("Google Chrome /
        // New notification"), which also causes our SW handleBackgroundMessage
        // to early-return on payload.notification — so the caller-name branch
        // for CALL_INCOMING and the tag-close branch for CALL_CANCELLED never
        // run. dataOnly is the correct semantic: "app owns UI, no OS card".
        // The Android-MESSAGE carveout in omitNotification is Android-only —
        // web MESSAGE tokens still need the tray card drawn by the SDK.
        ...(dataOnly
          ? {}
          : {
              notification: {
                // Sender/community avatar when the payload carries one, so the
                // tray card is not always the generic app icon.
                icon: image ?? "/icons/icon-192.png",
                badge: "/icons/badge-72.png",
                // requireInteraction keeps the notification visible for calls.
                requireInteraction: priority === "high",
              },
            }),
        fcmOptions: {
          ...(deepLink ? { link: deepLink } : {}),
        },
        headers: {
          Urgency: webUrgency,
          TTL: String(ttl),
          // Web Push's own collapse mechanism (mirrors android.collapseKey
          // above) — a queued message for an offline client is replaced by
          // the next one carrying the same Topic instead of stacking. Without
          // this, a reconnecting Web client could receive a stale queued
          // "incoming call" push delivered after (or instead of) its
          // already-sent CALL_CANCELLED, showing a ring for a call that's
          // already been handled elsewhere.
          ...(collapseKey ? { Topic: collapseKey } : {}),
        },
      },

      // ── Data payload ─────────────────────────────────────────────────────
      ...(Object.keys(enrichedData).length > 0 ? { data: enrichedData } : {}),
    });

    logger.info("Push delivered:", messageId);
    return { messageId, invalidToken: false };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    const invalidToken = INVALID_TOKEN_CODES.has(code);
    logger.error("FCM send failed — invalidToken:", invalidToken);
    logger.error(error);
    return { messageId: null, invalidToken };
  }
}
