import { USER_AUDIT_ACTIONS } from "./user-audit-actions.js";

/**
 * The five mandatory audit categories. Every action the Super Admin's unified
 * Audit Logs list shows belongs to exactly one of them; an action with no
 * category is not mandatory and does not appear on the default page.
 */
export const AUDIT_CATEGORIES = {
  /** Who is allowed to moderate: moderator grants/removals and other role changes. */
  MODERATOR_MANAGEMENT: "MODERATOR_MANAGEMENT",
  /** Admin accounts themselves: created, activated, deactivated, permissions changed. */
  ADMIN_MANAGEMENT: "ADMIN_MANAGEMENT",
  /** Administrative actions taken ON a user: ban, block, mute, warn, remove. */
  USER_MANAGEMENT: "USER_MANAGEMENT",
  /** Managed content: communities, groups, messages, media, categories, announcements, livestreams, reports. */
  CONTENT_MANAGEMENT: "CONTENT_MANAGEMENT",
  /** Login, logout, sessions, devices and credential changes, for admins and end users alike. */
  AUTH_SECURITY: "AUTH_SECURITY",
} as const;

export type AuditCategory =
  (typeof AUDIT_CATEGORIES)[keyof typeof AUDIT_CATEGORIES];

export const AUDIT_CATEGORY_VALUES: readonly AuditCategory[] =
  Object.values(AUDIT_CATEGORIES);

/**
 * The mandatory audit classification: action name → the category it belongs to.
 * This map IS the allowlist — `MANDATORY_AUDIT_ACTIONS` is derived from its keys,
 * so an action can never be mandatory-but-uncategorized or vice versa.
 *
 * Two rules govern membership:
 *  1. the event is a committed state change someone may later have to answer for
 *     (a deletion, a ban, a role grant, a credential change), and
 *  2. its volume is bounded by human action, not by traffic.
 *
 * Everything absent here — page views, joins/leaves, token refreshes, profile
 * edits, per-message traffic — is still recorded and still queryable through an
 * explicit `?action=` filter; it just does not bury the moderation trail.
 *
 * Admin-panel action names appear as literals rather than imports: backoffice-service
 * owns AUDIT_ACTIONS and depends on this package, so importing them here would
 * invert the dependency. The backoffice test suite asserts the two stay in sync.
 *
 * Adding a future event is one line here plus its publisher. Nothing else in the
 * pipeline needs to know.
 */
export const AUDIT_ACTION_CATEGORY: Readonly<Record<string, AuditCategory>> = {
  // ── 1. Moderator management ──────────────────────────────────────────────
  [USER_AUDIT_ACTIONS.COMMUNITY_MODERATOR_PROMOTED]:
    AUDIT_CATEGORIES.MODERATOR_MANAGEMENT,
  [USER_AUDIT_ACTIONS.COMMUNITY_MODERATOR_DEMOTED]:
    AUDIT_CATEGORIES.MODERATOR_MANAGEMENT,
  [USER_AUDIT_ACTIONS.GROUP_MODERATOR_PROMOTED]:
    AUDIT_CATEGORIES.MODERATOR_MANAGEMENT,
  [USER_AUDIT_ACTIONS.GROUP_MODERATOR_DEMOTED]:
    AUDIT_CATEGORIES.MODERATOR_MANAGEMENT,
  // Non-moderator privilege moves (admin hand-off, ownership) answer the same
  // question — who holds power over this space — so they live here too.
  [USER_AUDIT_ACTIONS.COMMUNITY_ROLE_CHANGED]:
    AUDIT_CATEGORIES.MODERATOR_MANAGEMENT,
  [USER_AUDIT_ACTIONS.GROUP_ROLE_CHANGED]:
    AUDIT_CATEGORIES.MODERATOR_MANAGEMENT,
  [USER_AUDIT_ACTIONS.COMMUNITY_OWNERSHIP_TRANSFERRED]:
    AUDIT_CATEGORIES.MODERATOR_MANAGEMENT,

  // ── 2. Admin management ──────────────────────────────────────────────────
  "admin.created": AUDIT_CATEGORIES.ADMIN_MANAGEMENT,
  "admin.updated": AUDIT_CATEGORIES.ADMIN_MANAGEMENT,
  "admin.activated": AUDIT_CATEGORIES.ADMIN_MANAGEMENT,
  "admin.deactivated": AUDIT_CATEGORIES.ADMIN_MANAGEMENT,
  "admin.permissions_updated": AUDIT_CATEGORIES.ADMIN_MANAGEMENT,

  // ── 3. User management ───────────────────────────────────────────────────
  // Platform-level account state.
  "user.banned": AUDIT_CATEGORIES.USER_MANAGEMENT,
  "user.unbanned": AUDIT_CATEGORIES.USER_MANAGEMENT,
  "user.suspended": AUDIT_CATEGORIES.USER_MANAGEMENT,
  "user.bulk_banned": AUDIT_CATEGORIES.USER_MANAGEMENT,
  "user.bulk_activated": AUDIT_CATEGORIES.USER_MANAGEMENT,
  [USER_AUDIT_ACTIONS.USER_ACCOUNT_DELETED]: AUDIT_CATEGORIES.USER_MANAGEMENT,
  // User-on-user moderation.
  [USER_AUDIT_ACTIONS.USER_BLOCKED_USER]: AUDIT_CATEGORIES.USER_MANAGEMENT,
  [USER_AUDIT_ACTIONS.USER_UNBLOCKED_USER]: AUDIT_CATEGORIES.USER_MANAGEMENT,
  // Space-scoped moderation is still an action taken against a person.
  [USER_AUDIT_ACTIONS.COMMUNITY_MEMBER_REMOVED]:
    AUDIT_CATEGORIES.USER_MANAGEMENT,
  [USER_AUDIT_ACTIONS.COMMUNITY_MEMBER_BANNED]:
    AUDIT_CATEGORIES.USER_MANAGEMENT,
  [USER_AUDIT_ACTIONS.COMMUNITY_MEMBER_UNBANNED]:
    AUDIT_CATEGORIES.USER_MANAGEMENT,
  [USER_AUDIT_ACTIONS.COMMUNITY_MEMBER_MUTED]: AUDIT_CATEGORIES.USER_MANAGEMENT,
  [USER_AUDIT_ACTIONS.COMMUNITY_MEMBER_UNMUTED]:
    AUDIT_CATEGORIES.USER_MANAGEMENT,
  [USER_AUDIT_ACTIONS.COMMUNITY_MEMBER_WARNED]:
    AUDIT_CATEGORIES.USER_MANAGEMENT,
  [USER_AUDIT_ACTIONS.GROUP_MEMBER_REMOVED]: AUDIT_CATEGORIES.USER_MANAGEMENT,
  [USER_AUDIT_ACTIONS.GROUP_MEMBER_BANNED]: AUDIT_CATEGORIES.USER_MANAGEMENT,
  [USER_AUDIT_ACTIONS.GROUP_MEMBER_UNBANNED]: AUDIT_CATEGORIES.USER_MANAGEMENT,

  // ── 4. Content / community management ────────────────────────────────────
  [USER_AUDIT_ACTIONS.COMMUNITY_CREATED]: AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  [USER_AUDIT_ACTIONS.COMMUNITY_DELETED]: AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  "community.close": AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  "community.reopen": AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  "community.bulk_close": AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  "community.bulk_reopen": AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  // Cascade of a permanent system ban: the banned user owned this community /
  // group, so it was closed (never deleted) and stays visible to its members.
  // Separate from community.close / group.disbanded so the audit trail shows
  // WHY it closed and an operator can find every space one ban took down.
  "community.closed_owner_banned": AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  "group.closed_owner_banned": AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  [USER_AUDIT_ACTIONS.COMMUNITY_INVITE_LINK_REVOKED]:
    AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  [USER_AUDIT_ACTIONS.GROUP_DISBANDED]: AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  // MESSAGE_DELETED is deliberately absent. It fails rule 2 above: a single
  // person clearing a chat writes a row per message, so the Audit Logs page
  // filled with "Message Deleted" and buried the moderation trail it exists to
  // show. The rows are STILL written by the ingest consumer (which allowlists
  // USER_AUDIT_ACTIONS, not this map) and stay queryable with an explicit
  // `?action=message.deleted` — they just no longer appear on the default page,
  // under the Content / Community Management category, or in the live feed.
  [USER_AUDIT_ACTIONS.MEDIA_DELETED]: AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  "category.created": AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  "category.updated": AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  "category.deleted": AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  "announcement.created": AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  "announcement.sent": AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  [USER_AUDIT_ACTIONS.STREAM_ENDED]: AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  "livestream.ended": AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  "livestream.bulk_ended": AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  [USER_AUDIT_ACTIONS.REPORT_SUBMITTED]: AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  [USER_AUDIT_ACTIONS.REPORT_WITHDRAWN]: AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  [USER_AUDIT_ACTIONS.REPORT_DELETED]: AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  "report.resolved": AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  "report.dismissed": AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  "report.actioned": AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  "report.bulk_resolved": AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  "report.bulk_dismissed": AUDIT_CATEGORIES.CONTENT_MANAGEMENT,
  "livestream.reports_bulk_reviewed": AUDIT_CATEGORIES.CONTENT_MANAGEMENT,

  // ── 5. Authentication / security ─────────────────────────────────────────
  "admin.login": AUDIT_CATEGORIES.AUTH_SECURITY,
  "admin.login_failed": AUDIT_CATEGORIES.AUTH_SECURITY,
  "admin.logout": AUDIT_CATEGORIES.AUTH_SECURITY,
  "admin.password_changed": AUDIT_CATEGORIES.AUTH_SECURITY,
  "admin.password_reset_requested": AUDIT_CATEGORIES.AUTH_SECURITY,
  "admin.password_reset_completed": AUDIT_CATEGORIES.AUTH_SECURITY,
  [USER_AUDIT_ACTIONS.USER_REGISTERED]: AUDIT_CATEGORIES.AUTH_SECURITY,
  [USER_AUDIT_ACTIONS.USER_LOGIN]: AUDIT_CATEGORIES.AUTH_SECURITY,
  [USER_AUDIT_ACTIONS.USER_LOGIN_FAILED]: AUDIT_CATEGORIES.AUTH_SECURITY,
  [USER_AUDIT_ACTIONS.USER_LOGOUT]: AUDIT_CATEGORIES.AUTH_SECURITY,
  [USER_AUDIT_ACTIONS.USER_SESSION_REVOKED]: AUDIT_CATEGORIES.AUTH_SECURITY,
  [USER_AUDIT_ACTIONS.USER_DEVICE_LINKED]: AUDIT_CATEGORIES.AUTH_SECURITY,
  [USER_AUDIT_ACTIONS.USER_PASSWORD_CHANGED]: AUDIT_CATEGORIES.AUTH_SECURITY,
  [USER_AUDIT_ACTIONS.USER_PASSWORD_RESET_REQUESTED]:
    AUDIT_CATEGORIES.AUTH_SECURITY,
  [USER_AUDIT_ACTIONS.USER_PASSWORD_RESET_COMPLETED]:
    AUDIT_CATEGORIES.AUTH_SECURITY,
  [USER_AUDIT_ACTIONS.USER_EMAIL_CHANGE_REQUESTED]:
    AUDIT_CATEGORIES.AUTH_SECURITY,
  [USER_AUDIT_ACTIONS.USER_EMAIL_CHANGE_CONFIRMED]:
    AUDIT_CATEGORIES.AUTH_SECURITY,
  [USER_AUDIT_ACTIONS.USER_SOCIAL_ACCOUNT_LINKED]:
    AUDIT_CATEGORIES.AUTH_SECURITY,
  [USER_AUDIT_ACTIONS.USER_SOCIAL_ACCOUNT_UNLINKED]:
    AUDIT_CATEGORIES.AUTH_SECURITY,
};

/** Every mandatory action, derived from the category map so the two cannot drift. */
export const MANDATORY_AUDIT_ACTIONS: readonly string[] = Object.keys(
  AUDIT_ACTION_CATEGORY
);

/** Actions belonging to one category — backs the `?category=` list filter. */
export function auditActionsForCategory(category: string): string[] {
  return MANDATORY_AUDIT_ACTIONS.filter(
    (action) => AUDIT_ACTION_CATEGORY[action] === category
  );
}

/** The category an action belongs to; null when it is not mandatory. */
export function auditCategoryOf(action: string): AuditCategory | null {
  return AUDIT_ACTION_CATEGORY[action] ?? null;
}

/** True when an action belongs in the default (mandatory-only) audit view. */
export function isMandatoryAuditAction(action: string): boolean {
  return action in AUDIT_ACTION_CATEGORY;
}
