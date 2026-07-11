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
 *
 * Localization: every admin response `message` is localized (vi/en) via the
 * platform locale mechanism — send `x-lang` or `Accept-Language` to pick the
 * language (falls back to the default locale). The shared `LanguageHeader`
 * parameter is stamped onto every `/admin/` path item at build time in
 * `openapi-document.ts`, so it is NOT repeated per-operation here.
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

/** Group list params: page/limit + q, date range, and the whitelisted sort. */
const groupListParams = [
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
    name: "q",
    in: "query",
    required: false,
    schema: { type: "string" },
    description:
      "Case-insensitive search over group name, group id, admin username, and admin email.",
  },
  {
    name: "fromDate",
    in: "query",
    required: false,
    schema: { type: "string", format: "date" },
    description: "Created-on-or-after (inclusive). `YYYY-MM-DD`.",
  },
  {
    name: "toDate",
    in: "query",
    required: false,
    schema: { type: "string", format: "date" },
    description: "Created-on-or-before (inclusive, whole day). `YYYY-MM-DD`.",
  },
  {
    name: "sortBy",
    in: "query",
    required: false,
    schema: {
      type: "string",
      enum: ["createdAt", "memberCount"],
      default: "createdAt",
    },
  },
  {
    name: "sortOrder",
    in: "query",
    required: false,
    schema: { type: "string", enum: ["asc", "desc"], default: "desc" },
  },
] as const;

/** Group-members list params: page/limit + q + role filter. */
const groupMemberListParams = [
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
    name: "q",
    in: "query",
    required: false,
    schema: { type: "string" },
    description: "Case-insensitive search over username, user id, and email.",
  },
  {
    name: "role",
    in: "query",
    required: false,
    schema: {
      type: "string",
      enum: ["OWNER", "ADMIN", "MODERATOR", "MEMBER"],
    },
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

/**
 * 200 response for the group read endpoints, which return the
 * `{ success, message, data: { items, pagination } }` envelope (data.items +
 * hasNext/hasPrevious pagination) rather than the generic `{ data, pagination }`.
 */
function groupListRes(description: string, itemRef: string) {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            success: { type: "boolean", example: true },
            message: { type: "string", example: "Groups fetched successfully" },
            data: {
              type: "object",
              properties: {
                items: { type: "array", items: { $ref: itemRef } },
                pagination: {
                  $ref: "#/components/schemas/AdminGroupPagination",
                },
              },
              required: ["items", "pagination"],
            },
          },
          required: ["success", "message", "data"],
        },
      },
    },
  };
}

/** 200 single-object envelope `{ success, message, data: <schemaRef> }`. */
function groupOkRes(description: string, schemaRef: string) {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            success: { type: "boolean", example: true },
            message: {
              type: "string",
              example: "Group details fetched successfully",
            },
            data: { $ref: schemaRef },
          },
          required: ["success", "message", "data"],
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
      operationId: "adminLogin",
      summary: "Admin login",
      description:
        "Public. Single-step admin login: verifies email + password and returns the admin token pair (access 8h, compact JWT signed with `JWT_ADMIN_SECRET`; opaque refresh token, 7d) plus the authenticated admin profile. Audited (login).",
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
      operationId: "adminRefreshToken",
      summary: "Rotate admin JWT",
      description:
        "Public. Rotates the admin token pair from the opaque refresh token sent in the JSON body.",
      security: [],
      requestBody: jsonBody("#/components/schemas/AdminRefreshRequest"),
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
      operationId: "adminLogout",
      summary: "Admin logout",
      description:
        "Revokes the current admin session (by session id) in Redis + DB. Audited. Requires a valid admin bearer.",
      security: adminSecurity,
      responses: {
        "200": okRes("Signed out", "#/components/schemas/AdminLogoutResponse"),
        "401": errRes("Missing or invalid admin token"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/auth/forgot-password": {
    post: {
      tags: [adminTags.authAccount],
      operationId: "adminForgotPasswordRequest",
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
      operationId: "adminVerifyPasswordResetOtp",
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
      operationId: "adminResendPasswordResetOtp",
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
      operationId: "adminResetPassword",
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
      operationId: "getAdminProfile",
      summary: "Get current admin profile",
      description: "Returns the current admin profile + effective permissions.",
      security: adminSecurity,
      responses: {
        "200": okRes("Current admin", "#/components/schemas/AdminProfile"),
        "401": errRes("Missing or invalid admin token"),
      },
      "x-implementation-status": "implemented",
    },
    patch: {
      tags: [adminTags.authAccount],
      operationId: "updateAdminProfile",
      summary: "Update my profile (username, email, avatar)",
      description:
        "Self-service profile update for the My Account page. Accepts any " +
        "subset of `username`, `email`, `avatarObjectKey` (the object key from " +
        "the shared `/media/upload-url` USER_AVATAR flow; `null` clears the " +
        "avatar). Response mirrors GET /admin/v1/me. Audited.",
      security: adminSecurity,
      requestBody: jsonBody("#/components/schemas/AdminUpdateMeRequest"),
      responses: {
        "200": okRes("Profile updated", "#/components/schemas/AdminProfile"),
        "400": errRes("Validation failed"),
        "401": errRes("Missing or invalid admin token"),
        "409": errRes("Email already in use (ADMIN_EMAIL_TAKEN)"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/change-password": {
    patch: {
      tags: [adminTags.authAccount],
      operationId: "changeAdminPassword",
      summary: "Change my password",
      description:
        "Self-service password change. Verifies the current password, applies " +
        "the admin password policy to the new one (≥6 chars, upper + lower + " +
        "digit + special), and revokes every OTHER active session (the caller's " +
        "session stays alive). Audited.",
      security: adminSecurity,
      requestBody: jsonBody("#/components/schemas/AdminChangePasswordRequest"),
      responses: {
        "200": okRes(
          "Password changed",
          "#/components/schemas/AdminChangePasswordResponse"
        ),
        "400": errRes("Validation failed or same password"),
        "401": errRes("Wrong current password / missing token"),
      },
      "x-implementation-status": "implemented",
    },
  },

  // ===========================================================================
  // §4.1 Dashboard  (PLANNED) — requires `dashboard.read`
  // ===========================================================================
  "/admin/v1/dashboard/overview": {
    get: {
      tags: [adminTags.dashboard],
      operationId: "getDashboardStats",
      summary: "Dashboard stat cards",
      description:
        "Stat-card section only. Returns `{ stats }` aggregated live over gRPC: user/active/banned counts from auth-service, communities from community-service, groups from chat-service. `totalLivestreams`, `openReports`, and `churnedUsers` are STATIC stubs, always 0 — no backend source is wired for them yet. NOTE: there is no `stats.stale` field in the real response (an earlier version of this doc claimed one) — any unreachable upstream just silently degrades its own field to 0, with no stale flag exposed. Cached independently (10s). Requires `dashboard.read`.",
      security: adminSecurity,
      responses: {
        "200": okRes(
          "Dashboard overview",
          "#/components/schemas/AdminDashboardOverview"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing dashboard.read"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/dashboard/charts": {
    get: {
      tags: [adminTags.dashboard],
      summary:
        "Dashboard charts (active-vs-churned + communities/groups donut)",
      description:
        "Chart section. Returns `{ activeVsChurned, communitiesGroups }`. `activeVsChurned` is a REAL per-day series whose date range is driven by `?period=` (daily=last 15 days, weekly=last 8 days, monthly=1st-of-month→last day), computed live from auth-service session activity; if auth-service is unreachable the series falls back to an empty array (no stale flag is exposed). `communitiesGroups` is the donut (`communities` from community-service, `groups` from chat-service, plus their `total`). `from`/`to` are accepted for forward-compat only — the service currently IGNORES them entirely and derives the window purely from `period` (do not rely on them yet). Cached per-period (10s). Requires `dashboard.read`.",
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
          description:
            "Currently unused by the service (accepted for forward-compat only). Must be a full ISO-8601 DATETIME string if sent — the validator requires z.string().datetime(), NOT date-only, despite the schema type below.",
          schema: { type: "string", format: "date-time" },
        },
        {
          name: "to",
          in: "query",
          required: false,
          description: "Same caveats as `from`.",
          schema: { type: "string", format: "date-time" },
        },
      ],
      responses: {
        "200": okRes(
          "Dashboard charts",
          "#/components/schemas/AdminDashboardCharts"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing dashboard.read"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/dashboard/service-status": {
    get: {
      tags: [adminTags.dashboard],
      operationId: "getDashboardServiceStatus",
      summary: "Dashboard service-status panel",
      description:
        "Service-status section. Returns `{ serviceStatus }` — per-service health derived from the backoffice opossum circuit breakers (auth/community/chat report operational/degraded/down + breaker state; media/notification/livestream have no health probe wired yet and report `degraded` with a note). Cached briefly (10s). Requires `dashboard.read`.",
      security: adminSecurity,
      responses: {
        "200": okRes(
          "Dashboard service status",
          "#/components/schemas/AdminDashboardServiceStatusResponse"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing dashboard.read"),
      },
      "x-implementation-status": "implemented",
    },
  },

  // ===========================================================================
  // §4.2 User Management  (IMPLEMENTED, except sessions/delete/force-logout)
  // ===========================================================================
  "/admin/v1/users": {
    get: {
      tags: [adminTags.users],
      operationId: "adminListUsers",
      summary: "List / search users",
      description:
        "Aggregates `AdminListUsers` (auth-service) + `AdminListProfiles` (user-service) via gRPC-live. " +
        "Filters: `status` (repeatable, case-insensitive), `reports` bucket, a join-date range " +
        "(`dateFrom`/`dateTo`, or `createdAfter`/`createdBefore` aliases), and `q` search " +
        "(username/email). Sort via `sortBy` + `sortOrder` (default `joinedDate`/`desc`). " +
        "**Note:** `sortBy=reports` is DB-sorted on the read-model; in the live gRPC path it " +
        "falls back to join-date order — your `sortOrder` is still applied (report counts " +
        "live in admin_db only). Each row also carries `moderationStatus`/`isBanned` " +
        "(and `bannedAt`/`bannedBy`/`banReason` when banned) so the panel can pick the " +
        "Ban/Unban row action without a follow-up call. Requires `users.read`.",
      security: adminSecurity,
      parameters: [
        ...listParams,
        {
          name: "sortBy",
          in: "query",
          required: false,
          description:
            "Column to sort by. `joinedDate`→join date, `reports`→report count. " +
            "Case-insensitive; canonical column names (`joinedAt`, `reportCount`) are " +
            "also accepted as aliases. Default `joinedDate`. Takes precedence over the " +
            "legacy `sort`/`order` pair (kept for older callers / saved links).",
          schema: {
            type: "string",
            enum: ["username", "email", "joinedDate", "reports"],
            default: "joinedDate",
          },
        },
        {
          name: "sortOrder",
          in: "query",
          required: false,
          description: "Sort direction. Default `desc`.",
          schema: { type: "string", enum: ["asc", "desc"], default: "desc" },
        },
        {
          name: "status",
          in: "query",
          required: false,
          style: "form",
          explode: true,
          description:
            "Repeatable (`?status=ACTIVE&status=BANNED`). Case-insensitive; " +
            "`pending_deletion` is accepted as an alias for `DELETED`.",
          schema: {
            type: "array",
            items: {
              type: "string",
              enum: ["ACTIVE", "BANNED", "DELETED"],
            },
          },
        },
        {
          name: "reports",
          in: "query",
          required: false,
          description: "Report-count bucket filter.",
          schema: { type: "string", enum: ["none", "has", "gte_5", "gte_10"] },
        },
        {
          name: "dateFrom",
          in: "query",
          required: false,
          description:
            "Joined on/after (inclusive). `YYYY-MM-DD` or an ISO datetime. Alias: `createdAfter`.",
          schema: { type: "string", format: "date" },
        },
        {
          name: "dateTo",
          in: "query",
          required: false,
          description:
            "Joined on/before (inclusive, whole day, UTC). `YYYY-MM-DD` or an ISO datetime. Alias: `createdBefore`.",
          schema: { type: "string", format: "date" },
        },
      ],
      responses: {
        "200": listRes("User list", "#/components/schemas/AdminUserListItem"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing users.read"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/users/{id}": {
    get: {
      tags: [adminTags.users],
      operationId: "adminGetUser",
      summary: "Get user detail",
      description:
        "Full profile: identity (auth) + profile (user, incl. `fullName`) + report summary (admin_db). `accountStatus` also carries `moderationStatus`/`isBanned` alongside the existing `status`. `reportDetails` is the single source for report data on this screen — no `moderationHistory`/`stats`/`reportCategories`/flat `avatarUrl` fields. gRPC-live. Requires `users.read`.",
      security: adminSecurity,
      parameters: [idPathParam],
      responses: {
        "200": okRes("User detail", "#/components/schemas/AdminUserDetail"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing users.read"),
        "404": errRes("User not found"),
      },
      "x-implementation-status": "implemented",
    },
    delete: {
      tags: [adminTags.users],
      operationId: "adminDeleteUser",
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
      operationId: "adminListUserSessions",
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
      operationId: "adminListUserReports",
      summary: "List reports against a user",
      description:
        PLANNED +
        "Reports filed against this user (admin_db OWN). Requires `users.read`.",
      security: adminSecurity,
      parameters: [idPathParam, ...listParams],
      responses: {
        "200": listRes("Reports", "#/components/schemas/AdminUserReport"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing users.read"),
        "404": errRes("User not found"),
      },
      "x-implementation-status": "planned",
    },
  },
  "/admin/v1/users/{userId}/communities": {
    get: {
      tags: [adminTags.users],
      operationId: "adminListUserCommunities",
      summary: "List the user's communities",
      description:
        "The 'Communities' grid on the User Management detail screen — the " +
        "communities the user is an ACTIVE member of (community-service gRPC; " +
        "avatar already presigned). Supports `q`/`search` (community name OR " +
        "exact communityId) and the sort pair `sortBy` " +
        "(`name`|`members`|`createdDate`) / `sortOrder` (default " +
        "`createdDate`/`desc`). Offset pagination. Response = " +
        "`{ success, data: { items, pagination } }`. Requires `users.read`.",
      security: adminSecurity,
      parameters: [
        {
          name: "userId",
          in: "path",
          required: true,
          schema: { type: "string", maxLength: 64 },
        },
        {
          name: "q",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Community name (contains) OR exact communityId.",
        },
        {
          name: "search",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Alias of `q` (q wins when both are present).",
        },
        {
          name: "sortBy",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["name", "members", "createdDate"],
            default: "createdDate",
          },
        },
        {
          name: "sortOrder",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["asc", "desc"], default: "desc" },
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
          "User communities page",
          "#/components/schemas/AdminUserCommunityListResponse"
        ),
        "400": errRes("Validation failed (bad sort/enum)"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing users.read"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/users/{userId}/communities/{communityId}/members": {
    get: {
      tags: [adminTags.users],
      operationId: "adminListUserCommunityPeers",
      summary: "List the OTHER members of a community the user belongs to",
      description:
        "The co-member grid on the User Management detail screen — the other " +
        "members of `communityId` (community-service gRPC). The viewed user " +
        "(`userId`) is excluded at the DB level and NEVER appears. Supports " +
        "`q`/`search` (username, userId, OR email — an email is resolved to a " +
        "userId via auth-service), a `role` filter (incl. `OWNER`, folded onto " +
        "`ADMIN`), and the sort pair `sortBy` (`username`|`joinedDate`) / " +
        "`sortOrder`. Each member's email is hydrated from auth-service in one " +
        "batch call (null when unavailable). The `community` block " +
        "(`name`/`memberCount`) is fetched via a single adminGetCommunity read. " +
        "Response = `{ success, data: { community, items, pagination } }`. " +
        "Requires `users.read`.",
      security: adminSecurity,
      parameters: [
        {
          name: "userId",
          in: "path",
          required: true,
          schema: { type: "string", maxLength: 64 },
        },
        {
          name: "communityId",
          in: "path",
          required: true,
          schema: { type: "string", maxLength: 64 },
        },
        {
          name: "q",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Username, userId, OR email (an `@` routes to email lookup).",
        },
        {
          name: "search",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Alias of `q` (q wins when both are present).",
        },
        {
          name: "role",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["OWNER", "ADMIN", "MODERATOR", "MEMBER"],
          },
          description: "Member role filter (OWNER is folded onto ADMIN).",
        },
        {
          name: "sortBy",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["username", "joinedDate"] },
        },
        {
          name: "sortOrder",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["asc", "desc"] },
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
          "Co-member page",
          "#/components/schemas/AdminOtherCommunityMembersResponse"
        ),
        "400": errRes("Validation failed (bad sort/enum)"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing users.read"),
        "404": errRes("Community not found"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/users/{userId}/suspend": {
    post: {
      tags: [adminTags.users],
      operationId: "adminSuspendUser",
      summary: "Suspend a user (time-boxed, durationDays required)",
      description:
        "Sets status SUSPENDED with suspendedUntil = now + durationDays (durationDays is REQUIRED here, unlike ban). Writes a ModerationAction + AuditLog and fire-and-forgets admin.user_suspended (RabbitMQ admin.user.queue; consumed by auth-service). Requires users.moderate. TOTP step-up is a planned Phase-2 addition, NOT enforced today.",
      security: adminSecurity,
      parameters: [{ ...idPathParam, name: "userId" }],
      requestBody: jsonBody("#/components/schemas/AdminSuspendRequest"),
      responses: {
        "200": okRes(
          "User suspended",
          "#/components/schemas/AdminModerationResult"
        ),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing users.moderate"),
        "404": errRes("User not found"),
        "409": errRes("USER_ALREADY_BANNED — current status is already BANNED"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/users/{userId}/ban": {
    post: {
      tags: [adminTags.users],
      operationId: "adminBanUser",
      summary: "Ban a user (permanent, or time-boxed via durationDays)",
      description:
        "If durationDays is omitted/null this is a PERMANENT ban (status BANNED); if durationDays > 0 it is treated as a time-boxed suspend instead (status SUSPENDED). `reason` accepts either a predefined code (AdminUserBanReasonCode) or any custom free-text reason (max 200 chars) — whichever is sent is persisted verbatim into banReason/ModerationAction/AuditLog and threaded unchanged into the published admin.user_banned/admin.user_suspended event. Writes a ModerationAction + AuditLog and fire-and-forgets admin.user_banned/admin.user_suspended (RabbitMQ admin.user.queue). No Socket.IO/real-time session kill is emitted by this service — forceLogout is threaded into the published event only. Requires users.moderate. TOTP step-up is a planned Phase-2 addition, NOT enforced today.",
      security: adminSecurity,
      parameters: [{ ...idPathParam, name: "userId" }],
      requestBody: jsonBody("#/components/schemas/AdminBanRequest"),
      responses: {
        "200": okRes(
          "User banned",
          "#/components/schemas/AdminModerationResult"
        ),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing users.moderate"),
        "404": errRes("User not found"),
        "409": errRes("USER_ALREADY_BANNED or USER_DELETED"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/users/{userId}/unban": {
    post: {
      tags: [adminTags.users],
      operationId: "adminUnbanUser",
      summary: "Unban / reinstate a user",
      description:
        "Sets status ACTIVE, clears bannedAt/suspendedUntil/banReason. Writes a ModerationAction + AuditLog and fire-and-forgets admin.user_unbanned. Requires users.moderate.",
      security: adminSecurity,
      parameters: [{ ...idPathParam, name: "userId" }],
      requestBody: jsonBody("#/components/schemas/AdminUnbanRequest", false),
      responses: {
        "200": okRes(
          "User unbanned",
          "#/components/schemas/AdminModerationResult"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing users.moderate"),
        "404": errRes("User not found"),
        "409": errRes("USER_NOT_BANNED or USER_DELETED"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/users/{userId}/activate": {
    post: {
      tags: [adminTags.users],
      operationId: "adminActivateUser",
      summary: "Activate / reinstate a user (alias of /unban)",
      description:
        "Identical to POST /admin/v1/users/{userId}/unban — same validator, controller, and service call, just an alternate path for callers that use an 'activate' verb. Sets status ACTIVE, clears bannedAt/suspendedUntil/banReason. Writes a ModerationAction + AuditLog and fire-and-forgets admin.user_unbanned. Requires users.moderate.",
      security: adminSecurity,
      parameters: [{ ...idPathParam, name: "userId" }],
      requestBody: jsonBody("#/components/schemas/AdminUnbanRequest", false),
      responses: {
        "200": okRes(
          "User activated",
          "#/components/schemas/AdminModerationResult"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing users.moderate"),
        "404": errRes("User not found"),
        "409": errRes("USER_NOT_BANNED or USER_DELETED"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/users/{userId}/details": {
    get: {
      tags: [adminTags.users],
      operationId: "adminGetUserDetails",
      summary: "Get user detail (alias of GET /admin/v1/users/{userId})",
      description:
        "Identical to GET /admin/v1/users/{userId} — community-less user detail: profile (incl. `fullName`) + `reportDetails` report summary. Does NOT include a community/members block (a user can belong to multiple communities, so there is no single implicit one to pick); use GET /admin/v1/users/{userId}/communities and GET /admin/v1/users/{userId}/communities/{communityId}/members when a specific community context is needed. Requires users.read.",
      security: adminSecurity,
      parameters: [{ ...idPathParam, name: "userId" }],
      responses: {
        "200": okRes("User detail", "#/components/schemas/AdminUserDetail"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing users.read"),
        "404": errRes("User not found"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/users/ban-reasons": {
    get: {
      tags: [adminTags.users],
      operationId: "adminListBanReasons",
      summary: "List predefined ban/suspend reason codes",
      description:
        "Static reference data for the ban/suspend modal's reason dropdown — the same `AdminUserBanReasonCode` codes accepted by ban/suspend/bulk-ban. The admin can also type any custom free-text reason instead (max 200 chars); this list is a convenience preset, not an exhaustive constraint. Requires users.read.",
      security: adminSecurity,
      responses: {
        "200": {
          description: "Predefined reason codes",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  data: {
                    type: "array",
                    items: {
                      $ref: "#/components/schemas/AdminUserBanReasonCode",
                    },
                  },
                },
                required: ["success", "data"],
              },
            },
          },
        },
        "401": errRes("Unauthorized"),
        "403": errRes("Missing users.read"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/users/bulk/ban": {
    post: {
      tags: [adminTags.users],
      operationId: "adminBulkBanUsers",
      summary: "Bulk ban/suspend users (max 100)",
      description:
        "Applies the same rules as single ban/suspend to up to 100 users in one call, including custom free-text `reason` support. Returns 207 Multi-Status. Writes ONE ModerationAction + ONE AuditLog (user.bulk_banned) + publishes ONE admin.user_banned/admin.user_suspended event PER succeeded user. Requires users.moderate.",
      security: adminSecurity,
      requestBody: jsonBody("#/components/schemas/AdminBulkBanRequest"),
      responses: {
        "207": okRes("Bulk result", "#/components/schemas/AdminBulkResult"),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing users.moderate"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/users/bulk/activate": {
    post: {
      tags: [adminTags.users],
      operationId: "adminBulkActivateUsers",
      summary: "Bulk reinstate/activate users (max 100)",
      description:
        "Applies the same rules as single unban to up to 100 users in one call. Returns 207 Multi-Status. Already-ACTIVE users are idempotently reported as succeeded but write no audit row and publish no event. Requires users.moderate.",
      security: adminSecurity,
      requestBody: jsonBody("#/components/schemas/AdminBulkActivateRequest"),
      responses: {
        "207": okRes("Bulk result", "#/components/schemas/AdminBulkResult"),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing users.moderate"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/users/{id}/force-logout": {
    post: {
      tags: [adminTags.users],
      operationId: "adminForceLogoutUser",
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
  // §4.3 Communities  (Community Management module — IMPLEMENTED, live gRPC to
  //      community-service via GrpcCommunityRepository; see
  //      docs/COMMUNITY-MANAGEMENT-API-SPEC.md. A MockCommunityRepository still
  //      exists in source for offline/demo use but is NOT the active
  //      implementation — do not describe this module as mock data.
  //      `communities.read` = list/detail; `communities.moderate` =
  //      close/reopen/bulk.)
  // ===========================================================================
  "/admin/v1/communities": {
    get: {
      tags: [adminTags.communities],
      operationId: "adminListCommunities",
      summary: "List communities (community management table)",
      description:
        "Paginated, filtered communities list (live gRPC). " +
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
      operationId: "adminGetCommunity",
      summary: "Get community detail",
      description:
        "Full community detail (live gRPC): core entity, owner " +
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
  "/admin/v1/communities/{communityId}/members": {
    get: {
      tags: [adminTags.communities],
      operationId: "adminListCommunityMembers",
      summary: "List community members",
      description:
        "Paginated member roster for a community (community-service gRPC, " +
        "denormalized snapshot fields — no user-service round-trip). Supports " +
        "`q`/`search` (username, display name, or exact userId), a `role` " +
        "filter, and `sort` (applied at the DB query level). Requires `communities.read`.",
      security: adminSecurity,
      parameters: [
        {
          name: "communityId",
          in: "path",
          required: true,
          schema: { type: "string", maxLength: 64 },
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
          name: "q",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Search by username, display name, or exact userId.",
        },
        {
          name: "role",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["ADMIN", "MODERATOR", "MEMBER"],
          },
          description: "Filter by member role (the 'Select Type' filter).",
        },
        {
          name: "sort",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: [
              "username:asc",
              "username:desc",
              "handle:asc",
              "handle:desc",
              "joinedAt:asc",
              "joinedAt:desc",
            ],
            default: "joinedAt:desc",
          },
          description:
            "`<field>:<order>` — sortable on `username` (display name), " +
            "`handle` (@handle), or `joinedAt`. An invalid or omitted value " +
            "falls back to `joinedAt:desc`.",
        },
      ],
      responses: {
        "200": listRes(
          "Community members",
          "#/components/schemas/AdminCommunityMember"
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
      operationId: "adminCloseCommunity",
      summary: "Close a community",
      description:
        "Move a community to CLOSED with a " +
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
      operationId: "adminReopenCommunity",
      summary: "Reopen a community",
      description:
        "Move a CLOSED community back to ACTIVE " +
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
      operationId: "adminBulkCloseCommunities",
      summary: "Bulk close communities",
      description:
        "Close up to 100 communities in one call. " +
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
      operationId: "adminBulkReopenCommunities",
      summary: "Bulk reopen communities",
      description:
        "Reopen up to 100 communities in one call. " +
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
      operationId: "adminListGroups",
      summary: "List groups",
      description:
        "Paginated, searchable, sortable list of chat-service groups (gRPC-live `AdminListGroups`). Search matches group name, group id, admin username, and admin email; sortable by `createdAt` or `memberCount`; filterable by created-date range. Requires `groups.read`.",
      security: adminSecurity,
      parameters: [...groupListParams],
      responses: {
        "200": groupListRes("Groups", "#/components/schemas/AdminGroup"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing groups.read"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/groups/{id}": {
    get: {
      tags: [adminTags.groups],
      operationId: "adminGetGroup",
      summary: "Get group detail",
      description:
        "Full group detail (gRPC-live, chat-service). Requires `groups.read`.",
      security: adminSecurity,
      parameters: [idPathParam],
      responses: {
        "200": groupOkRes("Group detail", "#/components/schemas/AdminGroup"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing groups.read"),
        "404": errRes("Group not found"),
      },
      "x-implementation-status": "implemented",
    },
    delete: {
      tags: [adminTags.groups],
      operationId: "adminDisbandGroup",
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
      operationId: "adminListGroupMembers",
      summary: "List group members",
      description:
        "Paginated, searchable members (gRPC-live, chat-service). Search matches username, user id, and email; filterable by role (OWNER/ADMIN/MODERATOR/MEMBER). Requires `groups.read`.",
      security: adminSecurity,
      parameters: [idPathParam, ...groupMemberListParams],
      responses: {
        "200": groupListRes("Members", "#/components/schemas/AdminGroupMember"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing groups.read"),
        "404": errRes("Group not found"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/groups/{id}/suspend": {
    post: {
      tags: [adminTags.groups],
      operationId: "adminSuspendGroup",
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
      operationId: "adminListReports",
      summary: "List reports (moderation table)",
      description:
        "**(Phase 1 — mock data behind the real contract)** Paginated moderation queue " +
        "(admin_db OWN). Hybrid pagination: offset by default (`page`/`limit`), opt-in keyset " +
        "(`cursor`). Filters: `search` (reportId / reported / reporter / community name), " +
        "`reportType` & `status` (both repeatable → OR within, AND across), `targetType`, " +
        "`assignedTo`, `communityId` (exact), `communityName` (contains, case-insensitive), " +
        "`dateFrom`/`dateTo` (on createdAt). `communityName` is denormalized onto the report row " +
        "at ingest time, so filtering/searching/sorting by it is a plain indexed DB query — no " +
        "per-request cross-service join. Sort whitelist " +
        "`createdAt|status|reportType|priority|updatedAt|communityName` with `:asc|:desc` " +
        "(default `createdAt:desc`), applied at the database level. Response = " +
        "`{ data[], pagination, meta }`. Requires `reports.read`.",
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
          name: "communityId",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Exact match on the community the report was filed in.",
        },
        {
          name: "communityName",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Contains, case-insensitive match on community name.",
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
              "^(createdAt|status|reportType|priority|updatedAt|communityName):(asc|desc)$",
            default: "createdAt:desc",
          },
          description:
            "e.g. `?sort=communityName:asc` or `?sort=communityName:desc`. Sorted at the database level.",
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
      operationId: "adminGetReport",
      summary: "Get Reports & Moderation Details",
      description:
        "Aggregate for the admin Reports & Moderation Details page, composed in one call. " +
        "`reportType` identifies the reported entity and drives which blocks are returned: " +
        "`USER` → `reportedUser`; `COMMUNITY` (a reported community member) → " +
        "`reportedUser`/`community`/`communityAdmin`; `LIVESTREAM` → additionally `livestream`; " +
        "`MESSAGE` (a reported community message) → additionally `message`. A community is " +
        "never itself reportable. User objects (`reporter`/`reportedUser`/`communityAdmin`/" +
        "`livestream.host`) are the standard `{id,fullName,username,avatar}` shape; `avatar` is " +
        "the standard media object. `message` content/media are best-effort `null` until an " +
        "admin message-content RPC exists in chat-service. All timestamps are epoch " +
        "milliseconds. Requires `reports.read`.",
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
          "Reports & Moderation Details",
          "#/components/schemas/AdminReportModerationDetail"
        ),
        "400": errRes("Validation failed (bad reportId)"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing reports.read"),
        "404": errRes("Report not found"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/reports/{reportId}/evidence": {
    get: {
      tags: [adminTags.reports],
      operationId: "adminListReportEvidence",
      summary: "List report evidence",
      description:
        "**(Phase 1 — mock data behind the real contract)** Paginated list of evidence items " +
        "attached to this report (media snapshots, screenshots, system logs, etc.). " +
        "Requires `reports.read`.",
      security: adminSecurity,
      parameters: [
        {
          name: "reportId",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Public report id, e.g. RPT-2026-0001284.",
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
        "200": listRes(
          "Evidence items",
          "#/components/schemas/AdminModerationEvidence"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing reports.read"),
        "404": errRes("Report not found"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/reports/{reportId}/history": {
    get: {
      tags: [adminTags.reports],
      operationId: "adminListReportHistory",
      summary: "List report action history",
      description:
        "**(Phase 1 — mock data behind the real contract)** Paginated action/event history " +
        "timeline for this report (admin actions, status changes, notes). " +
        "Requires `reports.read`.",
      security: adminSecurity,
      parameters: [
        {
          name: "reportId",
          in: "path",
          required: true,
          schema: { type: "string" },
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
        "200": listRes(
          "History items",
          "#/components/schemas/AdminModerationHistoryItem"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing reports.read"),
        "404": errRes("Report not found"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/reports/{reportId}/related": {
    get: {
      tags: [adminTags.reports],
      operationId: "adminListRelatedReports",
      summary: "List related reports",
      description:
        "**(Phase 1 — mock data behind the real contract)** Paginated list of reports " +
        "related to this one (same reported user or target). Requires `reports.read`.",
      security: adminSecurity,
      parameters: [
        {
          name: "reportId",
          in: "path",
          required: true,
          schema: { type: "string" },
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
        "200": listRes(
          "Related reports",
          "#/components/schemas/AdminModerationRelatedReport"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing reports.read"),
        "404": errRes("Report not found"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/reports/{reportId}/users": {
    get: {
      tags: [adminTags.reports],
      operationId: "adminListReportUsers",
      summary: "List Report Details users",
      description:
        "Paginated users list shown at the bottom of the Report Details page. " +
        "ONE endpoint serving both report kinds — the report's `reportType` " +
        "selects the source: `COMMUNITY`/`MESSAGE` reports return the reported " +
        "community's members (via the community-members read path); `LIVESTREAM` " +
        "reports return the stream's actual viewer sessions. A plain `USER` " +
        "report (no community/stream context) returns an empty page. Every row " +
        "is the unified `{userId,username,displayName,avatar,role,joinedAt}` shape " +
        "(`avatar` is the standard media object; `joinedAt` is epoch ms). " +
        "`search` (username / display name / user id — case-insensitive, partial, " +
        "trimmed, empty ignored), `role` filter and `sortBy` " +
        "(`username`|`joinedAt`|`role`, with `sortOrder` asc/desc) work for BOTH " +
        "report kinds. COMMUNITY `role` values are `ADMIN`|`MODERATOR`|`MEMBER` " +
        "(`BANNED` surfaces on rows but is not a filter); LIVESTREAM has no " +
        "participant-role model, so a viewer's `role` is their community role " +
        "(`Admin`|`Moderator`|`Member`) and that is what `role`/`sortBy=role` " +
        "operate on (livestream search/filter/sort run over a bounded candidate " +
        "set). Unknown/invalid `role` values are ignored. Requires `reports.read`.",
      security: adminSecurity,
      parameters: [
        {
          name: "reportId",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Public report id, e.g. RPT-2026-0001284.",
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
          name: "search",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Matches username, display name or user id (COMMUNITY reports).",
        },
        {
          name: "role",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Community role filter — ADMIN|MODERATOR|MEMBER (BANNED/other values ignored; not applied to LIVESTREAM reports).",
        },
        {
          name: "sortBy",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["username", "joinedAt", "role"] },
        },
        {
          name: "sortOrder",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["asc", "desc"], default: "desc" },
        },
      ],
      responses: {
        "200": {
          description: "Report Details users page",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  message: {
                    type: "string",
                    example: "Users fetched successfully.",
                  },
                  data: {
                    type: "object",
                    properties: {
                      users: {
                        type: "array",
                        items: {
                          $ref: "#/components/schemas/AdminReportUserItem",
                        },
                      },
                      pagination: {
                        $ref: "#/components/schemas/AdminReportUsersPagination",
                      },
                    },
                    required: ["users", "pagination"],
                  },
                },
                required: ["success", "message", "data"],
              },
            },
          },
        },
        "400": errRes("Validation failed"),
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
      operationId: "adminBulkResolveReports",
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
      operationId: "adminBulkDismissReports",
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
      operationId: "adminResolveReport",
      summary: "Resolve a report",
      description:
        "**(Phase 1 — mock data behind the real contract)** Mark a report RESOLVED with a resolution " +
        "+ optional enforcement action (`actionOnReportedUser`). **The enforcement action is currently " +
        "RECORDED ONLY, not applied** — there is no RabbitMQ publish or call into the Users module in " +
        "the current code, despite an earlier version of this doc claiming one (`moderation.action.requested`). " +
        'Resolving with e.g. `actionOnReportedUser: "BAN"` returns `appliedActions` in the response but ' +
        "does NOT actually ban the user — do not surface this as a completed enforcement action in the UI " +
        "until backend wires the real enforcement call. Audited (writes an AuditLog row only, no ModerationAction). " +
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
      operationId: "adminDismissReport",
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
      operationId: "adminAssignReport",
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
      operationId: "adminAddReportNote",
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
  // §4.6 Livestreams
  // ===========================================================================
  "/admin/v1/livestreams": {
    get: {
      tags: [adminTags.livestreams],
      operationId: "adminListLivestreams",
      summary: "List livestreams",
      description:
        "Paginated, filtered livestreams read LIVE from stream-service over gRPC " +
        "(source of truth — no event-fed read-model). Each row is enriched with " +
        "community/creator/category/avatars and a report count (admin_db `Report`, " +
        "type=stream). `search` matches livestream title, community name, OR creator " +
        "name. Filters: `category` (slug/id), `status` (LIVE/ENDED/SCHEDULED/CANCELLED — " +
        "SCHEDULED⇄PENDING), `hasReports`, `minReports`, `communityId`, `creatorId`, " +
        "`dateFrom`/`dateTo`. Sort whitelist: `createdAt|viewerCount|reportCount|duration` " +
        "with `:asc|:desc` (default `createdAt:desc`). All media fields are full " +
        "presigned URLs (never object keys). Requires `livestreams.read`.",
      security: adminSecurity,
      parameters: [
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
          name: "search",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Matches livestream title, community name, OR creator name (case-insensitive).",
        },
        {
          name: "status",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["LIVE", "ENDED", "SCHEDULED", "CANCELLED"],
          },
        },
        {
          name: "communityId",
          in: "query",
          required: false,
          schema: { type: "string" },
        },
        {
          name: "creatorId",
          in: "query",
          required: false,
          schema: { type: "string" },
        },
        {
          name: "hasReports",
          in: "query",
          required: false,
          schema: { type: "boolean" },
        },
        {
          name: "minReports",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 0 },
        },
        {
          name: "sort",
          in: "query",
          required: false,
          schema: {
            type: "string",
            pattern:
              "^(createdAt|viewerCount|reportCount|duration):(asc|desc)$",
            default: "createdAt:desc",
          },
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
      ],
      responses: {
        "200": listRes(
          "Livestreams",
          "#/components/schemas/AdminLivestreamItem"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing livestreams.read"),
      },
    },
  },

  "/admin/v1/livestreams/bulk/end": {
    post: {
      tags: [adminTags.livestreams],
      operationId: "adminBulkEndLivestreams",
      summary: "Bulk end livestreams",
      description:
        "Force-end up to 100 livestreams in a single request. Returns a 207 Multi-Status with per-item results. Audited as `livestream.bulk_ended`. Requires `livestreams.moderate`.",
      security: adminSecurity,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["livestreamIds", "reasonCode"],
              properties: {
                livestreamIds: {
                  type: "array",
                  items: { type: "string" },
                  minItems: 1,
                  maxItems: 100,
                  example: [
                    "64a1b2c3d4e5f6a7b8c9d0e1",
                    "64a1b2c3d4e5f6a7b8c9d0e2",
                  ],
                },
                reasonCode: {
                  type: "string",
                  enum: [
                    "POLICY_VIOLATION",
                    "COMMUNITY_GUIDELINES",
                    "SPAM",
                    "HARASSMENT",
                    "COPYRIGHT",
                    "NUDITY",
                    "VIOLENCE",
                    "MANUAL_ADMIN",
                  ],
                  example: "POLICY_VIOLATION",
                },
                note: { type: "string", maxLength: 2000 },
                notifyCreator: { type: "boolean", default: false },
                issueStrike: { type: "boolean", default: false },
                takedownRecording: { type: "boolean", default: false },
              },
            },
          },
        },
      },
      responses: {
        "207": {
          description: "Multi-Status result",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  data: { $ref: "#/components/schemas/AdminBulkResult" },
                },
              },
            },
          },
        },
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing livestreams.moderate"),
      },
    },
  },

  "/admin/v1/livestreams/bulk/review-reports": {
    post: {
      tags: [adminTags.livestreams],
      operationId: "adminBulkReviewStreamReports",
      summary: "Bulk review stream reports",
      description:
        "Transition up to 100 stream reports to REVIEWING, RESOLVED, or DISMISSED in a single request. Returns 207 Multi-Status. Audited as `livestream.reports_bulk_reviewed`. " +
        "**NO-OP WARNING: the live implementation does not mutate any report row** — it unconditionally reports every item as succeeded without touching report state. Report status for livestream reports is intended to be owned by the Reports & Moderation module, which this endpoint does not call into. Do not rely on this endpoint to actually change report status today. Requires `livestreams.moderate`.",
      security: adminSecurity,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["reportIds", "status"],
              properties: {
                reportIds: {
                  type: "array",
                  items: { type: "string" },
                  minItems: 1,
                  maxItems: 100,
                },
                status: {
                  type: "string",
                  enum: ["REVIEWING", "RESOLVED", "DISMISSED"],
                },
                note: { type: "string", maxLength: 2000 },
              },
            },
          },
        },
      },
      responses: {
        "207": {
          description: "Multi-Status result",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  data: { $ref: "#/components/schemas/AdminBulkResult" },
                },
              },
            },
          },
        },
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing livestreams.moderate"),
      },
    },
  },

  "/admin/v1/livestreams/{livestreamId}": {
    get: {
      tags: [adminTags.livestreams],
      operationId: "adminGetLivestream",
      summary: "Get livestream detail",
      description:
        "Full detail view including creator profile, community context, viewer stats (merged with live Redis count via gRPC), report summary, and moderation history. Requires `livestreams.read`.",
      security: adminSecurity,
      parameters: [
        {
          name: "livestreamId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": okRes(
          "Livestream detail",
          "#/components/schemas/AdminLivestreamDetail"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing livestreams.read"),
        "404": errRes("Livestream not found"),
      },
    },
  },

  "/admin/v1/livestreams/{livestreamId}/reports": {
    get: {
      tags: [adminTags.livestreams],
      operationId: "adminListLivestreamReports",
      summary: "List reports for a livestream",
      description:
        "Paginated reports filed against a specific stream. Filter by `status` (OPEN/REVIEWING/RESOLVED/DISMISSED) and `reportType`. Sort on `createdAt:asc|desc`. Requires `livestreams.read`.",
      security: adminSecurity,
      parameters: [
        {
          name: "livestreamId",
          in: "path",
          required: true,
          schema: { type: "string" },
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
          name: "status",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["OPEN", "REVIEWING", "RESOLVED", "DISMISSED"],
          },
        },
        {
          name: "reportType",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: [
              "HARASSMENT",
              "SPAM",
              "COPYRIGHT",
              "NUDITY",
              "VIOLENCE",
              "HATE_SPEECH",
              "OTHER",
            ],
          },
        },
        {
          name: "sort",
          in: "query",
          required: false,
          schema: {
            type: "string",
            pattern: "^createdAt:(asc|desc)$",
            default: "createdAt:desc",
          },
        },
      ],
      responses: {
        "200": listRes(
          "Stream reports",
          "#/components/schemas/AdminLivestreamReport"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing livestreams.read"),
        "404": errRes("Livestream not found"),
      },
    },
  },

  "/admin/v1/livestreams/{livestreamId}/users": {
    get: {
      tags: [adminTags.livestreams],
      operationId: "adminListLivestreamUsers",
      summary: "List livestream viewer sessions",
      description:
        "Paginated VIEWER-SESSION HISTORY for this stream (who watched, when they " +
        "joined/left, how long) — read from stream-service's durable " +
        "LivestreamViewerSession records via streamClient.adminListViewerSessions, " +
        "enriched per row with `fullName` (same format as the detail's `creator.displayName` — firstName + lastName, trimmed, username fallback) and " +
        "`type` (`Host` for the stream creator — always surfaced since the host publishes via SRS/RTMP and never emits `stream:join`; " +
        "otherwise the viewer's CURRENT community role — Admin|Moderator|Member, " +
        "via a single batched communityClient.adminGetMemberRoles call keyed by " +
        "the page's userIds; defaults to Member if they've since left the " +
        "community). This is NOT the community roster — there is no `search` " +
        "or role/`type` filter on the query; sort only via sortField/sortDir. " +
        "Requires `livestreams.read`.",
      security: adminSecurity,
      parameters: [
        {
          name: "livestreamId",
          in: "path",
          required: true,
          schema: { type: "string" },
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
          name: "sortField",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["joinedAt", "watchDurationSeconds"],
          },
        },
        {
          name: "sortDir",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["asc", "desc"] },
        },
      ],
      responses: {
        "200": listRes(
          "Livestream viewer-session page",
          "#/components/schemas/AdminLivestreamUserItem"
        ),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing livestreams.read"),
        "404": errRes("Livestream not found"),
      },
      "x-implementation-status": "implemented",
    },
  },

  "/admin/v1/livestreams/{livestreamId}/end": {
    post: {
      tags: [adminTags.livestreams],
      operationId: "adminEndLivestream",
      summary: "End a livestream",
      description:
        "Admin force-ends a single livestream. Records a moderation action and an audit log entry (`livestream.ended`). Optionally notifies the creator and issues a strike. Requires `livestreams.moderate`.",
      security: adminSecurity,
      parameters: [
        {
          name: "livestreamId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["reasonCode"],
              properties: {
                reasonCode: {
                  type: "string",
                  enum: [
                    "POLICY_VIOLATION",
                    "COMMUNITY_GUIDELINES",
                    "SPAM",
                    "HARASSMENT",
                    "COPYRIGHT",
                    "NUDITY",
                    "VIOLENCE",
                    "MANUAL_ADMIN",
                  ],
                  example: "POLICY_VIOLATION",
                },
                note: { type: "string", maxLength: 2000 },
                notifyCreator: { type: "boolean", default: false },
                issueStrike: { type: "boolean", default: false },
                takedownRecording: { type: "boolean", default: false },
              },
            },
          },
        },
      },
      responses: {
        "200": okRes(
          "Stream ended",
          "#/components/schemas/AdminEndLivestreamResult"
        ),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing livestreams.moderate"),
        "404": errRes("Livestream not found"),
      },
    },
  },

  "/admin/v1/livestreams/{livestreamId}/thumbnail/presign": {
    post: {
      tags: [adminTags.livestreams],
      operationId: "adminPresignStreamThumbnail",
      summary: "Presign stream thumbnail upload URL",
      description: `Generate a short-lived presigned PUT URL so the admin client can upload a stream thumbnail directly to MinIO (bucket: \`aimess-stream\`, prefix: \`stream/thumbnail/\`).

**Upload flow:**
1. Call this endpoint with the image's \`contentType\` and \`contentLength\`.
2. PUT the image bytes directly to \`uploadUrl\` with the returned \`Content-Type\` header.
3. Call **PATCH /admin/v1/livestreams/{livestreamId}/thumbnail** with the returned \`objectKey\` to commit the key to the stream record.

**Allowed types:** \`image/jpeg\`, \`image/png\`, \`image/webp\`. Max 5 MB. Requires \`livestreams.moderate\`.`,
      security: adminSecurity,
      parameters: [
        {
          name: "livestreamId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["contentType", "contentLength"],
              properties: {
                contentType: {
                  type: "string",
                  enum: ["image/jpeg", "image/png", "image/webp"],
                  example: "image/jpeg",
                },
                contentLength: {
                  type: "integer",
                  minimum: 1,
                  maximum: 5242880,
                  example: 204800,
                  description: "Exact file size in bytes (max 5 MB).",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": okRes(
          "Presigned upload URL",
          "#/components/schemas/AdminThumbnailPresignResult"
        ),
        "400": errRes(
          "Unsupported content type, file too large, or stream not found"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing livestreams.moderate"),
        "404": errRes("Livestream not found"),
      },
    },
  },

  "/admin/v1/livestreams/{livestreamId}/thumbnail": {
    patch: {
      tags: [adminTags.livestreams],
      operationId: "adminSaveStreamThumbnail",
      summary: "Save stream thumbnail",
      description:
        "Commits an already-uploaded MinIO object key to the stream's `thumbnail` field by calling stream-service over gRPC. Audited as `livestream.thumbnail_updated`. Requires `livestreams.moderate`.\n\n" +
        "The `objectKey` must start with `stream/thumbnail/` and must not contain `..`.",
      security: adminSecurity,
      parameters: [
        {
          name: "livestreamId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["objectKey"],
              properties: {
                objectKey: {
                  type: "string",
                  pattern: "^stream/thumbnail/",
                  maxLength: 512,
                  example:
                    "stream/thumbnail/64a1b2c3d4e5f6a7b8c9d0e1/f47ac10b-58cc-4372-a567-0e02b2c3d479.jpg",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Thumbnail saved",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  data: {
                    type: "object",
                    properties: {
                      livestreamId: { type: "string" },
                      thumbnail: {
                        type: "string",
                        example: "stream/thumbnail/64a1b2c3/uuid.jpg",
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "400": errRes("Invalid objectKey format"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing livestreams.moderate"),
        "404": errRes("Livestream not found"),
      },
    },
  },

  // ===========================================================================
  // §4.7 Announcements — requires `announcements.manage`
  // ===========================================================================
  "/admin/v1/announcements": {
    get: {
      tags: [adminTags.announcements],
      operationId: "adminListAnnouncements",
      summary: "List announcements",
      description:
        "Paginated, filtered list (admin_db OWN). Filters: `search` (title/description), " +
        "`target` (ALL/COMMUNITY), `status` (repeatable), `dateFrom`/`dateTo` (on createdAt). " +
        "Sort whitelist `createdAt|scheduledAt|sentAt|title` with `:asc|:desc` (default " +
        "`createdAt:desc`). Requires `announcements.manage`.",
      security: adminSecurity,
      parameters: [
        {
          name: "search",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Matches title or description (case-insensitive).",
        },
        {
          name: "target",
          in: "query",
          required: false,
          schema: { $ref: "#/components/schemas/AdminAnnouncementTarget" },
        },
        {
          name: "status",
          in: "query",
          required: false,
          style: "form",
          explode: true,
          schema: {
            type: "array",
            items: { $ref: "#/components/schemas/AdminAnnouncementStatus" },
          },
          description: "Repeatable.",
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
            pattern: "^(createdAt|scheduledAt|sentAt|title):(asc|desc)$",
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
        "200": listRes(
          "Announcements",
          "#/components/schemas/AdminAnnouncementListItem"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing announcements.manage"),
      },
      "x-implementation-status": "implemented",
    },
    post: {
      tags: [adminTags.announcements],
      operationId: "adminCreateAnnouncement",
      summary: "Create an announcement",
      description:
        "Validates and persists the announcement. If `scheduledAt` is set (must be in the " +
        "future), delivery is scheduled via the background poller; otherwise delivery is " +
        "enqueued immediately (never sent synchronously — recipients are fanned out in " +
        "paginated batches over RabbitMQ). `target=COMMUNITY` requires `communityId` and is " +
        "validated against community-service before the row is created. Audited. Requires " +
        "`announcements.manage`.",
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
        "404": errRes("Community not found (target=COMMUNITY)"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/announcements/{id}": {
    get: {
      tags: [adminTags.announcements],
      operationId: "adminGetAnnouncement",
      summary: "Get an announcement",
      description:
        "Full announcement detail, including delivery status, recipientCount, and sentAt " +
        "(admin_db OWN). Requires `announcements.manage`.",
      security: adminSecurity,
      parameters: [idPathParam],
      responses: {
        "200": okRes("Announcement", "#/components/schemas/AdminAnnouncement"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing announcements.manage"),
        "404": errRes("Announcement not found"),
      },
      "x-implementation-status": "implemented",
    },
  },

  // ===========================================================================
  // §4.8 Categories — requires `categories.manage`
  //
  // Owned by community-service's `CommunityCategory` (community_db) — the
  // admin panel manages it exclusively through a gRPC bridge (no duplicate
  // category table exists in admin_db). Plain-text `name`, no i18n/icon.
  // ===========================================================================
  "/admin/v1/categories": {
    get: {
      tags: [adminTags.categories],
      operationId: "adminListCategories",
      summary: "List categories",
      description:
        "Paginated, searchable, sortable list (gRPC-live from community-service). " +
        "`search` matches name OR description (case-insensitive). `status` filters " +
        "by visibility (`visible`/`hidden`/`all`, default `all`). Sort whitelist " +
        "`name|order|createdAt|communityCount` with `:asc|:desc` (default " +
        "`order:asc`). `communityCount` on each row is a DB count of communities in " +
        "that category with status=ACTIVE and deletedAt unset. Requires " +
        "`categories.manage`.",
      security: adminSecurity,
      parameters: [
        {
          name: "search",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Matches name OR description (case-insensitive).",
        },
        {
          name: "status",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["visible", "hidden", "all"],
            default: "all",
          },
        },
        {
          name: "sort",
          in: "query",
          required: false,
          schema: {
            type: "string",
            pattern: "^(name|order|createdAt|communityCount):(asc|desc)$",
            default: "order:asc",
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
        "200": listRes("Categories", "#/components/schemas/AdminCategory"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing categories.manage"),
      },
      "x-implementation-status": "implemented",
    },
    post: {
      tags: [adminTags.categories],
      operationId: "adminCreateCategory",
      summary: "Create a category",
      description:
        "`name` is trimmed and must be unique case-insensitively (community-service " +
        "enforces this; concurrent duplicate creates race safely on the underlying " +
        "unique index). Audited. Requires `categories.manage`.",
      security: adminSecurity,
      requestBody: jsonBody("#/components/schemas/AdminCategoryCreateRequest"),
      responses: {
        "201": okRes("Category created", "#/components/schemas/AdminCategory"),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing categories.manage"),
        "409": errRes("Category name already taken"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/categories/{id}": {
    patch: {
      tags: [adminTags.categories],
      operationId: "adminUpdateCategory",
      summary: "Update a category",
      description:
        "Update `name` and/or toggle `visible` — at least one must be provided. A new " +
        "`name` is re-checked for case-insensitive uniqueness. Audited. Requires " +
        "`categories.manage`.",
      security: adminSecurity,
      parameters: [idPathParam],
      requestBody: jsonBody("#/components/schemas/AdminCategoryUpdateRequest"),
      responses: {
        "200": okRes("Category updated", "#/components/schemas/AdminCategory"),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing categories.manage"),
        "404": errRes("Category not found"),
        "409": errRes("Category name already taken"),
      },
      "x-implementation-status": "implemented",
    },
    delete: {
      tags: [adminTags.categories],
      operationId: "adminDeleteCategory",
      summary: "Delete a category",
      description:
        "Blocked (409) while any community assigned to this category is still " +
        "ACTIVE and not (soft-)deleted. Otherwise: hard-deletes the category when no " +
        "community references it at all; when it's still referenced only by " +
        "CLOSED and/or deleted communities, it is soft-deleted instead (permanently " +
        "hidden from every category query, same `deletedAt` convention as " +
        "`Community.deletedAt`) so those communities keep a valid `categoryId`. " +
        "Audited. Requires `categories.manage`.",
      security: adminSecurity,
      parameters: [idPathParam],
      responses: {
        "200": {
          description: "Category deleted",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  data: { type: "null" },
                },
                required: ["success", "data"],
              },
            },
          },
        },
        "401": errRes("Unauthorized"),
        "403": errRes("Missing categories.manage"),
        "404": errRes("Category not found"),
        "409": errRes(
          "Category cannot be deleted because it is assigned to active communities."
        ),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/categories/{id}/visibility": {
    patch: {
      tags: [adminTags.categories],
      operationId: "adminUpdateCategoryVisibility",
      summary: "Show or hide a category",
      description:
        "Dedicated visibility toggle — validates the category exists and updates " +
        "only its visibility status (`VISIBLE` maps to `visible=true`, `HIDDEN` to " +
        "`visible=false`); `name` and every other field are left untouched. " +
        "Audited. Requires `categories.manage`.",
      security: adminSecurity,
      parameters: [idPathParam],
      requestBody: jsonBody(
        "#/components/schemas/AdminCategoryVisibilityUpdateRequest"
      ),
      responses: {
        "200": okRes(
          "Category visibility updated",
          "#/components/schemas/AdminCategory"
        ),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing categories.manage"),
        "404": errRes("Category not found"),
      },
      "x-implementation-status": "implemented",
    },
  },

  // ===========================================================================
  // §4.9 Audit Logs  (IMPLEMENTED) — requires `auditlogs.read`. Read-only;
  // rows are written automatically by every other admin module.
  // ===========================================================================
  "/admin/v1/audit-logs": {
    get: {
      tags: [adminTags.auditLogs],
      operationId: "adminListAuditLogs",
      summary: "List audit logs",
      description:
        "Append-only table (admin_db OWN) — no mutations, newest first. search matches performer name/email OR targetId. action is repeatable (?action=A&action=B). Sort whitelist createdAt|action with :asc|:desc (default createdAt:desc). dateFrom/dateTo are YYYY-MM-DD, applied as a whole-day range. Requires auditlogs.read.",
      security: adminSecurity,
      parameters: [
        {
          name: "search",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Matches performer name/email OR targetId (case-insensitive).",
        },
        {
          name: "action",
          in: "query",
          required: false,
          style: "form",
          explode: true,
          schema: { type: "array", items: { type: "string", maxLength: 100 } },
          description: "Repeatable action-name filter.",
        },
        {
          name: "sort",
          in: "query",
          required: false,
          schema: {
            type: "string",
            pattern: "^(createdAt|action):(asc|desc)$",
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
      ],
      responses: {
        "200": listRes("Audit logs", "#/components/schemas/AdminAuditLog"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing auditlogs.read"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/audit-logs/{id}": {
    get: {
      tags: [adminTags.auditLogs],
      operationId: "adminGetAuditLog",
      summary: "Get audit log detail",
      description:
        "Full detail incl. before/after metadata diff and a derived reason (scans metadata.after then metadata.before for the first non-empty reason/note/reasonNote/reasonCode string). id must be a UUID. Requires auditlogs.read.",
      security: adminSecurity,
      parameters: [idPathParam],
      responses: {
        "200": okRes("Audit log", "#/components/schemas/AdminAuditLog"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing auditlogs.read"),
        "404": errRes("Audit log not found"),
      },
      "x-implementation-status": "implemented",
    },
  },

  // ===========================================================================
  // §4.10 System Health  (IMPLEMENTED) — requires `systemhealth.read`. No
  // request body/query params. Redis-cached, 5s TTL. Never 500s — a partial
  // outage still returns 200 with the affected components marked down/degraded.
  // ===========================================================================
  "/admin/v1/system-health": {
    get: {
      tags: [adminTags.systemHealth],
      operationId: "adminGetSystemHealth",
      summary: "Live system health snapshot",
      description:
        "Overall status + services-up tally + per-service health (gRPC ping + circuit-breaker stats for auth/community/chat; media/notification/stream/user report status:'unknown', monitored:false — no probe wired for them yet) + infrastructure health (Postgres/Redis/RabbitMQ/MinIO). lastUpdated is the true staleness indicator (cache TTL 5s). Requires systemhealth.read.",
      security: adminSecurity,
      responses: {
        "200": okRes("System health", "#/components/schemas/AdminSystemHealth"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing systemhealth.read"),
      },
      "x-implementation-status": "implemented",
    },
  },

  // ===========================================================================
  // §4.11 Admin Accounts  (IMPLEMENTED) — requires `admins.manage`
  // (SUPER_ADMIN-gated for SUPER_ADMIN-targeting mutations). NOTE: there is no
  // TOTP/2FA step-up flow implemented today — do not send X-Totp-Code.
  // ===========================================================================
  "/admin/v1/admin-accounts/permissions": {
    get: {
      tags: [adminTags.adminAccounts],
      operationId: "adminListPermissionCatalogue",
      summary: "List the full permission catalogue",
      description:
        "Every permission key + its group, for building a permission-picker/reference UI. Requires admins.manage.",
      security: adminSecurity,
      responses: {
        "200": listRes(
          "Permission catalogue",
          "#/components/schemas/AdminPermissionCatalogueItem"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing admins.manage"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/admin-accounts": {
    get: {
      tags: [adminTags.adminAccounts],
      operationId: "adminListAdminAccounts",
      summary: "List admin accounts",
      description:
        "Paginated, searchable, filtered admin list (admin_db OWN). search matches name OR email. status enum ACTIVE|DISABLED|INVITED|all (default all). roleKey enum or all (default all). Sort whitelist name|email|createdAt|lastLoginAt with :asc|:desc (default createdAt:desc). Requires admins.manage.",
      security: adminSecurity,
      parameters: [
        {
          name: "search",
          in: "query",
          required: false,
          schema: { type: "string" },
        },
        {
          name: "status",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["ACTIVE", "DISABLED", "INVITED", "all"],
            default: "all",
          },
        },
        {
          name: "roleKey",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: [
              "SUPER_ADMIN",
              "ADMIN",
              "MODERATOR",
              "SUPPORT_AGENT",
              "ANALYST",
              "all",
            ],
            default: "all",
          },
        },
        {
          name: "sort",
          in: "query",
          required: false,
          schema: {
            type: "string",
            pattern: "^(name|email|createdAt|lastLoginAt):(asc|desc)$",
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
        "200": listRes("Admin accounts", "#/components/schemas/AdminAccount"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing admins.manage"),
      },
      "x-implementation-status": "implemented",
    },
    post: {
      tags: [adminTags.adminAccounts],
      operationId: "adminCreateAdminAccount",
      summary: "Create an admin account",
      description:
        "Only a SUPER_ADMIN actor may create a SUPER_ADMIN target (else 403 ADMIN_FORBIDDEN). Audited (admin.created). Requires admins.manage.",
      security: adminSecurity,
      requestBody: jsonBody("#/components/schemas/AdminAccountCreateRequest"),
      responses: {
        "201": okRes("Admin created", "#/components/schemas/AdminAccount"),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing admins.manage or ADMIN_FORBIDDEN"),
        "404": errRes("ADMIN_ROLE_NOT_FOUND (defensive)"),
        "409": errRes("ADMIN_EMAIL_TAKEN"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/admin-accounts/{id}": {
    get: {
      tags: [adminTags.adminAccounts],
      operationId: "adminGetAdminAccount",
      summary: "Get an admin account",
      description: "Requires admins.manage.",
      security: adminSecurity,
      parameters: [idPathParam],
      responses: {
        "200": okRes("Admin account", "#/components/schemas/AdminAccount"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing admins.manage"),
        "404": errRes("ADMIN_NOT_FOUND"),
      },
      "x-implementation-status": "implemented",
    },
    patch: {
      tags: [adminTags.adminAccounts],
      operationId: "adminUpdateAdminAccount",
      summary: "Update an admin's profile (name/avatarUrl only)",
      description:
        "Cannot edit an existing SUPER_ADMIN target unless the actor is SUPER_ADMIN. Role changes are NOT accepted here — use .../permissions. Audited (admin.updated). Requires admins.manage.",
      security: adminSecurity,
      parameters: [idPathParam],
      requestBody: jsonBody("#/components/schemas/AdminAccountUpdateRequest"),
      responses: {
        "200": okRes("Admin updated", "#/components/schemas/AdminAccount"),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing admins.manage or ADMIN_FORBIDDEN"),
        "404": errRes("ADMIN_NOT_FOUND"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/admin-accounts/{id}/activate": {
    post: {
      tags: [adminTags.adminAccounts],
      operationId: "adminActivateAdminAccount",
      summary: "Activate a disabled admin account",
      description:
        "No request body. Audited (admin.activated). Requires admins.manage.",
      security: adminSecurity,
      parameters: [idPathParam],
      responses: {
        "200": okRes("Admin activated", "#/components/schemas/AdminAccount"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing admins.manage or ADMIN_FORBIDDEN"),
        "404": errRes("ADMIN_NOT_FOUND"),
        "409": errRes("ADMIN_ALREADY_ACTIVE"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/admin-accounts/{id}/deactivate": {
    post: {
      tags: [adminTags.adminAccounts],
      operationId: "adminDeactivateAdminAccount",
      summary: "Deactivate an admin account",
      description:
        "No request body. Immediately revokes ALL active sessions for the target admin. 403 ADMIN_CANNOT_DEACTIVATE_SELF if id === actor.id. Audited (admin.deactivated). Requires admins.manage.",
      security: adminSecurity,
      parameters: [idPathParam],
      responses: {
        "200": okRes("Admin deactivated", "#/components/schemas/AdminAccount"),
        "401": errRes("Unauthorized"),
        "403": errRes(
          "Missing admins.manage, ADMIN_FORBIDDEN, or ADMIN_CANNOT_DEACTIVATE_SELF"
        ),
        "404": errRes("ADMIN_NOT_FOUND"),
        "409": errRes("ADMIN_ALREADY_INACTIVE"),
      },
      "x-implementation-status": "implemented",
    },
  },
  "/admin/v1/admin-accounts/{id}/permissions": {
    get: {
      tags: [adminTags.adminAccounts],
      operationId: "adminGetAdminAccountPermissions",
      summary: "Get an admin's resolved (role-derived) permissions",
      description: "Requires admins.manage.",
      security: adminSecurity,
      parameters: [idPathParam],
      responses: {
        "200": okRes(
          "Permissions view",
          "#/components/schemas/AdminAccountPermissionsView"
        ),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing admins.manage"),
        "404": errRes("ADMIN_NOT_FOUND"),
      },
      "x-implementation-status": "implemented",
    },
    patch: {
      tags: [adminTags.adminAccounts],
      operationId: "adminSetAdminAccountRole",
      summary: "Reassign an admin's role",
      description:
        "There is NO per-permission override in this service — this REPLACES the admin's whole role. Both the existing role and the incoming roleKey are checked against the SUPER_ADMIN gate; either can 403. Audited (admin.permissions_updated). Requires admins.manage.",
      security: adminSecurity,
      parameters: [idPathParam],
      requestBody: jsonBody("#/components/schemas/AdminAccountRoleRequest"),
      responses: {
        "200": okRes(
          "Permissions view",
          "#/components/schemas/AdminAccountPermissionsView"
        ),
        "400": errRes("Validation failed"),
        "401": errRes("Unauthorized"),
        "403": errRes("Missing admins.manage or ADMIN_FORBIDDEN"),
        "404": errRes("ADMIN_NOT_FOUND or ADMIN_ROLE_NOT_FOUND"),
      },
      "x-implementation-status": "implemented",
    },
  },

  // ===========================================================================
  // §4.12 Health (infra — public to gateway/k8s)  (IMPLEMENTED)
  // ===========================================================================
  "/admin/v1/health": {
    get: {
      tags: [adminTags.systemHealth],
      operationId: "adminLivenessProbe",
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
      operationId: "adminReadinessProbe",
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
