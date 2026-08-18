import { STORED_TEXT_LOCALE, type SupportedLocale } from "../locale.js";
import { t } from "../i18n.js";
import type { MessageKey } from "../messages/index.js";

import { formatCallDuration } from "./group-system-message-text.js";

/**
 * Which end of the call the READER was on. Derived from the call record itself
 * (`callerId === viewerId`), never from the notification text.
 */
export type CallActivityDirection = "INCOMING" | "OUTGOING";

type CallCopyBase =
  | "NOTIF_CALL_INCOMING"
  | "NOTIF_CALL_OUTGOING"
  | "NOTIF_CALL_MISSED"
  | "NOTIF_CALL_DECLINED"
  | "NOTIF_CALL_CANCELLED"
  | "NOTIF_CALL_FAILED"
  | "NOTIF_CALL_ENDED"
  | "NOTIF_CALL_COMPLETED";

/**
 * SINGLE SOURCE OF TRUTH for the Notification-Center call-activity line.
 *
 * This is a PRESENTATION mapping over the canonical call lifecycle — it adds no
 * state of its own. The status it takes is exactly a `CallTimelineStatus`,
 * the same value the chat timeline row stores in `content.call.callStatus`, so
 * one call reads consistently in the DM, in the conversation list and in the
 * Notification Center.
 *
 * Direction only changes the wording where the two ends genuinely experienced
 * different things:
 *   - a call the callee never picked up is MISSED to them and OUTGOING to the
 *     caller (nothing was "missed" by the person who placed it),
 *   - a caller who hangs up mid-ring CANCELLED it, while for the callee that
 *     ring is indistinguishable from a missed call — so it reads as missed.
 * DECLINED / FAILED / ENDED describe the call, not a side, and read the same
 * for both.
 */
export function buildCallActivityText(params: {
  callType?: string | null;
  status?: string | null;
  direction: CallActivityDirection;
  durationSec?: number | null;
  locale?: SupportedLocale;
}): string {
  const locale = params.locale ?? STORED_TEXT_LOCALE;
  const video = String(params.callType ?? "").toUpperCase() === "VIDEO";
  // Typed on purpose: the template-literal return type must still be assignable
  // to MessageKey, so a typo or a missing VOICE/VIDEO twin fails to compile
  // instead of shipping a raw key string as the notification body.
  const key = (base: CallCopyBase): MessageKey =>
    `${base}_${video ? "VIDEO" : "VOICE"}`;
  const outgoing = params.direction === "OUTGOING";
  const status = String(params.status ?? "ENDED").toUpperCase();

  switch (status) {
    // Live states never reach the inbox today (only terminal outcomes are
    // projected), but a ringing row must still read sanely if one ever does.
    case "RINGING":
    case "ANSWERED":
      return t(
        key(outgoing ? "NOTIF_CALL_OUTGOING" : "NOTIF_CALL_INCOMING"),
        locale
      );
    case "MISSED":
      return t(
        key(outgoing ? "NOTIF_CALL_OUTGOING" : "NOTIF_CALL_MISSED"),
        locale
      );
    case "CANCELLED":
      return t(
        key(outgoing ? "NOTIF_CALL_CANCELLED" : "NOTIF_CALL_MISSED"),
        locale
      );
    case "DECLINED":
      return t(key("NOTIF_CALL_DECLINED"), locale);
    case "FAILED":
      return t(key("NOTIF_CALL_FAILED"), locale);
    default: {
      const seconds = Math.max(0, Math.floor(Number(params.durationSec ?? 0)));
      // No duration recorded → say "Voice call", never a fabricated 00:00.
      return seconds > 0
        ? t(key("NOTIF_CALL_ENDED"), locale, {
            duration: formatCallDuration(seconds),
          })
        : t(key("NOTIF_CALL_COMPLETED"), locale);
    }
  }
}

/** True when this outcome is the one the reader should be BADGED about. */
export function isUnreadCallActivity(
  status: string,
  direction: CallActivityDirection
): boolean {
  if (direction === "OUTGOING") return false;
  const s = String(status ?? "").toUpperCase();
  // A ring the callee never answered — whether it timed out (MISSED) or the
  // caller gave up first (CANCELLED) — is the missed call they need to see.
  return s === "MISSED" || s === "CANCELLED" || s === "DECLINED";
}
