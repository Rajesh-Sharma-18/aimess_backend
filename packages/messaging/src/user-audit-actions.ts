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
  USER_PASSWORD_RESET_COMPLETED: "user.password_reset_completed",
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
  COMMUNITY_ROLE_CHANGED: "community.role_changed",
  COMMUNITY_OWNERSHIP_TRANSFERRED: "community.ownership_transferred",
  COMMUNITY_JOIN_REQUEST_APPROVED: "community.join_request_approved",
  COMMUNITY_JOIN_REQUEST_REJECTED: "community.join_request_rejected",
  COMMUNITY_INVITE_LINK_CREATED: "community.invite_link_created",
  COMMUNITY_INVITE_LINK_REVOKED: "community.invite_link_revoked",

  // chat-service — group lifecycle + membership (never per-message)
  GROUP_CREATED: "group.created",
  GROUP_UPDATED: "group.updated",
  GROUP_DISBANDED: "group.disbanded",
  GROUP_MEMBER_ADDED: "group.member_added",
  GROUP_MEMBER_REMOVED: "group.member_removed",
  GROUP_MEMBER_LEFT: "group.member_left",
  GROUP_MEMBER_BANNED: "group.member_banned",
  GROUP_MEMBER_UNBANNED: "group.member_unbanned",
  GROUP_ROLE_CHANGED: "group.role_changed",

  // stream-service — broadcast lifecycle + in-stream moderation
  STREAM_STARTED: "stream.started",
  STREAM_ENDED: "stream.ended",

  // any service — user filed an abuse report
  REPORT_SUBMITTED: "report.submitted",
} as const;

export type UserAuditAction =
  (typeof USER_AUDIT_ACTIONS)[keyof typeof USER_AUDIT_ACTIONS];
