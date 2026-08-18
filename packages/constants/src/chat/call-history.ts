import type { CallActivityDirection } from "./call-activity-text.js";
import type { CallTimelineStatus } from "./group-system-message-text.js";

/**
 * SINGLE SOURCE OF TRUTH for the Call History (WhatsApp-style "Calls" tab)
 * presentation model.
 *
 * This module adds NO state to the call lifecycle. It is a pure projection of a
 * canonical `Call` row onto the three axes the history list renders and filters
 * on — direction, outcome and call type — so backend aggregation, the REST
 * response and the client all read one call the same way. Nothing here ever
 * looks at notification or timeline TEXT to decide a direction or an outcome.
 *
 * The canonical DB `Call.status` is deliberately NOT extended: a caller-cancelled
 * ring is stored as `ENDED` with a null `answeredAt` (see CallService.endCall),
 * and CANCELLED exists only at this presentation layer — exactly as it already
 * does for the chat timeline row and the Notification Center line.
 */

/** Which end of the call the VIEWER was on. */
export type CallHistoryDirection = CallActivityDirection;

/**
 * Viewer-relative outcome of one call. Three values, because there are only
 * three things that can have happened to the person reading the row: the call
 * connected, they placed one that never did, or they were rung by one that
 * never did.
 *
 * `NO_ANSWER` is the caller's side of ANY call that never connected — a ring
 * that timed out, one they hung up on first, and one the callee rejected are
 * the same event from where they sat. `MISSED` is the callee's side of those
 * same three. There is deliberately no `DECLINED`/`CANCELLED`/`FAILED` here:
 * those are canonical lifecycle states, not things a user experienced, and
 * exposing them told each side the other's business.
 */
export type CallHistoryResult = "ANSWERED" | "MISSED" | "NO_ANSWER";

export const CALL_HISTORY_FILTERS = [
  "all",
  "incoming",
  "outgoing",
  "missed",
] as const;

export type CallHistoryFilter = (typeof CALL_HISTORY_FILTERS)[number];

/**
 * The canonical DB statuses a SETTLED call can hold. Live rows (RINGING,
 * IN_PROGRESS) are excluded from history: they have no outcome yet, and the row
 * they would render can never update itself into one.
 */
export const TERMINAL_CALL_STATUSES = [
  "ENDED",
  "MISSED",
  "DECLINED",
  "FAILED",
] as const;

/** The minimum a caller must hand over for the resolvers below. */
export interface CallHistoryRecord {
  callerId: string;
  calleeId: string;
  /** Canonical DB `Call.status`. */
  status: string;
  answeredAt?: Date | string | number | null;
  initiatedAt?: Date | string | number | null;
  endedAt?: Date | string | number | null;
}

const millis = (
  value: Date | string | number | null | undefined
): number | null => {
  if (value === null || value === undefined) return null;
  const ms =
    value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
};

/**
 * THE direction resolver. Derived only from the call record's own participants
 * against the viewer — never from a label, a notification body or a UI string.
 */
export function resolveCallDirection(
  call: Pick<CallHistoryRecord, "callerId">,
  viewerId: string
): CallHistoryDirection {
  return call.callerId === viewerId ? "OUTGOING" : "INCOMING";
}

/**
 * Canonical DB status → the presentation status the rest of the product already
 * speaks (`CallTimelineStatus`). The ONE place the ENDED/answeredAt split is
 * read, so history, the DM timeline row and the inbox line cannot disagree
 * about what "cancelled" means.
 */
export function resolveCallTimelineStatus(
  call: Pick<CallHistoryRecord, "status" | "answeredAt">
): CallTimelineStatus {
  switch (String(call.status ?? "").toUpperCase()) {
    case "RINGING":
      return "RINGING";
    case "IN_PROGRESS":
      return "ANSWERED";
    case "MISSED":
      return "MISSED";
    case "DECLINED":
      return "DECLINED";
    case "FAILED":
      return "FAILED";
    default:
      // A ring the caller hung up on never got an `answeredAt`.
      return millis(call.answeredAt) === null ? "CANCELLED" : "ENDED";
  }
}

/**
 * Presentation status + viewer side → the outcome the list filters and colours
 * on. Mirrors `buildCallActivityText`, so a row's label can never contradict
 * its colour or the tab it appears in.
 */
export function resolveCallResult(
  status: CallTimelineStatus,
  direction: CallHistoryDirection
): CallHistoryResult {
  switch (status) {
    // Every way a call can fail to connect collapses to one viewer-relative
    // pair. Which side hung up first is lifecycle bookkeeping and never
    // reaches the row: the caller got no answer, the callee missed it.
    case "MISSED":
    case "CANCELLED":
    case "DECLINED":
    case "FAILED":
      return direction === "INCOMING" ? "MISSED" : "NO_ANSWER";
    default:
      return "ANSWERED";
  }
}

/** True when this row belongs in the list the given tab shows. */
export function matchesCallHistoryFilter(
  filter: CallHistoryFilter,
  direction: CallHistoryDirection,
  result: CallHistoryResult
): boolean {
  switch (filter) {
    case "incoming":
      return direction === "INCOMING";
    case "outgoing":
      return direction === "OUTGOING";
    // Genuinely missed only — the calls the VIEWER was rung by and did not
    // take. Their own unanswered outgoing calls (NO_ANSWER) are not missed
    // calls and stay out of this tab.
    case "missed":
      return result === "MISSED";
    default:
      return true;
  }
}

/**
 * The aggregation identity. Two calls collapse into one history row only when
 * all four axes match AND they are adjacent in the sorted history (see the
 * consecutive-run rule in CallService.getGroupedCallHistory).
 *
 * `contactId` — the PEER, never `callerId`: the viewer is the caller on half
 * their history, so keying on callerId would merge "I called Mohit" with
 * "Mohit called me".
 */
export function callHistoryGroupKey(params: {
  contactId: string;
  direction: CallHistoryDirection;
  callType: string;
  result: CallHistoryResult;
}): string {
  return [
    params.contactId,
    params.direction,
    String(params.callType ?? "").toUpperCase(),
    params.result,
  ].join("|");
}
