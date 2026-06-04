/**
 * The 18-key permission catalogue (resource.action) and the per-key group.
 * Source of truth: docs/ADMIN-SERVICE-DESIGN.md §5.
 */
export const PERMISSION_CATALOGUE: { key: string; group: string }[] = [
  { key: "dashboard.read", group: "dashboard" },
  { key: "users.read", group: "users" },
  { key: "users.moderate", group: "users" },
  { key: "users.delete", group: "users" },
  { key: "reports.read", group: "reports" },
  { key: "reports.action", group: "reports" },
  { key: "communities.read", group: "communities" },
  { key: "communities.moderate", group: "communities" },
  { key: "groups.read", group: "groups" },
  { key: "groups.moderate", group: "groups" },
  { key: "livestreams.read", group: "livestreams" },
  { key: "livestreams.moderate", group: "livestreams" },
  { key: "categories.manage", group: "categories" },
  { key: "announcements.manage", group: "announcements" },
  { key: "auditlogs.read", group: "auditlogs" },
  { key: "systemhealth.read", group: "systemhealth" },
  { key: "admins.manage", group: "admins" },
  { key: "settings.manage", group: "settings" },
];
