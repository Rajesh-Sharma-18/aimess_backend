/** Service-scoped constants (replaced when scaffolding). */
export const SERVICE_SLUG = "community-service" as const;
export const SERVICE_TITLE = "Community Service" as const;

/**
 * Static platform-wide maximum number of members a community may have.
 *
 * For now this is a single fixed cap surfaced as `memberLimit` on every
 * community payload — it is NOT stored per-community and NOT yet enforced on
 * join/add. When the cap needs to vary per community (tiers, admin override),
 * promote it to a `memberLimit` column on the `Community` model and read it
 * per-row; the API field name stays the same, so clients won't change.
 */
export const COMMUNITY_MEMBER_LIMIT = 256 as const;

// Community.statusClosedReasonCode written when the owner was permanently
// system-banned. Read by the access policy (wire status), the DTO banner and
// reopenCommunity — one literal, three interpreters.
export const CLOSE_REASON_ADMIN_BANNED = "ADMIN_BANNED" as const;

// CommunityMember.removedReason written for a membership revoked by that
// system ban — keeps the forensic trail distinguishable from a kick/leave.
export const REMOVED_REASON_SYSTEM_BANNED = "system_banned" as const;
