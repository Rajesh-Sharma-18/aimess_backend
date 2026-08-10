import { z } from "zod";

import { publishAdminReportIngestSafe } from "../events/publish-admin-report.js";

/**
 * Same free-text rule community-service's createReportSchema uses, NOT a closed
 * enum: the shared Report Member dialog is community's, and 4 of its 6 reason ids
 * (OFFENSIVE_LANGUAGE / INAPPROPRIATE_CONTENT / SCAM_OR_FRAUD / IMPERSONATION)
 * were rejected outright by the old group enum. backoffice-service's
 * normalizeReportReason canonicalizes whatever arrives, so the enum bought
 * nothing downstream and only let the reason vocabularies drift. Every value the
 * old enum allowed is still ≥3 chars, so existing clients are unaffected.
 */
export const reportUserReasonSchema = z
  .string()
  .trim()
  .min(3, "Reason must be at least 3 characters")
  .max(1000, "Reason must be at most 1000 characters");

/**
 * ONE user-report path for every chat context. Community-service's
 * `createReport` publishes the same `admin.report.ingest` event into the same
 * sink (admin_db.Report) — this is that sink's chat-side entry point, shared by
 * the group member report and the private-chat user report so neither can drift
 * from the other on the wire shape or on the dedup key.
 *
 * `sourceReportId` is DETERMINISTIC per (context, room, reporter, target).
 * admin_db.Report carries a unique index on it, so a repeat report from the same
 * reporter against the same user in the same room is swallowed as a no-op by the
 * consumer — the same "one report per reporter per target" rule community
 * enforces with its own 409, reached without a second report collection here.
 *
 * ponytail: idempotent-200 instead of community's 409 on the duplicate, because
 * a 409 would need a chat-side report row to read. Add a `UserReport` model with
 * a (context, roomId, reporterId, targetUserId) unique index if the FE ever has
 * to tell the reporter "you already reported this person".
 */
export type ChatReportContext = "GROUP" | "PRIVATE";

const CONTEXT_PREFIX: Record<ChatReportContext, string> = {
  GROUP: "grp",
  PRIVATE: "dm",
};

export function publishUserReport(params: {
  context: ChatReportContext;
  /** Group room id / private room id — the report's context, kept in the key. */
  roomId: string;
  reporterId: string;
  targetUserId: string;
  reason: string;
  description?: string;
}): void {
  const details = params.description?.trim();
  publishAdminReportIngestSafe({
    type: "user",
    targetId: params.targetUserId,
    reporterId: params.reporterId,
    reason: params.reason,
    details: details ? details : null,
    // Groups and private rooms are never community-scoped.
    communityId: null,
    eventAt: new Date().toISOString(),
    sourceReportId: `${CONTEXT_PREFIX[params.context]}:${params.roomId}:${params.reporterId}:${params.targetUserId}`,
  });
}
