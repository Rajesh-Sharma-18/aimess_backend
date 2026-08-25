/** Service-scoped constants. */
export const SERVICE_SLUG = "backoffice-service" as const;
export const SERVICE_TITLE = "Backoffice Service" as const;

/** Admin role keys — mirror the `RoleKey` enum in the Prisma schema. */
export const ROLE_KEYS = {
  SUPER_ADMIN: "SUPER_ADMIN",
  ADMIN: "ADMIN",
  MODERATOR: "MODERATOR",
  SUPPORT_AGENT: "SUPPORT_AGENT",
  ANALYST: "ANALYST",
} as const;

export type RoleKeyValue = (typeof ROLE_KEYS)[keyof typeof ROLE_KEYS];

/**
 * Permission catalogue (resource.action). Source of truth for the seed.
 * See docs/ADMIN-SERVICE-DESIGN.md §5.
 */
// Every module carries up to three keys: `<module>.read` gates entering the
// module (sidebar + list), `<module>.view` gates the detail/conversation/
// player screens, and `<module>.moderate|manage|action` gates the destructive
// actions. `view` and `read` are implied from an action key (see
// lib/implied-reads.ts) so a grant of just the edit key still works.
export const PERMISSIONS = {
  DASHBOARD_READ: "dashboard.read",
  USERS_READ: "users.read",
  USERS_VIEW: "users.view",
  USERS_MODERATE: "users.moderate",
  REPORTS_READ: "reports.read",
  REPORTS_VIEW: "reports.view",
  REPORTS_ACTION: "reports.action",
  COMMUNITIES_READ: "communities.read",
  COMMUNITIES_VIEW: "communities.view",
  COMMUNITIES_MODERATE: "communities.moderate",
  GROUPS_READ: "groups.read",
  GROUPS_VIEW: "groups.view",
  GROUPS_MODERATE: "groups.moderate",
  LIVESTREAMS_READ: "livestreams.read",
  LIVESTREAMS_VIEW: "livestreams.view",
  LIVESTREAMS_MODERATE: "livestreams.moderate",
  CATEGORIES_READ: "categories.read",
  CATEGORIES_MANAGE: "categories.manage",
  ANNOUNCEMENTS_READ: "announcements.read",
  ANNOUNCEMENTS_MANAGE: "announcements.manage",
  AUDITLOGS_READ: "auditlogs.read",
  SYSTEMHEALTH_READ: "systemhealth.read",
  ADMINS_READ: "admins.read",
  ADMINS_MANAGE: "admins.manage",
  SETTINGS_MANAGE: "settings.manage",
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** Audit-log action names emitted by services. */
export const AUDIT_ACTIONS = {
  ADMIN_LOGIN: "admin.login",
  ADMIN_LOGIN_FAILED: "admin.login_failed",
  ADMIN_LOGOUT: "admin.logout",
  ADMIN_TOKEN_REFRESHED: "admin.token_refreshed",
  ADMIN_PASSWORD_RESET_REQUESTED: "admin.password_reset_requested",
  ADMIN_PASSWORD_RESET_COMPLETED: "admin.password_reset_completed",
  USER_LIST_VIEWED: "user.list_viewed",
  USER_BANNED: "user.banned",
  USER_SUSPENDED: "user.suspended",
  USER_UNBANNED: "user.unbanned",
  USER_BULK_BANNED: "user.bulk_banned",
  USER_BULK_ACTIVATED: "user.bulk_activated",
  USER_COMMUNITIES_VIEWED: "user.communities_viewed",
  USER_COMMUNITY_MEMBERS_VIEWED: "user.community_members_viewed",
  REPORT_RESOLVED: "report.resolved",
  REPORT_DISMISSED: "report.dismissed",
  // A sanction was applied to the reported user as part of a resolution. Distinct
  // from REPORT_RESOLVED (which records the decision): this records the punishment,
  // and only fires when one was actually chosen.
  REPORT_ACTIONED: "report.actioned",
  REPORT_BULK_RESOLVED: "report.bulk_resolved",
  REPORT_BULK_DISMISSED: "report.bulk_dismissed",
  COMMUNITY_LIST_VIEWED: "community.list_viewed",
  COMMUNITY_CLOSED: "community.close",
  COMMUNITY_REOPENED: "community.reopen",
  COMMUNITY_BULK_CLOSED: "community.bulk_close",
  COMMUNITY_BULK_REOPENED: "community.bulk_reopen",
  // Same string values as @aimess/messaging USER_AUDIT_ACTIONS.COMMUNITY_MEMBER_REMOVED/
  // BANNED/UNBANNED — mandatory USER_MANAGEMENT category, so these actions land in
  // the same audit bucket whether triggered here or mirrored from community-service.
  COMMUNITY_MEMBER_REMOVED: "community.member_removed",
  COMMUNITY_MEMBER_BANNED: "community.member_banned",
  COMMUNITY_MEMBER_UNBANNED: "community.member_unbanned",
  // Cascade rows written when a permanent system ban closes a space its target
  // owned. One row per closed community/group, so the blast radius of a single
  // ban is auditable.
  COMMUNITY_CLOSED_OWNER_BANNED: "community.closed_owner_banned",
  GROUP_CLOSED_OWNER_BANNED: "group.closed_owner_banned",
  GROUP_LIST_VIEWED: "group.list_viewed",
  GROUP_VIEWED: "group.viewed",
  GROUP_MEMBERS_VIEWED: "group.members_viewed",
  GROUP_DISBANDED: "group.disbanded",
  GROUP_MEMBER_REMOVED: "group.member_removed",
  // Permanent, indefinite GROUP-scoped ban/unban of a single member (mandatory
  // USER_MANAGEMENT category, mirrors COMMUNITY_MEMBER_BANNED/UNBANNED).
  GROUP_MEMBER_BANNED: "group.member_banned",
  GROUP_MEMBER_UNBANNED: "group.member_unbanned",
  LIVESTREAM_ENDED: "livestream.ended",
  LIVESTREAM_BULK_ENDED: "livestream.bulk_ended",
  LIVESTREAM_REPORTS_BULK_REVIEWED: "livestream.reports_bulk_reviewed",
  LIVESTREAM_THUMBNAIL_UPDATED: "livestream.thumbnail_updated",
  ANNOUNCEMENT_CREATED: "announcement.created",
  ANNOUNCEMENT_UPDATED: "announcement.updated",
  ANNOUNCEMENT_CANCELLED: "announcement.cancelled",
  ANNOUNCEMENT_SENT: "announcement.sent",
  ANNOUNCEMENT_FAILED: "announcement.failed",
  CATEGORY_CREATED: "category.created",
  CATEGORY_UPDATED: "category.updated",
  CATEGORY_DELETED: "category.deleted",
  ADMIN_CREATED: "admin.created",
  ADMIN_UPDATED: "admin.updated",
  ADMIN_ACTIVATED: "admin.activated",
  ADMIN_DEACTIVATED: "admin.deactivated",
  ADMIN_DELETED: "admin.deleted",
  ADMIN_PERMISSIONS_UPDATED: "admin.permissions_updated",
  ADMIN_PROFILE_UPDATED: "admin.profile_updated",
  ADMIN_PASSWORD_CHANGED: "admin.password_changed",
  SYSTEM_ALL_FRIENDSHIPS_DISCONNECTED: "system.all_friendships_disconnected",
  SYSTEM_CALLING_TOGGLED: "system.calling_toggled",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
