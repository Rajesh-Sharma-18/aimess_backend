/**
 * Permission catalogue (resource.action) and the per-key group. Source of
 * truth: docs/ADMIN-SERVICE-DESIGN.md §5.
 *
 * Each user-facing module carries up to three keys:
 *   `<module>.read`       — enter module (sidebar + list)
 *   `<module>.view`       — open detail / conversation / player screens
 *   `<module>.moderate|action|manage` — destructive actions (ban, close, end…)
 *
 * Read-only modules (dashboard, auditlogs, systemhealth) carry `read` only;
 * management modules whose only detail IS the row (categories, announcements,
 * admins) skip the view key since there is nothing to view apart from the row.
 */
export const PERMISSION_CATALOGUE: { key: string; group: string }[] = [
  { key: "dashboard.read", group: "dashboard" },
  { key: "users.read", group: "users" },
  { key: "users.view", group: "users" },
  { key: "users.moderate", group: "users" },
  { key: "reports.read", group: "reports" },
  { key: "reports.view", group: "reports" },
  { key: "reports.action", group: "reports" },
  { key: "communities.read", group: "communities" },
  { key: "communities.view", group: "communities" },
  { key: "communities.moderate", group: "communities" },
  { key: "groups.read", group: "groups" },
  { key: "groups.view", group: "groups" },
  { key: "groups.moderate", group: "groups" },
  { key: "livestreams.read", group: "livestreams" },
  { key: "livestreams.view", group: "livestreams" },
  { key: "livestreams.moderate", group: "livestreams" },
  { key: "categories.read", group: "categories" },
  { key: "categories.manage", group: "categories" },
  { key: "announcements.read", group: "announcements" },
  { key: "announcements.manage", group: "announcements" },
  { key: "auditlogs.read", group: "auditlogs" },
  { key: "systemhealth.read", group: "systemhealth" },
  { key: "admins.read", group: "admins" },
  { key: "admins.manage", group: "admins" },
  { key: "settings.manage", group: "settings" },
];
