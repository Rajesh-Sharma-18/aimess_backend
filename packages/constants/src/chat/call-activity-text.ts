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
 * are "it rang and nobody picked up" — so ANY ring the caller gave up on before
 * it was answered IS a missed call and must badge, no matter how briefly it
 * rang. There is deliberately no misdial grace: a caller who hangs up in the
 * first second still leaves the callee a missed-call notification. The threshold
 * lives here next to the readers of it rather than in either service.
 */
export const CALL_CANCEL_GRACE_SEC = 0;

/**
 * True when a CANCELLED ring lasted long enough that the callee genuinely
 * missed it. `ringDurationSec` is `endedAt - initiatedAt` from the call record;
 * an absent value (legacy event, group row) is treated as a real missed call —
 * the pre-existing behaviour, so an old payload never silently loses its badge.
 */
export function cancelCountsAsMissed(ringDurationSec?: number | null): boolean {
  if (ringDurationSec === undefined || ringDurationSec === null) return true;
  return Number(ringDurationSec) >= CALL_CANCEL_GRACE_SEC;
}

type CallCopyBase =
  | "NOTIF_CALL_INCOMING"
  | "NOTIF_CALL_OUTGOING"
  | "NOTIF_CALL_NO_ANSWER"
  | "NOTIF_CALL_MISSED"
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
 * Every call that never connected collapses onto ONE viewer-relative pair: the
 * caller got no answer, the callee missed it. AiMess deliberately has no
 * user-facing "cancelled" or "declined" call — those are lifecycle states, and
 * surfacing them told each side the other's business. The canonical status
 * survives untouched on the call row and in `data.callStatus`.
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
    // EVERY call that never connected, whoever ended it. "Cancelled" and
    // "declined" are LIFECYCLE facts, not user-facing outcomes: the person who
    // PLACED the call got no answer, and the person who was RUNG missed it.
    // Which side hung up first is not what either of them experienced, so it
    // must never reach the copy. The canonical status is still on the row
    // (`data.callStatus`) for anything that genuinely needs it.
    case "MISSED":
    case "CANCELLED":
    case "DECLINED":
    case "FAILED":
      return t(
        key(outgoing ? "NOTIF_CALL_NO_ANSWER" : "NOTIF_CALL_MISSED"),
        locale
      );
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
  //
  // DECLINED badges as well: the decline is taken on ONE device, and the
  // reader's other devices still need the row surfaced rather than arriving
  // pre-read. The call was never answered on those, which is what the badge
  // is about.
  // FAILED sits here rather than in the default branch so the two halves of
  // this module agree. `buildCallActivityText` already renders FAILED with the
  // missed-call copy — telling the callee they missed a call while leaving the
  // row unbadged is a contradiction that would surface the first time anything
  // wrote it. Nothing writes it today (there is deliberately no producer), so
  // this changes no current behaviour; it removes the trap.
  if (s === "MISSED" || s === "DECLINED" || s === "FAILED") return true;
  return s === "CANCELLED" && cancelCountsAsMissed(ringDurationSec);
}
