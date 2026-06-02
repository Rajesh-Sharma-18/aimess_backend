/** Cross-service community domain events (community-service → notifications-service). */
export const CommunityEvents = {
  MEMBER_ADDED: "community.member_added",
  MEMBER_KICKED: "community.member_kicked",
  MEMBER_BANNED: "community.member_banned",
  MEMBER_MUTED: "community.member_muted",
  MEMBER_UNMUTED: "community.member_unmuted",
  MEMBER_WARNED: "community.member_warned",
  MEMBER_ROLE_CHANGED: "community.member_role_changed",
  JOINED: "community.joined",
  ADMIN_TRANSFERRED: "community.admin_transferred",
  DELETED: "community.deleted",
  JOIN_REQUESTED: "community.join_requested",
  INVITE_SENT: "community.invite_sent",
  INVITE_ACCEPTED: "community.invite_accepted",
  REPORT_CREATED: "community.report_created",
  REPORT_ACTIONED: "community.report_actioned",
} as const;

export type CommunityEventType =
  (typeof CommunityEvents)[keyof typeof CommunityEvents];

/** Common fields on every payload — set at the publish call site. */
type CommunityEventBase = {
  communityId: string;
  /** ISO-8601 timestamp captured at emit time. */
  eventAt: string;
};

export type CommunityMemberAddedPayload = CommunityEventBase & {
  actorId: string; // moderator/admin who added, or self for join-request auto-accept
  targetUserId: string; // the user that became ACTIVE
  /** How the row went ACTIVE. */
  via:
    | "add_members"
    | "join_request_approved"
    | "join_request_auto_accept"
    | "invite_auto_approve"
    | "invite_link_redeem";
};

export type CommunityMemberKickedPayload = CommunityEventBase & {
  actorId: string;
  targetUserId: string;
  reason: string | null;
};

export type CommunityMemberBannedPayload = CommunityEventBase & {
  actorId: string;
  targetUserId: string;
  reason: string | null;
};

export type CommunityMemberMutedPayload = CommunityEventBase & {
  actorId: string;
  targetUserId: string;
  reason: string | null;
  /** ISO-8601; null = indefinite mute. */
  mutedUntil: string | null;
};

export type CommunityMemberUnmutedPayload = CommunityEventBase & {
  actorId: string;
  targetUserId: string;
};

export type CommunityMemberWarnedPayload = CommunityEventBase & {
  actorId: string;
  targetUserId: string;
  note: string;
};

export type CommunityMemberRoleChangedPayload = CommunityEventBase & {
  actorId: string;
  targetUserId: string;
  oldRole: "ADMIN" | "MODERATOR" | "MEMBER";
  newRole: "ADMIN" | "MODERATOR" | "MEMBER";
};

export type CommunityJoinedPayload = CommunityEventBase & {
  /** Caller self-joined a PUBLIC community (or reactivated). */
  userId: string;
  reactivated: boolean;
};

export type CommunityAdminTransferredPayload = CommunityEventBase & {
  /** Outgoing admin. */
  actorId: string;
  /** Incoming admin. */
  targetUserId: string;
  reason: "explicit_transfer" | "admin_left_auto_handover";
};

export type CommunityDeletedPayload = CommunityEventBase & {
  actorId: string;
  reason: "explicit_delete" | "admin_left_no_successor";
  /** All members that were active at deletion time — notify each. */
  memberIds: string[];
};

export type CommunityJoinRequestedPayload = CommunityEventBase & {
  /** Requester. */
  userId: string;
  requestId: string;
  message: string | null;
  /** Admins + moderators that can action this request — notify each. */
  moderatorRecipientIds: string[];
};

export type CommunityInviteSentPayload = CommunityEventBase & {
  inviterId: string;
  inviteeId: string;
  inviteId: string;
};

export type CommunityInviteAcceptedPayload = CommunityEventBase & {
  /** Accepting user. */
  userId: string;
  inviteId: string;
  /** Original inviter — notified that their invite was accepted. */
  inviterId: string;
};

export type CommunityReportCreatedPayload = CommunityEventBase & {
  reportId: string;
  reporterId: string;
  /** Null when the report targets the community itself. */
  targetUserId: string | null;
  reason: string;
  /** Admins + moderators that should review the report — notify each. */
  moderatorRecipientIds: string[];
};

export type CommunityReportActionedPayload = CommunityEventBase & {
  reportId: string;
  actorId: string; // moderator who actioned
  reporterId: string;
  targetUserId: string | null;
};
