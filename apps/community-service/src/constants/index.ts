/** Service-scoped constants (replaced when scaffolding). */
export const SERVICE_SLUG = "community-service" as const;
export const SERVICE_TITLE = "Community Service" as const;


// Community.statusClosedReasonCode written when the owner was permanently
// system-banned. Read by the access policy (wire status), the DTO banner and
// reopenCommunity — one literal, three interpreters.
export const CLOSE_REASON_ADMIN_BANNED = "ADMIN_BANNED" as const;

// Community.statusClosedReasonCode written when the last ACTIVE member, the
// admin, left and the community closed with them. Nobody is left to own it, so
// reopenCommunity refuses it and Super Admin lists it as closed.
export const CLOSE_REASON_LAST_MEMBER_LEFT = "LAST_MEMBER_LEFT" as const;

// CommunityMember.removedReason written for a membership revoked by that
// system ban — keeps the forensic trail distinguishable from a kick/leave.
export const REMOVED_REASON_SYSTEM_BANNED = "system_banned" as const;
