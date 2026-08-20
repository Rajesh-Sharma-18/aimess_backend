/**
 * Role → permission matrix. Source of truth: docs/ADMIN-SERVICE-DESIGN.md §5.
 * Keys must match permissions.catalogue.ts.
 */
export type RoleDefinition = {
  key: "SUPER_ADMIN" | "ADMIN" | "MODERATOR" | "SUPPORT_AGENT" | "ANALYST";
  name: string;
  description: string;
  permissions: string[];
};

const READ_BASELINE = [
  "dashboard.read",
  "users.read",
  "reports.read",
  "communities.read",
  "groups.read",
  "livestreams.read",
];

// Every read that has a paired `.view` (module with a detail/conversation
// screen). Support Agent and Analyst get this alongside READ_BASELINE so
// their existing "open a user/community/livestream" behavior is unchanged
// after view was split out of read.
const VIEW_BASELINE = [
  "users.view",
  "reports.view",
  "communities.view",
  "groups.view",
  "livestreams.view",
];

const ALL_PERMISSIONS = [
  ...READ_BASELINE,
  ...VIEW_BASELINE,
  "users.moderate",
  "reports.action",
  "communities.moderate",
  "groups.moderate",
  "livestreams.moderate",
  "categories.read",
  "categories.manage",
  "announcements.read",
  "announcements.manage",
  "auditlogs.read",
  "systemhealth.read",
  "admins.read",
  "admins.manage",
  "settings.manage",
];

export const ROLE_MATRIX: RoleDefinition[] = [
  {
    key: "SUPER_ADMIN",
    name: "Super Admin",
    description:
      "Everything incl. managing admins, settings, and role changes.",
    permissions: [...ALL_PERMISSIONS],
  },
  {
    key: "ADMIN",
    name: "Admin",
    description:
      "Full operations except managing other admins / global settings.",
    permissions: [
      ...READ_BASELINE,
      ...VIEW_BASELINE,
      "users.moderate",
      "reports.action",
      "communities.moderate",
      "groups.moderate",
      "livestreams.moderate",
      "categories.read",
      "categories.manage",
      "announcements.read",
      "announcements.manage",
      "auditlogs.read",
      "systemhealth.read",
      // Read-only roster: the Admin Accounts module is visible to every Admin,
      // Super Admin rows included. Acting on a row still needs `admins.manage`,
      // and a SUPER_ADMIN row is manageable only by another SUPER_ADMIN.
      "admins.read",
    ],
  },
  {
    key: "MODERATOR",
    name: "Moderator",
    description:
      "Acts on users/communities/groups/livestreams + works the report queue. No deletes, no config.",
    permissions: [
      ...READ_BASELINE,
      ...VIEW_BASELINE,
      "users.moderate",
      "reports.action",
      "communities.moderate",
      "groups.moderate",
      "livestreams.moderate",
    ],
  },
  {
    key: "SUPPORT_AGENT",
    name: "Support Agent",
    description:
      "Read-heavy: views users/communities/groups and triages reports; cannot moderate.",
    permissions: [...READ_BASELINE, ...VIEW_BASELINE, "systemhealth.read"],
  },
  {
    key: "ANALYST",
    name: "Analyst",
    description:
      "Pure read/analytics: dashboard, lists, audit logs, system health. No mutations.",
    permissions: [...READ_BASELINE, "auditlogs.read", "systemhealth.read"],
  },
];
