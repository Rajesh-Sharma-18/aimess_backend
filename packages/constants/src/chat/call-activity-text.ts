import { STORED_TEXT_LOCALE, type SupportedLocale } from "../locale.js";
import { t } from "../i18n.js";
import type { MessageKey } from "../messages/index.js";

import {
  formatCallDuration,
  resolveCallOutcome,
} from "./group-system-message-text.js";

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
  | "NOTIF_CALL_DECLINED"
  | "NOTIF_CALL_YOU_DECLINED"
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
 * The outcome comes from `resolveCallOutcome` (endReason over status), the same
 * rule the timeline, preview and push use (contract §9).
 */
export function buildCallActivityText(params: {
  callType?: string | null;
  status?: string | null;
  endReason?: string | null;
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

  switch (resolveCallOutcome(params)) {
    case "live":
      return t(
        key(outgoing ? "NOTIF_CALL_OUTGOING" : "NOTIF_CALL_INCOMING"),
        locale
      );
    case "declined":
      return t(
        key(outgoing ? "NOTIF_CALL_DECLINED" : "NOTIF_CALL_YOU_DECLINED"),
        locale
      );
    case "unanswered":
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

/**
 * True when the reader should be BADGED (and the callee pushed): only the
 * callee of an UNANSWERED call. Declined is the callee's own action — the row
 * lands read and no push goes out (contract §9).
 */
export function isUnreadCallActivity(
  status: string,
  direction: CallActivityDirection,
  ringDurationSec?: number | null,
  endReason?: string | null,
  durationSec?: number | null
): boolean {
  if (direction === "OUTGOING") return false;
  if (resolveCallOutcome({ status, endReason, durationSec }) !== "unanswered")
    return false;
  return (
    String(status ?? "").toUpperCase() !== "CANCELLED" ||
    cancelCountsAsMissed(ringDurationSec)
  );
}
