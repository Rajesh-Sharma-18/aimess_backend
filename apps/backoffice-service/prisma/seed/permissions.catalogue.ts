/**
 * The 20-key permission catalogue (resource.action) and the per-key group.
 * Source of truth: docs/ADMIN-SERVICE-DESIGN.md §5.
 *
 * Every module carries two keys: `<module>.read` gates route access and
 * `<module>.moderate|action|manage` gates the row/page actions. Read-only
 * modules (dashboard, auditlogs, systemhealth) have nothing to act on and
 * carry the read key alone.
 */
export const PERMISSION_CATALOGUE: { key: string; group: string }[] = [
  { key: "dashboard.read", group: "dashboard" },
  { key: "users.read", group: "users" },
  { key: "users.moderate", group: "users" },
  { key: "reports.read", group: "reports" },
  { key: "reports.action", group: "reports" },
  { key: "communities.read", group: "communities" },
  { key: "communities.moderate", group: "communities" },
  { key: "groups.read", group: "groups" },
  { key: "groups.moderate", group: "groups" },
  { key: "livestreams.read", group: "livestreams" },
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
