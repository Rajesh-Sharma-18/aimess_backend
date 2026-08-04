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
   * FCM collapse key — multiple pending notifications with the same key are
   * collapsed into one on the device. Useful for chat threads (Android).
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
  /**
   * APNs notification category identifier. iOS uses this to look up registered
   * UNNotificationCategory actions (e.g. Accept / Decline buttons on a call
   * notification). No-op on Android and data-only pushes.
   */
  apnsCategory?: string;
}

/** FCM error codes that mean the token is permanently dead → prune it. */
const INVALID_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

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
  collapseKey,
  apnsThreadId,
  ttl = 86_400,
  priority = "normal",
  dataOnly = false,
  apnsCategory,
}: SendPushParams): Promise<SendPushResult> {
  // Merge deepLink into the data map so native clients can read it.
  const enrichedData: Record<string, string> = {
    ...(data ?? {}),
    ...(deepLink ? { deepLink } : {}),
  };

  // Background pushes must always be priority 5 — Apple silently drops or
  // delays background notifications sent with priority 10.
  const apnsPriority = dataOnly ? "5" : priority === "high" ? "10" : "5";
  const webUrgency = priority === "high" ? "high" : "normal";

  try {
    const messageId = await messaging.send({
      token,
      // Data-only omits `notification` so the OS wakes the app instead of drawing
      // a tray notification (client owns the full-screen call intent).
      ...(dataOnly ? {} : { notification: { title, body } }),

      // ── Android ──────────────────────────────────────────────────────────
      android: {
        priority: priority === "high" ? "high" : "normal",
        ...(collapseKey ? { collapseKey } : {}),
      },

      // ── APNs (iOS) ───────────────────────────────────────────────────────
      apns: {
        headers: {
          "apns-priority": apnsPriority,
          "apns-push-type": dataOnly ? "background" : "alert",
          ...(apnsThreadId ? { "apns-thread-id": apnsThreadId } : {}),
        },
        payload: {
          aps: dataOnly
            ? { contentAvailable: true }
            : {
                sound: "default",
                ...(apnsCategory ? { category: apnsCategory } : {}),
              },
        },
      },

      // ── Web push ─────────────────────────────────────────────────────────
      webpush: {
        notification: {
          icon: "/icons/icon-192.png",
          badge: "/icons/badge-72.png",
          // requireInteraction keeps the notification visible for calls.
          requireInteraction: priority === "high",
        },
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
