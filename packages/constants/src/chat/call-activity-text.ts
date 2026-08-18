import { STORED_TEXT_LOCALE, type SupportedLocale } from "../locale.js";
import { t } from "../i18n.js";
import type { MessageKey } from "../messages/index.js";

import { formatCallDuration } from "./group-system-message-text.js";

/**
 * Which end of the call the READER was on. Derived from the call record itself
 * (`callerId === viewerId`), never from the notification text.
 */
export type CallActivityDirection = "INCOMING" | "OUTGOING";

/**
 * How long a ring must have lasted before a caller-side CANCEL counts, for the
 * CALLEE, as a call they missed.
 *
 * A cancel and a timeout are indistinguishable from the callee's seat — both
 * are "it rang and nobody picked up" — so a long ring the caller gave up on IS
 * a missed call and must badge. A cancel inside this window is the caller
 * catching a misdial before the callee could plausibly react, and badging that
 * is noise. The threshold is the ONLY thing separating the two, which is why it
 * lives here next to the readers of it rather than in either service.
 */
export const CALL_CANCEL_GRACE_SEC = 5;

/**
 * True when a CANCELLED ring lasted long enough that the callee genuinely
 * missed it. `ringDurationSec` is `endedAt - initiatedAt` from the call record;
 * an absent value (legacy event, group row) is treated as a real missed call —
 * the pre-existing behaviour, so an old payload never silently loses its badge.
 */
function cancelCountsAsMissed(ringDurationSec?: number | null): boolean {
  if (ringDurationSec === undefined || ringDurationSec === null) return true;
  return Number(ringDurationSec) >= CALL_CANCEL_GRACE_SEC;
}

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
  /** Ring length in seconds (`endedAt - initiatedAt`) — CANCELLED only. */
  ringDurationSec?: number | null;
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
    // The caller always reads their own hangup as a cancellation. The callee
    // reads it as a missed call ONLY once the ring outlived the grace window —
    // below it, nothing happened worth calling a missed call.
    case "CANCELLED":
      return t(
        key(
          outgoing || !cancelCountsAsMissed(params.ringDurationSec)
            ? "NOTIF_CALL_CANCELLED"
            : "NOTIF_CALL_MISSED"
        ),
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
  direction: CallActivityDirection,
  ringDurationSec?: number | null
): boolean {
  if (direction === "OUTGOING") return false;
  const s = String(status ?? "").toUpperCase();
  // A ring the callee never answered is the missed call they need to see —
  // whether it timed out (MISSED) or the caller gave up on a ring that had
  // already run long enough to be missable (CANCELLED past the grace window).
  // A caller who cancels inside that window leaves a read history row only.
  if (s === "MISSED") return true;
  return s === "CANCELLED" && cancelCountsAsMissed(ringDurationSec);
}
