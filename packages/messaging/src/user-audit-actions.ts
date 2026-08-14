/**
 * Website-side (end-user) audit actions. Single source of truth shared by every
 * publisher and by backoffice-service (filter dropdown + ingest validation).
 * Deliberately excludes message-level traffic (send/deliver/read/edit/delete) —
 * that is a firehose that would bury the moderation trail; only account,
 * membership, moderation and lifecycle events belong here.
 */
export const USER_AUDIT_ACTIONS = {
  // auth-service — account + session lifecycle
  USER_REGISTERED: "user.registered",
  USER_LOGIN: "user.login",
  USER_LOGIN_FAILED: "user.login_failed",
  USER_LOGOUT: "user.logout",
  USER_PASSWORD_CHANGED: "user.password_changed",
  USER_PASSWORD_RESET_REQUESTED: "user.password_reset_requested",
  USER_PASSWORD_RESET_COMPLETED: "user.password_reset_completed",
  USER_EMAIL_CHANGE_REQUESTED: "user.email_change_requested",
  USER_EMAIL_CHANGE_CONFIRMED: "user.email_change_confirmed",
  USER_SOCIAL_ACCOUNT_LINKED: "user.social_account_linked",
  USER_SOCIAL_ACCOUNT_UNLINKED: "user.social_account_unlinked",
  USER_ACCOUNT_DELETION_REQUESTED: "user.account_deletion_requested",
  USER_ACCOUNT_DELETED: "user.account_deleted",
  USER_DEVICE_LINKED: "user.device_linked",
  USER_SESSION_REVOKED: "user.session_revoked",

  // user-service — profile + relationship moderation
  USER_PROFILE_UPDATED: "user.profile_updated",
  USER_BLOCKED_USER: "user.blocked_user",
  USER_UNBLOCKED_USER: "user.unblocked_user",
  USER_FRIEND_REMOVED: "user.friend_removed",

  // community-service — lifecycle + membership + moderation
  COMMUNITY_CREATED: "community.created",
  COMMUNITY_UPDATED: "community.updated",
  COMMUNITY_DELETED: "community.deleted",
  COMMUNITY_MEMBER_JOINED: "community.member_joined",
  COMMUNITY_MEMBER_LEFT: "community.member_left",
  COMMUNITY_MEMBER_REMOVED: "community.member_removed",
  COMMUNITY_MEMBER_BANNED: "community.member_banned",
  COMMUNITY_MEMBER_UNBANNED: "community.member_unbanned",
  COMMUNITY_MEMBER_MUTED: "community.member_muted",
  COMMUNITY_MEMBER_UNMUTED: "community.member_unmuted",
  COMMUNITY_MEMBER_WARNED: "community.member_warned",
  // Moderator grants are split out of the generic role change: who can moderate
  // is the question an audit reader actually asks, and "role changed" hides it.
  COMMUNITY_MODERATOR_PROMOTED: "community.moderator_promoted",
  COMMUNITY_MODERATOR_DEMOTED: "community.moderator_demoted",
  COMMUNITY_ROLE_CHANGED: "community.role_changed",
  COMMUNITY_OWNERSHIP_TRANSFERRED: "community.ownership_transferred",
  COMMUNITY_JOIN_REQUEST_APPROVED: "community.join_request_approved",
  COMMUNITY_JOIN_REQUEST_REJECTED: "community.join_request_rejected",
  COMMUNITY_INVITE_LINK_CREATED: "community.invite_link_created",
  COMMUNITY_INVITE_LINK_REVOKED: "community.invite_link_revoked",

  // chat-service — message removal is the ONE per-message event that is audited
  // (a deletion destroys evidence, so moderation needs the trail); sends, edits,
  // reactions and receipts stay out.
  MESSAGE_DELETED: "message.deleted",

  // media-service — an uploaded object was destroyed
  MEDIA_DELETED: "media.deleted",

  // chat-service — group lifecycle + membership (never per-message)
  GROUP_CREATED: "group.created",
  GROUP_UPDATED: "group.updated",
  GROUP_DISBANDED: "group.disbanded",
  GROUP_MEMBER_ADDED: "group.member_added",
  GROUP_MEMBER_REMOVED: "group.member_removed",
  GROUP_MEMBER_LEFT: "group.member_left",
  GROUP_MEMBER_BANNED: "group.member_banned",
  GROUP_MEMBER_UNBANNED: "group.member_unbanned",
  GROUP_MODERATOR_PROMOTED: "group.moderator_promoted",
  GROUP_MODERATOR_DEMOTED: "group.moderator_demoted",
  GROUP_ROLE_CHANGED: "group.role_changed",

  // stream-service — broadcast lifecycle + in-stream moderation
  STREAM_STARTED: "stream.started",
  STREAM_ENDED: "stream.ended",

  // any service — the reporter's own side of a report's life
  REPORT_SUBMITTED: "report.submitted",
  REPORT_WITHDRAWN: "report.withdrawn",
  REPORT_DELETED: "report.deleted",
} as const;

export type UserAuditAction =
  (typeof USER_AUDIT_ACTIONS)[keyof typeof USER_AUDIT_ACTIONS];
