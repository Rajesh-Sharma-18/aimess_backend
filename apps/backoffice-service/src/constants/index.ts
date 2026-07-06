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
export const PERMISSIONS = {
  DASHBOARD_READ: "dashboard.read",
  USERS_READ: "users.read",
  USERS_MODERATE: "users.moderate",
  USERS_DELETE: "users.delete",
  REPORTS_READ: "reports.read",
  REPORTS_ACTION: "reports.action",
  COMMUNITIES_READ: "communities.read",
  COMMUNITIES_MODERATE: "communities.moderate",
  GROUPS_READ: "groups.read",
  GROUPS_MODERATE: "groups.moderate",
  LIVESTREAMS_READ: "livestreams.read",
  LIVESTREAMS_MODERATE: "livestreams.moderate",
  CATEGORIES_MANAGE: "categories.manage",
  ANNOUNCEMENTS_MANAGE: "announcements.manage",
  AUDITLOGS_READ: "auditlogs.read",
  SYSTEMHEALTH_READ: "systemhealth.read",
  ADMINS_MANAGE: "admins.manage",
  SETTINGS_MANAGE: "settings.manage",
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** Audit-log action names emitted by services. */
export const AUDIT_ACTIONS = {
  ADMIN_LOGIN: "admin.login",
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
  REPORT_BULK_RESOLVED: "report.bulk_resolved",
  REPORT_BULK_DISMISSED: "report.bulk_dismissed",
  COMMUNITY_LIST_VIEWED: "community.list_viewed",
  COMMUNITY_CLOSED: "community.close",
  COMMUNITY_REOPENED: "community.reopen",
  COMMUNITY_BULK_CLOSED: "community.bulk_close",
  COMMUNITY_BULK_REOPENED: "community.bulk_reopen",
  GROUP_LIST_VIEWED: "group.list_viewed",
  GROUP_VIEWED: "group.viewed",
  GROUP_MEMBERS_VIEWED: "group.members_viewed",
  LIVESTREAM_ENDED: "livestream.ended",
  LIVESTREAM_BULK_ENDED: "livestream.bulk_ended",
  LIVESTREAM_REPORTS_BULK_REVIEWED: "livestream.reports_bulk_reviewed",
  LIVESTREAM_THUMBNAIL_UPDATED: "livestream.thumbnail_updated",
  ANNOUNCEMENT_CREATED: "announcement.created",
  ANNOUNCEMENT_SENT: "announcement.sent",
  ANNOUNCEMENT_FAILED: "announcement.failed",
  CATEGORY_CREATED: "category.created",
  CATEGORY_UPDATED: "category.updated",
  CATEGORY_DELETED: "category.deleted",
  ADMIN_CREATED: "admin.created",
  ADMIN_UPDATED: "admin.updated",
  ADMIN_ACTIVATED: "admin.activated",
  ADMIN_DEACTIVATED: "admin.deactivated",
  ADMIN_PERMISSIONS_UPDATED: "admin.permissions_updated",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
