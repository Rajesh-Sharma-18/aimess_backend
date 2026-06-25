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
      summary: "Admin logout",
      description:
        "Revokes the current admin session (by session id) in Redis + DB. Audited. Requires a valid admin bearer.",
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
  "/admin/v1/dashboard/overview": {
    get: {
      tags: [adminTags.dashboard],
      summary: "Dashboard stat cards",
      description:
        "Stat-card section only. Returns `{ stats }` aggregated live over gRPC: user/active/banned counts from auth-service, communities from community-service, groups from chat-service. `totalLivestreams`, `openReports`, and `churnedUsers` are STATIC stubs (0) flagged in `stats.stale`; any unreachable service degrades its field to 0 + a `stale` flag rather than failing the call. Cached independently (10s). Requires `dashboard.read`.",
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
        "Chart section. Returns `{ activeVsChurned, communitiesGroups }`. `activeVsChurned` is a REAL per-day series whose date range is driven by `?period=` (daily=last 15 days, weekly=last 8 days, monthly=1st-of-month→last day), computed live from auth-service session activity; if auth-service is unreachable the series falls back to empty (flagged `stale.activeVsChurned`). `communitiesGroups` is the donut (`communities` from community-service, `groups` from chat-service, plus their `total`). Cached per-period (10s). Requires `dashboard.read`.",
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
  // §4.2 User Management  (PLANNED)
  // ===========================================================================
  "/admin/v1/users": {
    get: {
      tags: [adminTags.users],
      summary: "List / search users",
      description:
        PLANNED +
        "Aggregates `AdminListUsers` (auth-service) + `AdminListProfiles` (user-service) via gRPC-live. " +
        "Filters: `status` (repeatable, case-insensitive), `reports` bucket, a join-date range " +
        "(`dateFrom`/`dateTo`, or `createdAfter`/`createdBefore` aliases), and `q` search " +
        "(username/email). Sort via `sortBy` + `sortOrder` (default `joinedDate`/`desc`). " +
        "**Note:** `sortBy=reports` is DB-sorted on the read-model; in the live gRPC path it " +
        "falls back to join-date order — your `sortOrder` is still applied (report counts " +
        "live in admin_db only). Requires `users.read`.",
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
  "/admin/v1/users/{id}/suspend": {
    post: {
      tags: [adminTags.users],
      summary: "Suspend a user",
      description:
        PLANNED +
        "Temp suspend (with `reason`, `until`). Writes `ModerationAction` and emits `admin.user_suspended`. Audited. Requires `users.moderate`. (Step-up TOTP auth for sensitive mutations planned for Phase 2.)",
      security: adminSecurity,
      parameters: [idPathParam],
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
        "Writes `ModerationAction` and emits `admin.user_banned`; auth-service locks the account. Audited. Requires `users.moderate`. (Step-up TOTP auth for sensitive mutations planned for Phase 2.)",
      security: adminSecurity,
      parameters: [idPathParam],
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
  "/admin/v1/communities/{communityId}/members": {
    get: {
      tags: [adminTags.communities],
      summary: "List community members",
      description:
        "Paginated member roster for a community (community-service gRPC, " +
        "denormalized snapshot fields — no user-service round-trip). Supports " +
        "`q`/`search` (username, display name, or exact userId) and a `role` " +
        "filter. Requires `communities.read`.",
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
        "**(Phase 1 — mock data behind the real contract)** Core report detail: enriched " +
        "reported/reporter users (with moderation signals), the reported target snapshot + deep link, " +
        "status/priority/resolution fields, and `availableActions[]` (server-computed from status + RBAC). " +
        "Sub-resources are served by dedicated paginated sub-routes: evidence → `/evidence`, action " +
        "history → `/history`, related reports → `/related`. Requires `reports.read`.",
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
  "/admin/v1/reports/{reportId}/evidence": {
    get: {
      tags: [adminTags.reports],
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
  // §4.6 Livestreams
  // ===========================================================================
  "/admin/v1/livestreams": {
    get: {
      tags: [adminTags.livestreams],
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
      summary: "Bulk review stream reports",
      description:
        "Transition up to 100 stream reports to REVIEWING, RESOLVED, or DISMISSED in a single request. Returns 207 Multi-Status. Audited as `livestream.reports_bulk_reviewed`. Requires `livestreams.moderate`.",
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
      summary: "List livestream users (the stream's community members)",
      description:
        "Paginated members of the stream's community — the Livestream User List " +
        "(Username, User ID, Joined Date, Type). `type` filters by community role " +
        "ADMIN|MODERATOR|MEMBER; `search` matches username/handle. Read through the " +
        "community-members gRPC. Avatars are full presigned URLs. Requires " +
        "`livestreams.read`.",
      security: adminSecurity,
      parameters: [
        {
          name: "livestreamId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "search",
          in: "query",
          required: false,
          schema: { type: "string", minLength: 1 },
        },
        {
          name: "type",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["ADMIN", "MODERATOR", "MEMBER"] },
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
          "Livestream users (community members) page",
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
