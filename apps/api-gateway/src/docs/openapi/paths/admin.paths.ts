/**
 * Admin Panel (backoffice-service) OpenAPI paths.
 *
 * IMPORTANT — base-path handling:
 *   The admin surface is NOT under `/api/v1`; the gateway mounts it at `/admin`
 *   and proxies to backoffice `:3010/v1`. So every key here is the FULL path
 *   `/admin/v1/...` (no collision with the `/auth/*`, `/users/*` keys used by
 *   the public surface). A path-level `servers` override pointing at the gateway
 *   ROOT (not `{root}/api/v1`) is STAMPED at build time in `openapi-document.ts`
 *   for every key starting with `/admin/`, so Swagger resolves the URL as
 *   `{root}` + `/admin/v1/...`. Do not hardcode the host here.
 *
 * Source of truth: docs/BACKOFFICE-API-SPEC.md §4 (68 endpoints) +
 * docs/ADMIN-SERVICE-DESIGN.md §2 (request/response examples).
 *
 * Implementation status:
 *   - IMPLEMENTED today: §4.0 auth/me (except PATCH /me/password) and §4.12 health.
 *   - PLANNED: everything else. Marked with `**(Planned — not yet implemented)**`
 *     in the description and `"x-implementation-status": "planned"`.
 */

const adminTags = {
  authAccount: "Admin — Auth & Account",
  dashboard: "Admin — Dashboard",
  users: "Admin — User Management",
  communities: "Admin — Communities",
  groups: "Admin — Groups",
  reports: "Admin — Reports & Moderation",
  livestreams: "Admin — Livestreams",
  announcements: "Admin — Announcements",
  categories: "Admin — Categories",
  auditLogs: "Admin — Audit Logs",
  systemHealth: "Admin — System Health",
  adminAccounts: "Admin — Admin Accounts",
} as const;

const adminSecurity = [{ adminBearerAuth: [] }];

/** Standard list/query params: page, limit (max 100), sort, order, q. */
const listParams = [
  {
    name: "page",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1, default: 1 },
  },
  {
    name: "limit",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  },
  {
    name: "sort",
    in: "query",
    required: false,
    schema: { type: "string" },
    description: "Field to sort by.",
  },
  {
    name: "order",
    in: "query",
    required: false,
    schema: { type: "string", enum: ["asc", "desc"], default: "desc" },
  },
  {
    name: "q",
    in: "query",
    required: false,
    schema: { type: "string" },
    description: "Free-text search.",
  },
] as const;

const totpHeaderParam = {
  name: "X-Totp-Code",
  in: "header",
  required: true,
  schema: { type: "string" },
  description:
    "Step-up TOTP code (🔐). A fresh 6-digit TOTP is required to authorize this sensitive mutation.",
} as const;

const idPathParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
} as const;

/** AdminError response for a given status + description. */
function errRes(description: string) {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/AdminError" },
      },
    },
  };
}

/** 200/201 JSON response wrapping a single schema ref. */
function okRes(description: string, schemaRef: string) {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: schemaRef },
      },
    },
  };
}

/** 200 paginated list response whose `data[]` items are `itemRef`. */
function listRes(description: string, itemRef: string) {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            data: { type: "array", items: { $ref: itemRef } },
            pagination: { $ref: "#/components/schemas/AdminPagination" },
          },
          required: ["data", "pagination"],
        },
      },
    },
  };
}

function jsonBody(schemaRef: string, required = true) {
  return {
    required,
    content: {
      "application/json": { schema: { $ref: schemaRef } },
    },
  };
}

const PLANNED = "**(Planned — not yet implemented)** ";

export const adminPaths = {
  // ===========================================================================
  // §4.0 Auth & session  (IMPLEMENTED, except PATCH /me/password)
  // ===========================================================================
  "/admin/v1/auth/login": {
    post: {
      tags: [adminTags.authAccount],
      summary: "Admin login",
      description:
        "Public. Single-step admin login: verifies email + password and returns the admin JWT pair (access 8h, signed with `JWT_ADMIN_SECRET`; refresh 7d) plus the authenticated admin profile. Audited (login).",
      security: [],
      requestBody: jsonBody("#/components/schemas/AdminLoginRequest"),
      responses: {
        "200": okRes(
          "Admin JWT issued",
          "#/components/schemas/AdminTokenResponse"
        ),
        "400": errRes("Validation failed"),
        "401": errRes("Invalid credentials"),
        "429": errRes("Too many login attempts"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/auth/refresh": {
    post: {
      tags: [adminTags.authAccount],
      summary: "Rotate admin JWT",
      description:
        "Public (uses the refresh cookie). Rotates the admin access token (8h).",
      security: [],
      responses: {
        "200": okRes(
          "New admin JWT issued",
          "#/components/schemas/AdminTokenResponse"
        ),
        "401": errRes("Missing or invalid refresh token"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/auth/logout": {
    post: {
      tags: [adminTags.authAccount],
      summary: "Admin logout",
      description:
        "Blacklists the current token's `jti` in Redis. Audited. Requires a valid admin bearer.",
      security: adminSecurity,
      responses: {
        "200": okRes("Signed out", "#/components/schemas/AdminProfile"),
        "401": errRes("Missing or invalid admin token"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/auth/forgot-password": {
    post: {
      tags: [adminTags.authAccount],
      summary: "Admin forgot password — request OTP",
      description:
        "Public. Starts the admin password-reset flow: sends a 6-digit OTP to the admin's email. " +
        "The response is NEUTRAL — identical whether or not an account exists for the email (no " +
        "account enumeration). Rate-limited.",
      security: [],
      requestBody: jsonBody("#/components/schemas/AdminForgotPasswordRequest"),
      responses: {
        "200": okRes(
          "OTP requested (neutral)",
          "#/components/schemas/AdminForgotPasswordResponse"
        ),
        "400": errRes("Validation failed"),
        "429": errRes("Too many requests (rate limited)"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/auth/verify-otp": {
    post: {
      tags: [adminTags.authAccount],
      summary: "Admin verify password-reset OTP",
      description:
        "Public. Verifies the 6-digit OTP for the given email and, on success, returns a short-lived " +
        "single-use reset token used by POST /admin/v1/auth/reset-password.",
      security: [],
      requestBody: jsonBody("#/components/schemas/AdminVerifyOtpRequest"),
      responses: {
        "200": okRes(
          "OTP verified — reset token issued",
          "#/components/schemas/AdminVerifyOtpResponse"
        ),
        "400": errRes(
          "Invalid OTP (OTP_INVALID), too many attempts (OTP_MAX_ATTEMPTS), or validation failed"
        ),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/auth/resend-otp": {
    post: {
      tags: [adminTags.authAccount],
      summary: "Admin resend password-reset OTP",
      description:
        "Public. Resends the password-reset OTP for the given email. The response is NEUTRAL — " +
        "identical whether or not an account exists. Enforces a 60s cooldown (sliding window).",
      security: [],
      requestBody: jsonBody("#/components/schemas/AdminResendOtpRequest"),
      responses: {
        "200": okRes(
          "OTP resent (neutral)",
          "#/components/schemas/AdminResendOtpResponse"
        ),
        "400": errRes("Validation failed"),
        "429": errRes("Cooldown not elapsed (rate limited)"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/auth/reset-password": {
    post: {
      tags: [adminTags.authAccount],
      summary: "Admin reset password with reset token",
      description:
        "Public. Completes the reset flow: consumes the single-use reset token from /verify-otp and " +
        "sets a new password. `password` must be ≥12 chars with upper + lower + digit + special, and " +
        "match `confirmPassword`.",
      security: [],
      requestBody: jsonBody("#/components/schemas/AdminResetPasswordRequest"),
      responses: {
        "200": okRes(
          "Password reset",
          "#/components/schemas/AdminResetPasswordResponse"
        ),
        "400": errRes(
          "Invalid reset token (RESET_TOKEN_INVALID), expired token (RESET_TOKEN_EXPIRED), " +
            "new password same as current (PASSWORD_SAME_AS_CURRENT), or validation failed"
        ),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/me": {
    get: {
      tags: [adminTags.authAccount],
      summary: "Get current admin profile",
      description: "Returns the current admin profile + effective permissions.",
      security: adminSecurity,
      responses: {
        "200": okRes("Current admin", "#/components/schemas/AdminProfile"),
        "401": errRes("Missing or invalid admin token"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/me/password": {
    patch: {
      tags: [adminTags.authAccount],
      summary: "Change my password",
      description:
        PLANNED +
        "Self-service password change. 🔐 step-up TOTP required (`X-Totp-Code`). Audited.",
      security: adminSecurity,
      parameters: [totpHeaderParam],
      requestBody: jsonBody("#/components/schemas/AdminChangePasswordRequest"),
      responses: {
        "200": okRes("Password changed", "#/components/schemas/AdminProfile"),
        "400": errRes("Validation failed or same password"),
        "401": errRes("Wrong current password / invalid TOTP / missing token"),
      },
      "x-implementation-status": "planned",
    },
  },

  // ===========================================================================
  // §4.1 Dashboard  (PLANNED) — requires `dashboard.read`
  // ===========================================================================
  "/admin/v1/dashboard/stats": {
    get: {
      tags: [adminTags.dashboard],
      summary: "Full dashboard (cards + chart + donut + service status)",
      description:
        "The ENTIRE dashboard in one live gRPC-aggregated call. Returns four sections under `data`: `stats` (stat cards), `activeVsChurned` (chart, filtered by `?period=`), `communitiesGroups` (donut), and `serviceStatus` (health panel). User/active/banned counts come from auth-service, communities from community-service, groups from chat-service — each fetched once and reused across sections. `totalLivestreams`, `openReports`, and `churnedUsers` are STATIC stubs (0) flagged in `stats.stale`; any unreachable service degrades its field to 0 + a `stale` flag rather than failing the call. `activeVsChurned` is a REAL per-day series whose date range is driven by `?period=` (daily=today+15d=16 points, weekly=today+6d=7 points, monthly=1st-of-month→today), computed live from auth-service session activity; if auth-service is unreachable the series falls back to empty (flagged `stale.activeVsChurned`). Requires `dashboard.read`.",
      security: adminSecurity,
      parameters: [
        {
          name: "period",
          in: "query",
          required: false,
          description:
            "Drives the active-vs-churned per-day date range (UTC): `daily`=last 15 days (15 points), `weekly`=last 8 days (8 points), `monthly`=1st → last day of current month (future days = 0).",
          schema: {
            type: "string",
            enum: ["daily", "weekly", "monthly"],
            default: "monthly",
          },
        },
        {
          name: "from",
          in: "query",
          required: false,
          schema: { type: "string", format: "date" },
        },
        {
          name: "to",
          in: "query",
          required: false,
          schema: { type: "string", format: "date" },
        },
      ],
      responses: {
        "200": okRes("Full dashboard", "#/components/schemas/AdminDashboard"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing dashboard.read"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/dashboard/quick-links": {
    get: {
      tags: [adminTags.dashboard],
      summary: "Quick links counts",
      description:
        PLANNED +
        "Counts for the Quick Links panel (open reports, live livestreams). Optional — derivable from /dashboard/stats. Requires `dashboard.read`.",
      security: adminSecurity,
      responses: {
        "200": okRes(
          "Quick-link counts",
          "#/components/schemas/AdminQuickLinks"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing dashboard.read"),
      },
      "x-implementation-status": "planned",
    },
  },

  // ===========================================================================
  // §4.2 User Management  (PLANNED)
  // ===========================================================================
  "/admin/v1/users": {
    get: {
      tags: [adminTags.users],
      summary: "List / search users",
      description:
        PLANNED +
        "Aggregates `AdminListUsers` (auth-service) + `AdminListProfiles` (user-service) via gRPC-live. Filters: `status`, `banned`, `createdAfter`, `q`. Requires `users.read`.",
      security: adminSecurity,
      parameters: [
        ...listParams,
        {
          name: "status",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["active", "suspended", "banned", "pending_deletion"],
          },
        },
        {
          name: "banned",
          in: "query",
          required: false,
          schema: { type: "boolean" },
        },
        {
          name: "createdAfter",
          in: "query",
          required: false,
          schema: { type: "string", format: "date-time" },
        },
      ],
      responses: {
        "200": listRes("User list", "#/components/schemas/AdminUserListItem"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing users.read"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/users/{id}": {
    get: {
      tags: [adminTags.users],
      summary: "Get user detail",
      description:
        PLANNED +
        "Full profile: identity (auth) + profile/stats (user) + moderation history (admin_db `ModerationAction`). gRPC-live. Requires `users.read`.",
      security: adminSecurity,
      parameters: [idPathParam],
      responses: {
        "200": okRes("User detail", "#/components/schemas/AdminUserDetail"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing users.read"),
        "404": errRes("User not found"),
      },
      "x-implementation-status": "planned",
    },
    delete: {
      tags: [adminTags.users],
      summary: "Delete user (soft)",
      description:
        PLANNED +
        "Soft-delete request — auth/user services own actual deletion (event-driven). 🔐 step-up TOTP. Audited. Requires `users.delete`.",
      security: adminSecurity,
      parameters: [idPathParam, totpHeaderParam],
      responses: {
        "200": okRes(
          "Deletion requested",
          "#/components/schemas/AdminModerationResult"
        ),
        "401": errRes("Unauthorized / invalid TOTP"),
        "403": errRes("Missing users.delete"),
        "404": errRes("User not found"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/users/{id}/sessions": {
    get: {
      tags: [adminTags.users],
      summary: "List user device sessions",
      description:
        PLANNED +
        "Active device sessions via `AdminGetUserSessions` (gRPC-live). Requires `users.read`.",
      security: adminSecurity,
      parameters: [idPathParam],
      responses: {
        "200": listRes("Sessions", "#/components/schemas/AdminUserSession"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing users.read"),
        "404": errRes("User not found"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/users/{id}/reports": {
    get: {
      tags: [adminTags.users],
      summary: "List reports against a user",
      description:
        PLANNED +
        "Reports filed against this user (admin_db OWN). Requires `users.read`.",
      security: adminSecurity,
      parameters: [idPathParam, ...listParams],
      responses: {
        "200": listRes("Reports", "#/components/schemas/AdminReport"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing users.read"),
        "404": errRes("User not found"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/users/{id}/suspend": {
    post: {
      tags: [adminTags.users],
      summary: "Suspend a user",
      description:
        PLANNED +
        "Temp suspend (with `reason`, `until`). Writes `ModerationAction` and emits `admin.user_suspended`. 🔐 step-up TOTP. Audited. Requires `users.moderate`.",
      security: adminSecurity,
      parameters: [idPathParam, totpHeaderParam],
      requestBody: jsonBody("#/components/schemas/AdminSuspendRequest"),
      responses: {
        "200": okRes(
          "User suspended",
          "#/components/schemas/AdminModerationResult"
        ),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized / invalid TOTP"),
        "403": errRes("Missing users.moderate"),
        "404": errRes("User not found"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/users/{id}/ban": {
    post: {
      tags: [adminTags.users],
      summary: "Ban a user",
      description:
        PLANNED +
        "Writes `ModerationAction` and emits `admin.user_banned`; auth-service locks the account. 🔐 step-up TOTP. Audited. Requires `users.moderate`.",
      security: adminSecurity,
      parameters: [idPathParam, totpHeaderParam],
      requestBody: jsonBody("#/components/schemas/AdminBanRequest"),
      responses: {
        "200": okRes(
          "User banned",
          "#/components/schemas/AdminModerationResult"
        ),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized / invalid TOTP"),
        "403": errRes("Missing users.moderate"),
        "404": errRes("User not found"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/users/{id}/unban": {
    post: {
      tags: [adminTags.users],
      summary: "Unban a user",
      description:
        PLANNED +
        "Emits `admin.user_unbanned`. Audited. Requires `users.moderate`.",
      security: adminSecurity,
      parameters: [idPathParam],
      responses: {
        "200": okRes(
          "User unbanned",
          "#/components/schemas/AdminModerationResult"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing users.moderate"),
        "404": errRes("User not found"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/users/{id}/force-logout": {
    post: {
      tags: [adminTags.users],
      summary: "Force-logout a user",
      description:
        PLANNED +
        "Revoke all sessions (auth-service revokes via the published event). Audited. Requires `users.moderate`.",
      security: adminSecurity,
      parameters: [idPathParam],
      responses: {
        "200": okRes(
          "Sessions revoked",
          "#/components/schemas/AdminModerationResult"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing users.moderate"),
        "404": errRes("User not found"),
      },
      "x-implementation-status": "planned",
    },
  },

  // ===========================================================================
  // §4.3 Communities  (Community Management module — IMPLEMENTED, Phase 1 mock
  //      data behind the real contract; see docs/COMMUNITY-MANAGEMENT-API-SPEC.md.
  //      Phase 2 swaps MockCommunityRepository → gRPC-backed repo, no contract
  //      change. `communities.read` = list/detail; `communities.moderate` =
  //      close/reopen/bulk.)
  // ===========================================================================
  "/admin/v1/communities": {
    get: {
      tags: [adminTags.communities],
      summary: "List communities (community management table)",
      description:
        "**(Phase 1 — mock data behind the real contract)** Paginated, filtered communities list. " +
        "Filters: `search` (community name / admin name), `type`, `category` (slug or id), `status`, " +
        "`createdFrom`/`createdTo` (on createdAt, inclusive). Sort whitelist " +
        "`createdAt|name|memberCount|livestreamCount` with `:asc|:desc` (default `createdAt:desc`). " +
        "Offset pagination (`page`/`limit`). Response = `{ success, data[], pagination, meta }`. " +
        "Requires `communities.read`.",
      security: adminSecurity,
      parameters: [
        {
          name: "search",
          in: "query",
          required: false,
          schema: { type: "string", minLength: 1 },
          description:
            "Matches community name OR admin (owner) name (case-insensitive).",
        },
        {
          name: "type",
          in: "query",
          required: false,
          schema: { $ref: "#/components/schemas/AdminCommunityType" },
        },
        {
          name: "category",
          in: "query",
          required: false,
          schema: { type: "string", minLength: 1 },
          description: "Category slug OR id (resolved in the repo).",
        },
        {
          name: "status",
          in: "query",
          required: false,
          schema: {
            $ref: "#/components/schemas/AdminCommunityModerationStatus",
          },
        },
        {
          name: "createdFrom",
          in: "query",
          required: false,
          schema: { type: "string", format: "date" },
        },
        {
          name: "createdTo",
          in: "query",
          required: false,
          schema: { type: "string", format: "date" },
        },
        {
          name: "sort",
          in: "query",
          required: false,
          schema: {
            type: "string",
            pattern:
              "^(createdAt|name|memberCount|livestreamCount):(asc|desc)$",
            default: "createdAt:desc",
          },
        },
        {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, default: 1 },
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
      ],
      responses: {
        "200": okRes(
          "Communities page",
          "#/components/schemas/AdminCommunityListResponse"
        ),
        "400": errRes("Validation failed (bad sort/enum/date)"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing communities.read"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/communities/{communityId}": {
    get: {
      tags: [adminTags.communities],
      summary: "Get community detail",
      description:
        "**(Phase 1 — mock data behind the real contract)** Full community detail: core entity, owner " +
        "profile + account standing, member stats, livestream stats (nullable; `stale` until " +
        "stream-service gRPC), moderation history timeline, and settings summary. `partial` is true " +
        "when an upstream source could not be reached. Requires `communities.read`.",
      security: adminSecurity,
      parameters: [
        {
          name: "communityId",
          in: "path",
          required: true,
          schema: { type: "string", maxLength: 64 },
        },
      ],
      responses: {
        "200": okRes(
          "Community detail",
          "#/components/schemas/AdminCommunityDetailResponse"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing communities.read"),
        "404": errRes("Community not found"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/communities/{communityId}/close": {
    post: {
      tags: [adminTags.communities],
      summary: "Close a community",
      description:
        "**(Phase 1 — mock data behind the real contract)** Move a community to CLOSED with a " +
        "`reasonCode` (+ optional `reasonNote`, `notifyOwner`). Records a ModerationAction + AuditLog. " +
        "Requires `communities.moderate`.",
      security: adminSecurity,
      parameters: [
        {
          name: "communityId",
          in: "path",
          required: true,
          schema: { type: "string", maxLength: 64 },
        },
      ],
      requestBody: jsonBody("#/components/schemas/AdminCommunityCloseRequest"),
      responses: {
        "200": okRes(
          "Community closed",
          "#/components/schemas/AdminCommunityCloseResult"
        ),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing communities.moderate"),
        "404": errRes("Community not found"),
        "409": errRes("Community already closed"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/communities/{communityId}/reopen": {
    post: {
      tags: [adminTags.communities],
      summary: "Reopen a community",
      description:
        "**(Phase 1 — mock data behind the real contract)** Move a CLOSED community back to ACTIVE " +
        "(+ optional `reasonNote`, `notifyOwner`). Records a ModerationAction + AuditLog. " +
        "Requires `communities.moderate`.",
      security: adminSecurity,
      parameters: [
        {
          name: "communityId",
          in: "path",
          required: true,
          schema: { type: "string", maxLength: 64 },
        },
      ],
      requestBody: jsonBody(
        "#/components/schemas/AdminCommunityReopenRequest",
        false
      ),
      responses: {
        "200": okRes(
          "Community reopened",
          "#/components/schemas/AdminCommunityReopenResult"
        ),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing communities.moderate"),
        "404": errRes("Community not found"),
        "409": errRes("Community not closed"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/communities/bulk/close": {
    post: {
      tags: [adminTags.communities],
      summary: "Bulk close communities",
      description:
        "**(Phase 1 — mock data behind the real contract)** Close up to 100 communities in one call. " +
        "Returns **207 Multi-Status** with per-item outcome (partial success is normal). One " +
        "ModerationAction + AuditLog per succeeded item. Requires `communities.moderate`.",
      security: adminSecurity,
      requestBody: jsonBody(
        "#/components/schemas/AdminCommunityBulkCloseRequest"
      ),
      responses: {
        "207": okRes(
          "Per-item bulk outcome",
          "#/components/schemas/AdminCommunityBulkResult"
        ),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing communities.moderate"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/communities/bulk/reopen": {
    post: {
      tags: [adminTags.communities],
      summary: "Bulk reopen communities",
      description:
        "**(Phase 1 — mock data behind the real contract)** Reopen up to 100 communities in one call. " +
        "Returns **207 Multi-Status** with per-item outcome. One ModerationAction + AuditLog per " +
        "succeeded item. Requires `communities.moderate`.",
      security: adminSecurity,
      requestBody: jsonBody(
        "#/components/schemas/AdminCommunityBulkReopenRequest"
      ),
      responses: {
        "207": okRes(
          "Per-item bulk outcome",
          "#/components/schemas/AdminCommunityBulkResult"
        ),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing communities.moderate"),
      },
      "x-implementation-status": "implemented",
    },
  },

  // ===========================================================================
  // §4.4 Groups (= chat-service group rooms)  (PLANNED)
  // ===========================================================================
  "/admin/v1/groups": {
    get: {
      tags: [adminTags.groups],
      summary: "List groups",
      description:
        PLANNED +
        "Fast list from `GroupIndex` read-model → fallback gRPC `AdminListGroups` (chat-service). Requires `groups.read`.",
      security: adminSecurity,
      parameters: [...listParams],
      responses: {
        "200": listRes("Groups", "#/components/schemas/AdminGroup"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing groups.read"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/groups/{id}": {
    get: {
      tags: [adminTags.groups],
      summary: "Get group detail",
      description:
        PLANNED +
        "Full group detail (gRPC-live, chat-service). Requires `groups.read`.",
      security: adminSecurity,
      parameters: [idPathParam],
      responses: {
        "200": okRes("Group detail", "#/components/schemas/AdminGroup"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing groups.read"),
        "404": errRes("Group not found"),
      },
      "x-implementation-status": "planned",
    },
    delete: {
      tags: [adminTags.groups],
      summary: "Disband a group",
      description:
        PLANNED +
        "Disband (`disbandedAt`/`disbandedBy`) — event-driven. 🔐 step-up TOTP. Audited. Requires `groups.moderate`.",
      security: adminSecurity,
      parameters: [idPathParam, totpHeaderParam],
      responses: {
        "200": okRes(
          "Group disbanded",
          "#/components/schemas/AdminModerationResult"
        ),
        "401": errRes("Unauthorized / invalid TOTP"),
        "403": errRes("Missing groups.moderate"),
        "404": errRes("Group not found"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/groups/{id}/members": {
    get: {
      tags: [adminTags.groups],
      summary: "List group members",
      description:
        PLANNED +
        "Paginated members (gRPC-live, chat-service). Requires `groups.read`.",
      security: adminSecurity,
      parameters: [idPathParam, ...listParams],
      responses: {
        "200": listRes("Members", "#/components/schemas/AdminUserListItem"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing groups.read"),
        "404": errRes("Group not found"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/groups/{id}/suspend": {
    post: {
      tags: [adminTags.groups],
      summary: "Suspend a group",
      description:
        PLANNED + "🔐 step-up TOTP. Audited. Requires `groups.moderate`.",
      security: adminSecurity,
      parameters: [idPathParam, totpHeaderParam],
      requestBody: jsonBody("#/components/schemas/AdminModerateRequest"),
      responses: {
        "200": okRes(
          "Group suspended",
          "#/components/schemas/AdminModerationResult"
        ),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized / invalid TOTP"),
        "403": errRes("Missing groups.moderate"),
        "404": errRes("Group not found"),
      },
      "x-implementation-status": "planned",
    },
  },

  // ===========================================================================
  // §4.5 Reports & Moderation  (Phase 1 IMPLEMENTED — static/mock data behind
  //      the real contract; see docs/REPORTS-MODERATION-API-SPEC.md. Phase 2
  //      swaps MockReportRepository → PrismaReportRepository, no contract change.
  //      `reports.read` = list/detail; `reports.action` = resolve/dismiss/bulk.)
  // ===========================================================================
  "/admin/v1/reports": {
    get: {
      tags: [adminTags.reports],
      summary: "List reports (moderation table)",
      description:
        "**(Phase 1 — mock data behind the real contract)** Paginated moderation queue " +
        "(admin_db OWN). Hybrid pagination: offset by default (`page`/`limit`), opt-in keyset " +
        "(`cursor`). Filters: `search` (reportId / reported / reporter), `reportType` & `status` " +
        "(both repeatable → OR within, AND across), `targetType`, `assignedTo`, `dateFrom`/`dateTo` " +
        "(on createdAt). Sort whitelist `createdAt|status|reportType|priority|updatedAt` with " +
        "`:asc|:desc` (default `createdAt:desc`). Response = `{ data[], pagination, meta }`. " +
        "Requires `reports.read`.",
      security: adminSecurity,
      parameters: [
        {
          name: "search",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Matches reportId (exact/prefix), reported or reporter username/handle.",
        },
        {
          name: "reportType",
          in: "query",
          required: false,
          style: "form",
          explode: true,
          schema: {
            type: "array",
            items: { $ref: "#/components/schemas/AdminModerationReportType" },
          },
          description:
            "Repeatable. e.g. ?reportType=SPAM&reportType=HARASSMENT",
        },
        {
          name: "status",
          in: "query",
          required: false,
          style: "form",
          explode: true,
          schema: {
            type: "array",
            items: { $ref: "#/components/schemas/AdminModerationStatus" },
          },
          description: "Repeatable.",
        },
        {
          name: "targetType",
          in: "query",
          required: false,
          // Inline enum WITHOUT an example so Swagger "Try it out" leaves this
          // optional filter blank by default (don't default it to MESSAGE).
          schema: {
            type: "string",
            enum: [
              "USER",
              "MESSAGE",
              "GROUP",
              "COMMUNITY",
              "POST",
              "COMMENT",
              "MEDIA",
            ],
          },
        },
        {
          name: "assignedTo",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Admin id, `me`, or `unassigned`.",
        },
        {
          name: "dateFrom",
          in: "query",
          required: false,
          schema: { type: "string", format: "date" },
        },
        {
          name: "dateTo",
          in: "query",
          required: false,
          schema: { type: "string", format: "date" },
        },
        {
          name: "sort",
          in: "query",
          required: false,
          schema: {
            type: "string",
            pattern:
              "^(createdAt|status|reportType|priority|updatedAt):(asc|desc)$",
            default: "createdAt:desc",
          },
        },
        {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, default: 1 },
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
        {
          name: "cursor",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Opt-in keyset cursor (takes precedence over `page`). Encodes (createdAt, reportId).",
        },
      ],
      responses: {
        "200": okRes(
          "Reports page",
          "#/components/schemas/AdminModerationListResponse"
        ),
        "400": errRes("Validation failed (bad sort/enum/date)"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing reports.read"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/reports/{reportId}": {
    get: {
      tags: [adminTags.reports],
      summary: "Get report detail",
      description:
        "**(Phase 1 — mock data behind the real contract)** Full report detail for the View " +
        "Report Details drawer: enriched reported/reporter users (with moderation signals), the " +
        "reported target snapshot + deep link, typed `evidence[]` (media via signed short-TTL URLs; " +
        "restricted CSAM/illegal items access-logged), `history[]` timeline, `relatedReports[]`, and " +
        "`availableActions[]` (server-computed from status + RBAC). Requires `reports.read`.",
      security: adminSecurity,
      parameters: [
        {
          name: "reportId",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Public report id, e.g. RPT-2026-0001284.",
        },
      ],
      responses: {
        "200": okRes(
          "Report detail",
          "#/components/schemas/AdminModerationReportDetail"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing reports.read"),
        "404": errRes("Report not found"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/reports/bulk/resolve": {
    post: {
      tags: [adminTags.reports],
      summary: "Bulk resolve reports",
      description:
        "**(Phase 1 — mock data behind the real contract)** Resolve up to 100 reports in one call. " +
        "Returns **207 Multi-Status** with per-item outcome (partial success is normal). Idempotent " +
        "via `Idempotency-Key`. Requires `reports.action`.",
      security: adminSecurity,
      requestBody: jsonBody("#/components/schemas/AdminBulkResolveRequest"),
      responses: {
        "207": okRes(
          "Per-item bulk outcome",
          "#/components/schemas/AdminBulkActionResult"
        ),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing reports.action"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/reports/bulk/dismiss": {
    post: {
      tags: [adminTags.reports],
      summary: "Bulk dismiss reports",
      description:
        "**(Phase 1 — mock data behind the real contract)** Dismiss up to 100 reports in one call. " +
        "Returns **207 Multi-Status** with per-item outcome. Idempotent via `Idempotency-Key`. " +
        "Requires `reports.action`.",
      security: adminSecurity,
      requestBody: jsonBody("#/components/schemas/AdminBulkDismissRequest"),
      responses: {
        "207": okRes(
          "Per-item bulk outcome",
          "#/components/schemas/AdminBulkActionResult"
        ),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing reports.action"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/reports/{reportId}/resolve": {
    post: {
      tags: [adminTags.reports],
      summary: "Resolve a report",
      description:
        "**(Phase 1 — mock data behind the real contract)** Mark a report RESOLVED with a resolution " +
        "+ optional enforcement action. The enforcement (`SUSPEND_7D`, `BAN`, …) is recorded as a " +
        "decision and emitted as `moderation.action.requested` (RabbitMQ) — auth/user-service own " +
        "actual account state (bounded-context rule). Audited. Idempotent via `Idempotency-Key`. " +
        "Requires `reports.action`.",
      security: adminSecurity,
      parameters: [
        {
          name: "reportId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: jsonBody("#/components/schemas/AdminResolveReportRequest"),
      responses: {
        "200": okRes(
          "Report resolved",
          "#/components/schemas/AdminModerationActionResult"
        ),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing reports.action"),
        "404": errRes("Report not found"),
        "409": errRes("Report already resolved/dismissed"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/reports/{reportId}/dismiss": {
    post: {
      tags: [adminTags.reports],
      summary: "Dismiss a report",
      description:
        "**(Phase 1 — mock data behind the real contract)** Mark a report DISMISSED with a reason. " +
        "Optional `flagFalseReport` is captured in the audit trail (Phase 1: not yet persisted to a " +
        "reporter-reputation store). Audited. Idempotent via `Idempotency-Key`. Requires `reports.action`.",
      security: adminSecurity,
      parameters: [
        {
          name: "reportId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: jsonBody("#/components/schemas/AdminDismissReportRequest"),
      responses: {
        "200": okRes(
          "Report dismissed",
          "#/components/schemas/AdminModerationActionResult"
        ),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing reports.action"),
        "404": errRes("Report not found"),
        "409": errRes("Report already resolved/dismissed"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/reports/{reportId}/assign": {
    patch: {
      tags: [adminTags.reports],
      summary: "Assign a report",
      description:
        PLANNED +
        "Assign a report to an admin (one of `availableActions`). Audited. Requires `reports.action`.",
      security: adminSecurity,
      parameters: [
        {
          name: "reportId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: jsonBody("#/components/schemas/AdminReportAssignRequest"),
      responses: {
        "200": okRes(
          "Report assigned",
          "#/components/schemas/AdminModerationReportDetail"
        ),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing reports.action"),
        "404": errRes("Report not found"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/reports/{reportId}/notes": {
    post: {
      tags: [adminTags.reports],
      summary: "Add an internal note",
      description:
        PLANNED + "Internal note (`ReportNote`). Requires `reports.action`.",
      security: adminSecurity,
      parameters: [
        {
          name: "reportId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: jsonBody("#/components/schemas/AdminReportNoteRequest"),
      responses: {
        "201": okRes(
          "Note added",
          "#/components/schemas/AdminModerationReportDetail"
        ),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing reports.action"),
        "404": errRes("Report not found"),
      },
      "x-implementation-status": "planned",
    },
  },

  // ===========================================================================
  // §4.6 Livestreams  (PLANNED)
  // ===========================================================================
  "/admin/v1/livestreams": {
    get: {
      tags: [adminTags.livestreams],
      summary: "List livestreams",
      description:
        PLANNED +
        "From `StreamIndex` read-model (stubbed empty for now). Filter `status=live|ended|scheduled`. Requires `livestreams.read`.",
      security: adminSecurity,
      parameters: [
        ...listParams,
        {
          name: "status",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["live", "ended", "scheduled"] },
        },
      ],
      responses: {
        "200": listRes("Livestreams", "#/components/schemas/AdminLivestream"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing livestreams.read"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/livestreams/{id}": {
    get: {
      tags: [adminTags.livestreams],
      summary: "Get livestream detail",
      description:
        PLANNED +
        "Live detail: viewers, community, RTMP state (gRPC-live). Requires `livestreams.read`.",
      security: adminSecurity,
      parameters: [idPathParam],
      responses: {
        "200": okRes(
          "Livestream detail",
          "#/components/schemas/AdminLivestream"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing livestreams.read"),
        "404": errRes("Livestream not found"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/livestreams/{id}/force-end": {
    post: {
      tags: [adminTags.livestreams],
      summary: "Force-end a livestream",
      description:
        PLANNED +
        "gRPC `AdminForceEndStream` + emits `admin.stream_force_ended`. 🔐 step-up TOTP. Audited. Requires `livestreams.moderate`.",
      security: adminSecurity,
      parameters: [idPathParam, totpHeaderParam],
      requestBody: jsonBody("#/components/schemas/AdminForceEndRequest", false),
      responses: {
        "200": okRes(
          "Stream ended",
          "#/components/schemas/AdminModerationResult"
        ),
        "401": errRes("Unauthorized / invalid TOTP"),
        "403": errRes("Missing livestreams.moderate"),
        "404": errRes("Livestream not found"),
      },
      "x-implementation-status": "planned",
    },
  },

  // ===========================================================================
  // §4.7 Announcements  (PLANNED) — requires `announcements.manage`
  // ===========================================================================
  "/admin/v1/announcements": {
    get: {
      tags: [adminTags.announcements],
      summary: "List announcements",
      description:
        PLANNED +
        "List with status (draft/scheduled/published) (admin_db OWN). Requires `announcements.manage`.",
      security: adminSecurity,
      parameters: [...listParams],
      responses: {
        "200": listRes(
          "Announcements",
          "#/components/schemas/AdminAnnouncement"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing announcements.manage"),
      },
      "x-implementation-status": "planned",
    },
    post: {
      tags: [adminTags.announcements],
      summary: "Create an announcement",
      description:
        PLANNED +
        "Body has `translations: { en, vi }`, `audience`, `publishAt`. Audited. Requires `announcements.manage`.",
      security: adminSecurity,
      requestBody: jsonBody(
        "#/components/schemas/AdminAnnouncementCreateRequest"
      ),
      responses: {
        "201": okRes(
          "Announcement created",
          "#/components/schemas/AdminAnnouncement"
        ),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing announcements.manage"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/announcements/{id}": {
    get: {
      tags: [adminTags.announcements],
      summary: "Get an announcement",
      description:
        PLANNED +
        "Includes all translations (admin_db OWN). Requires `announcements.manage`.",
      security: adminSecurity,
      parameters: [idPathParam],
      responses: {
        "200": okRes("Announcement", "#/components/schemas/AdminAnnouncement"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing announcements.manage"),
        "404": errRes("Announcement not found"),
      },
      "x-implementation-status": "planned",
    },
    patch: {
      tags: [adminTags.announcements],
      summary: "Update an announcement",
      description: PLANNED + "Audited. Requires `announcements.manage`.",
      security: adminSecurity,
      parameters: [idPathParam],
      requestBody: jsonBody(
        "#/components/schemas/AdminAnnouncementUpdateRequest"
      ),
      responses: {
        "200": okRes(
          "Announcement updated",
          "#/components/schemas/AdminAnnouncement"
        ),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing announcements.manage"),
        "404": errRes("Announcement not found"),
      },
      "x-implementation-status": "planned",
    },
    delete: {
      tags: [adminTags.announcements],
      summary: "Delete an announcement",
      description: PLANNED + "Audited. Requires `announcements.manage`.",
      security: adminSecurity,
      parameters: [idPathParam],
      responses: {
        "200": okRes(
          "Announcement deleted",
          "#/components/schemas/AdminAnnouncement"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing announcements.manage"),
        "404": errRes("Announcement not found"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/announcements/{id}/publish": {
    post: {
      tags: [adminTags.announcements],
      summary: "Publish an announcement",
      description:
        PLANNED +
        "Emits `admin.announcement_published` → notifications-service fans out. Audited. Requires `announcements.manage`.",
      security: adminSecurity,
      parameters: [idPathParam],
      responses: {
        "200": okRes(
          "Announcement published",
          "#/components/schemas/AdminAnnouncement"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing announcements.manage"),
        "404": errRes("Announcement not found"),
      },
      "x-implementation-status": "planned",
    },
  },

  // ===========================================================================
  // §4.8 Categories  (PLANNED) — requires `categories.manage`
  // ===========================================================================
  "/admin/v1/categories": {
    get: {
      tags: [adminTags.categories],
      summary: "List categories",
      description:
        PLANNED +
        "Community categories (gRPC-live community-svc or admin_db OWN — ownership open question §6.2). Requires `categories.manage` (read uses the same perm group).",
      security: adminSecurity,
      parameters: [...listParams],
      responses: {
        "200": listRes("Categories", "#/components/schemas/AdminCategory"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing categories.manage"),
      },
      "x-implementation-status": "planned",
    },
    post: {
      tags: [adminTags.categories],
      summary: "Create a category",
      description:
        PLANNED +
        "i18n name (en/vi), icon, order. Audited. Requires `categories.manage`.",
      security: adminSecurity,
      requestBody: jsonBody("#/components/schemas/AdminCategoryCreateRequest"),
      responses: {
        "201": okRes("Category created", "#/components/schemas/AdminCategory"),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing categories.manage"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/categories/{id}": {
    patch: {
      tags: [adminTags.categories],
      summary: "Update a category",
      description: PLANNED + "Audited. Requires `categories.manage`.",
      security: adminSecurity,
      parameters: [idPathParam],
      requestBody: jsonBody("#/components/schemas/AdminCategoryUpdateRequest"),
      responses: {
        "200": okRes("Category updated", "#/components/schemas/AdminCategory"),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing categories.manage"),
        "404": errRes("Category not found"),
      },
      "x-implementation-status": "planned",
    },
    delete: {
      tags: [adminTags.categories],
      summary: "Delete a category",
      description:
        PLANNED +
        "Guard: blocked if the category is in use. 🔐 step-up TOTP. Audited. Requires `categories.manage`.",
      security: adminSecurity,
      parameters: [idPathParam, totpHeaderParam],
      responses: {
        "200": okRes("Category deleted", "#/components/schemas/AdminCategory"),
        "401": errRes("Unauthorized / invalid TOTP"),
        "403": errRes("Missing categories.manage"),
        "404": errRes("Category not found"),
        "409": errRes("Category in use"),
      },
      "x-implementation-status": "planned",
    },
  },

  // ===========================================================================
  // §4.9 Audit Logs  (PLANNED) — requires `auditlogs.read`
  // ===========================================================================
  "/admin/v1/audit-logs": {
    get: {
      tags: [adminTags.auditLogs],
      summary: "List audit logs",
      description:
        PLANNED +
        "Append-only table (admin_db OWN) — no mutations. Filters: `actorId`, `action`, `targetType`, `from`, `to`. Requires `auditlogs.read`.",
      security: adminSecurity,
      parameters: [
        ...listParams,
        {
          name: "actorId",
          in: "query",
          required: false,
          schema: { type: "string" },
        },
        {
          name: "action",
          in: "query",
          required: false,
          schema: { type: "string" },
        },
        {
          name: "targetType",
          in: "query",
          required: false,
          schema: { type: "string" },
        },
        {
          name: "from",
          in: "query",
          required: false,
          schema: { type: "string", format: "date-time" },
        },
        {
          name: "to",
          in: "query",
          required: false,
          schema: { type: "string", format: "date-time" },
        },
      ],
      responses: {
        "200": listRes("Audit logs", "#/components/schemas/AdminAuditLog"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing auditlogs.read"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/audit-logs/export": {
    get: {
      tags: [adminTags.auditLogs],
      summary: "Export audit logs",
      description:
        PLANNED +
        "CSV/JSON export (presigned MinIO for large exports — private bucket). Requires `auditlogs.read`.",
      security: adminSecurity,
      parameters: [
        {
          name: "format",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["csv", "json"], default: "csv" },
        },
        {
          name: "from",
          in: "query",
          required: false,
          schema: { type: "string", format: "date-time" },
        },
        {
          name: "to",
          in: "query",
          required: false,
          schema: { type: "string", format: "date-time" },
        },
      ],
      responses: {
        "200": okRes(
          "Export ready",
          "#/components/schemas/AdminAuditLogExport"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing auditlogs.read"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/audit-logs/{id}": {
    get: {
      tags: [adminTags.auditLogs],
      summary: "Get audit log detail",
      description:
        PLANNED + "Full diff detail (admin_db OWN). Requires `auditlogs.read`.",
      security: adminSecurity,
      parameters: [idPathParam],
      responses: {
        "200": okRes("Audit log", "#/components/schemas/AdminAuditLog"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing auditlogs.read"),
        "404": errRes("Audit log not found"),
      },
      "x-implementation-status": "planned",
    },
  },

  // ===========================================================================
  // §4.10 System Health  (PLANNED) — requires `systemhealth.read`
  // ===========================================================================
  "/admin/v1/system/health": {
    get: {
      tags: [adminTags.systemHealth],
      summary: "Per-service health",
      description:
        PLANNED +
        "Per-service status (Chat/Media/Livestream/Notification + auth/user/community). Probes gRPC health + circuit-breaker state (redis + gRPC-live). Requires `systemhealth.read`.",
      security: adminSecurity,
      responses: {
        "200": okRes(
          "Service health",
          "#/components/schemas/AdminServiceStatus"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing systemhealth.read"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/system/queues": {
    get: {
      tags: [adminTags.systemHealth],
      summary: "Queue depths",
      description:
        PLANNED +
        "RabbitMQ/Bull queue depths, DLQ counts (redis). Requires `systemhealth.read`.",
      security: adminSecurity,
      responses: {
        "200": okRes("Queue depths", "#/components/schemas/AdminSystemQueues"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing systemhealth.read"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/system/metrics": {
    get: {
      tags: [adminTags.systemHealth],
      summary: "Platform metrics snapshot",
      description:
        PLANNED +
        "Aggregate platform metrics snapshot (read-model + redis). Requires `systemhealth.read`.",
      security: adminSecurity,
      responses: {
        "200": okRes(
          "Metrics snapshot",
          "#/components/schemas/AdminSystemMetrics"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing systemhealth.read"),
      },
      "x-implementation-status": "planned",
    },
  },

  // ===========================================================================
  // §4.11 Admin Accounts  (PLANNED) — requires `admins.manage` (SUPER_ADMIN)
  // ===========================================================================
  "/admin/v1/admins": {
    get: {
      tags: [adminTags.adminAccounts],
      summary: "List admin accounts",
      description:
        PLANNED +
        "List admin accounts + roles (admin_db OWN). Requires `admins.manage` (SUPER_ADMIN only).",
      security: adminSecurity,
      parameters: [...listParams],
      responses: {
        "200": listRes("Admin accounts", "#/components/schemas/AdminAccount"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing admins.manage"),
      },
      "x-implementation-status": "planned",
    },
    post: {
      tags: [adminTags.adminAccounts],
      summary: "Create an admin account",
      description:
        PLANNED +
        "Create admin (invite + initial TOTP enrolment). 🔐 step-up TOTP. Audited. Requires `admins.manage` (SUPER_ADMIN only).",
      security: adminSecurity,
      parameters: [totpHeaderParam],
      requestBody: jsonBody("#/components/schemas/AdminAccountCreateRequest"),
      responses: {
        "201": okRes("Admin created", "#/components/schemas/AdminAccount"),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized / invalid TOTP"),
        "403": errRes("Missing admins.manage"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/admins/{id}": {
    get: {
      tags: [adminTags.adminAccounts],
      summary: "Get an admin account",
      description: PLANNED + "Requires `admins.manage` (SUPER_ADMIN only).",
      security: adminSecurity,
      parameters: [idPathParam],
      responses: {
        "200": okRes("Admin account", "#/components/schemas/AdminAccount"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing admins.manage"),
        "404": errRes("Admin not found"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/admins/{id}/role": {
    patch: {
      tags: [adminTags.adminAccounts],
      summary: "Change an admin's role",
      description:
        PLANNED +
        "Change role/permissions. 🔐 step-up TOTP. Audited. Requires `admins.manage` (SUPER_ADMIN only).",
      security: adminSecurity,
      parameters: [idPathParam, totpHeaderParam],
      requestBody: jsonBody("#/components/schemas/AdminAccountRoleRequest"),
      responses: {
        "200": okRes("Role changed", "#/components/schemas/AdminAccount"),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized / invalid TOTP"),
        "403": errRes("Missing admins.manage"),
        "404": errRes("Admin not found"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/admins/{id}/disable": {
    post: {
      tags: [adminTags.adminAccounts],
      summary: "Disable an admin account",
      description:
        PLANNED +
        "Deactivate. 🔐 step-up TOTP. Audited. Requires `admins.manage` (SUPER_ADMIN only).",
      security: adminSecurity,
      parameters: [idPathParam, totpHeaderParam],
      responses: {
        "200": okRes("Admin disabled", "#/components/schemas/AdminAccount"),
        "401": errRes("Unauthorized / invalid TOTP"),
        "403": errRes("Missing admins.manage"),
        "404": errRes("Admin not found"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/admins/{id}/reset-totp": {
    post: {
      tags: [adminTags.adminAccounts],
      summary: "Reset an admin's TOTP",
      description:
        PLANNED +
        "Force 2FA re-enrolment. 🔐 step-up TOTP. Audited. Requires `admins.manage` (SUPER_ADMIN only).",
      security: adminSecurity,
      parameters: [idPathParam, totpHeaderParam],
      responses: {
        "200": okRes("TOTP reset", "#/components/schemas/AdminAccount"),
        "401": errRes("Unauthorized / invalid TOTP"),
        "403": errRes("Missing admins.manage"),
        "404": errRes("Admin not found"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/roles": {
    get: {
      tags: [adminTags.adminAccounts],
      summary: "List roles",
      description:
        PLANNED +
        "List roles + permission sets (admin_db OWN). Requires `admins.manage` (SUPER_ADMIN only).",
      security: adminSecurity,
      responses: {
        "200": listRes("Roles", "#/components/schemas/AdminRole"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing admins.manage"),
      },
      "x-implementation-status": "planned",
    },
  },

  // ===========================================================================
  // §4.12 Health (infra — public to gateway/k8s)  (IMPLEMENTED)
  // ===========================================================================
  "/admin/v1/health": {
    get: {
      tags: [adminTags.systemHealth],
      summary: "Liveness probe",
      description: "Public. Liveness (no auth — gateway/k8s probe).",
      security: [],
      responses: {
        "200": {
          description: "Service is alive",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { status: { type: "string", example: "ok" } },
              },
            },
          },
        },
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/health/ready": {
    get: {
      tags: [adminTags.systemHealth],
      summary: "Readiness probe",
      description: "Public. Readiness (DB/Redis/RMQ reachable).",
      security: [],
      responses: {
        "200": {
          description: "Service is ready",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: { type: "string", example: "ready" },
                  checks: { type: "object" },
                },
              },
            },
          },
        },
        "503": {
          description: "A dependency is not reachable",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AdminError" },
            },
          },
        },
      },
      "x-implementation-status": "implemented",
    },
  },
} as const;
