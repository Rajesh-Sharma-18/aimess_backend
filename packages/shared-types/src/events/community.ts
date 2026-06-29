/** Cross-service community domain events (community-service → notifications-service). */
export const CommunityEvents = {
  MEMBER_ADDED: "community.member_added",
  MEMBER_KICKED: "community.member_kicked",
  MEMBER_BANNED: "community.member_banned",
  MEMBER_UNBANNED: "community.member_unbanned",
  MEMBER_MUTED: "community.member_muted",
  MEMBER_UNMUTED: "community.member_unmuted",
  MEMBER_WARNED: "community.member_warned",
  MEMBER_ROLE_CHANGED: "community.member_role_changed",
  JOINED: "community.joined",
  ADMIN_TRANSFERRED: "community.admin_transferred",
  DELETED: "community.deleted",
  CLOSED: "community.closed",
  REOPENED: "community.reopened",
  JOIN_REQUESTED: "community.join_requested",
  JOIN_REQUEST_APPROVED: "community.join_request_approved",
  JOIN_REQUEST_REJECTED: "community.join_request_rejected",
  JOIN_REQUEST_CANCELLED: "community.join_request_cancelled",
  INVITE_SENT: "community.invite_sent",
  INVITE_ACCEPTED: "community.invite_accepted",
  INVITE_LINK_SHARED: "community.invite_link_shared",
  REPORT_CREATED: "community.report_created",
  REPORT_ACTIONED: "community.report_actioned",
  MEMBER_LEFT: "community.member_left",
  MEMBER_JOINED: "community.member_joined",
  // Livestream lifecycle (community-service stream-lifecycle consumer →
  // notifications-service). Distinct from the raw stream-service `stream.*`
  // events: these are the enriched, recipient-resolved notification triggers.
  LIVESTREAM_STARTED: "community.livestream_started",
  LIVESTREAM_ENDED: "community.livestream_ended",
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
    | "invite_link_redeem"
    | "self_join";
  /** The join request this add fulfilled, when via join_request_approved. */
  requestId?: string;
  /** Community display name (for notification copy). */
  communityName?: string;
  /** Admins + moderators to inform that a member joined (consumer excludes the actor + the joiner). */
  moderatorRecipientIds?: string[];
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

/**
 * Cross-service unban event (community-service → notifications-service). Named
 * with a `Notify` suffix to avoid clashing with the socket-layer
 * `CommunityMemberUnbannedPayload` in `../community.ts`.
 */
export type CommunityMemberUnbannedNotifyPayload = CommunityEventBase & {
  actorId: string;
  targetUserId: string;
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

/**
 * Published when a user self-joins a PUBLIC community and is immediately
 * made ACTIVE (no approval required). Distinct from `community.member_added`
 * (admin-driven) and from the legacy `community.joined` no-op.
 */
export type CommunityMemberJoinedPayload = CommunityEventBase & {
  /** The user who self-joined. */
  userId: string;
  communityName: string;
  communityHandle: string;
  communityAvatarUrl: string | null;
  /** True when a previously-LEFT member is reactivated. */
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

/**
 * Cross-service close event (community-service → notifications-service). Named
 * with a `Notify` suffix to avoid clashing with the socket-layer
 * `CommunityClosedPayload` in `../community.ts`.
 *
 * Published when the community ADMIN/owner CLOSES the community (status → CLOSED).
 * All members are auto-removed; notify each so their UI updates. Distinct from
 * `community.deleted` (permanent) — a CLOSED community can be reopened.
 */
export type CommunityClosedNotifyPayload = CommunityEventBase & {
  actorId: string;
  reason: string | null;
  /** All members that were active at close time — notify each. */
  memberIds: string[];
};

/** Deep-link navigation object embedded in community notification payloads. */
export interface NotificationNavigation {
  screen:
    | "COMMUNITY_REQUESTS"
    | "COMMUNITY_DETAILS"
    | "COMMUNITY_CHAT"
    | "COMMUNITY_LIVESTREAM";
  communityId: string;
  communityName: string;
  communityAvatarUrl: string | null;
  communityHandle: string | null;
  requestId?: string;
  /** Set on COMMUNITY_LIVESTREAM navigation — the stream to open. */
  livestreamId?: string;
}

/**
 * A livestream went LIVE in a community. Published by the community-service
 * stream-lifecycle consumer (enriched from the raw `stream.started` event) for
 * push fan-out. `recipientIds` is the pre-resolved eligible audience (active
 * members minus the host minus anyone who muted livestream notifications for
 * this community); the consumer still applies per-user category + quiet-hours
 * gating before sending.
 */
export type CommunityLivestreamStartedPayload = CommunityEventBase & {
  livestreamId: string;
  /** The member who started the stream (excluded from recipients). */
  hostUserId: string;
  hostDisplayName: string;
  hostAvatarUrl: string | null;
  /** Stream title, when set. */
  title?: string;
  communityName: string;
  communityHandle: string | null;
  communityAvatarUrl: string | null;
  /** Pre-resolved eligible audience — notify each. */
  recipientIds: string[];
};

/** A livestream ENDED in a community. Mirrors the started payload + duration. */
export type CommunityLivestreamEndedPayload = CommunityEventBase & {
  livestreamId: string;
  hostUserId: string;
  hostDisplayName: string;
  hostAvatarUrl: string | null;
  title?: string;
  communityName: string;
  communityHandle: string | null;
  communityAvatarUrl: string | null;
  /** Human-readable runtime, e.g. "1h 24m". */
  duration: string;
  durationSeconds: number;
  recipientIds: string[];
};

export type CommunityJoinRequestedPayload = CommunityEventBase & {
  /** Requester. */
  userId: string;
  requestId: string;
  message: string | null;
  /** Admins + moderators that can action this request — notify each. */
  moderatorRecipientIds: string[];
  communityName: string;
  communityHandle: string;
  communityAvatarUrl: string | null;
  requesterDisplayName: string;
  requesterAvatarUrl: string | null;
};

export type CommunityJoinRequestApprovedPayload = CommunityEventBase & {
  communityName: string;
  communityHandle: string;
  communityAvatarUrl: string | null;
  requestId: string;
  /** The requesting user (recipient of the notification). */
  userId: string;
  decidedBy: { userId: string; username: string | null; displayName: string };
  /** ISO-8601. */
  decidedAt: string;
};

export type CommunityJoinRequestRejectedPayload = CommunityEventBase & {
  communityName: string;
  communityHandle: string;
  communityAvatarUrl: string | null;
  requestId: string;
  /** The requesting user (recipient of the notification). */
  userId: string;
  decidedBy: { userId: string; username: string | null; displayName: string };
  /** ISO-8601. */
  decidedAt: string;
};

/** Published when a user cancels their own pending join request. */
export type CommunityJoinRequestCancelledPayload = CommunityEventBase & {
  communityName: string;
  communityHandle: string;
  communityAvatarUrl: string | null;
  requestId: string;
  /** The user who cancelled (both actor and notification recipient). */
  userId: string;
  /** ISO-8601. */
  cancelledAt: string;
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

export type CommunityMemberLeftPayload = CommunityEventBase & {
  /** The user who voluntarily left. */
  actorId: string;
  reason: string | null;
};

/**
 * Published when the owner REOPENs a previously-CLOSED community
 * (community-service → notifications-service). The community was empty during
 * the CLOSED period (all members were evicted on close), so there is no former-
 * member roster to fan push out to — the consumer is socket-only.
 */
export type CommunityReopenedNotifyPayload = CommunityEventBase & {
  /** Owner who triggered the reopen. */
  actorId: string;
  communityName: string;
};

/**
 * Fired once per recipient when an ADMIN/MODERATOR bulk-shares an invite link.
 * Consumed by chat-service → sends a system DM containing the invite link.
 * Routed via `community.chat.sync.queue` (chat-service dedicated queue).
 */
export type CommunityInviteLinkSharedPayload = {
  communityId: string;
  communityName: string;
  /** The invite link code (used to build the deep-link URL on the client). */
  linkCode: string;
  /** User who clicked "Share Invite" — becomes the DM sender. */
  inviterId: string;
  /** Single recipient for this event (one event per userId). */
  recipientId: string;
  /** ISO-8601 timestamp captured at emit time. */
  eventAt: string;
};
