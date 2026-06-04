export const openApiSchemas = {
  // ===========================================================================
  // Admin Panel (backoffice-service) schemas — surface reached at /admin/v1/*.
  // ===========================================================================
  AdminError: {
    type: "object",
    description:
      "Standard admin error envelope. `code` is a stable `@aimess/errors` code the admin UI localizes; `message` is a human-readable hint.",
    properties: {
      success: { type: "boolean", example: false },
      code: { type: "string", example: "ADMIN_FORBIDDEN" },
      message: { type: "string", example: "Missing required permission" },
      errors: {
        type: "object",
        description: "Present on validation errors (field → message).",
      },
    },
    required: ["success", "message"],
  },
  AdminPagination: {
    type: "object",
    properties: {
      page: { type: "integer", example: 1 },
      limit: { type: "integer", example: 20 },
      total: { type: "integer", example: 5234 },
      totalPages: { type: "integer", example: 262 },
    },
    required: ["page", "limit", "total", "totalPages"],
  },
  AdminPaginated: {
    type: "object",
    description:
      "Generic paginated list envelope: `{ data: [...], pagination }`.",
    properties: {
      data: { type: "array", items: { type: "object" } },
      pagination: { $ref: "#/components/schemas/AdminPagination" },
    },
    required: ["data", "pagination"],
  },

  // ---- Auth & Account ----
  AdminLoginRequest: {
    type: "object",
    required: ["email", "password"],
    properties: {
      email: { type: "string", format: "email", example: "ops@aimess.io" },
      password: { type: "string", minLength: 1, example: "S3cret!pass" },
    },
  },
  AdminTokens: {
    type: "object",
    description:
      "Admin JWT pair — access (8h, JWT_ADMIN_SECRET) + refresh (7d, JWT_ADMIN_REFRESH_SECRET). Expiries are in seconds.",
    properties: {
      accessToken: { type: "string", example: "eyJhbGciOiJIUzI1NiIs..." },
      refreshToken: { type: "string", example: "eyJhbGciOiJIUzI1NiIs..." },
      accessTokenExpiresIn: { type: "integer", example: 28800 },
      refreshTokenExpiresIn: { type: "integer", example: 604800 },
    },
    required: [
      "accessToken",
      "refreshToken",
      "accessTokenExpiresIn",
      "refreshTokenExpiresIn",
    ],
  },
  AdminTokenResponse: {
    type: "object",
    description:
      "Successful admin login / token refresh — standard `{ success, message, data }` envelope with the JWT pair and the authenticated admin profile.",
    properties: {
      success: { type: "boolean", example: true },
      message: { type: "string", example: "Login successful" },
      data: {
        type: "object",
        properties: {
          tokens: { $ref: "#/components/schemas/AdminTokens" },
          admin: { $ref: "#/components/schemas/AdminProfile" },
        },
        required: ["tokens", "admin"],
      },
    },
    required: ["success", "data"],
  },
  AdminProfile: {
    type: "object",
    description: "Current admin profile + effective permissions.",
    properties: {
      id: { type: "string", example: "adm_1" },
      email: { type: "string", format: "email", example: "ops@aimess.io" },
      name: { type: "string", example: "Ops Admin" },
      role: {
        type: "string",
        enum: ["SUPER_ADMIN", "ADMIN", "MODERATOR", "SUPPORT_AGENT", "ANALYST"],
        example: "ADMIN",
      },
      permissions: {
        type: "array",
        items: { type: "string" },
        example: ["dashboard.read", "users.read", "users.moderate"],
      },
      status: {
        type: "string",
        enum: ["ACTIVE", "DISABLED", "INVITED"],
        example: "ACTIVE",
      },
      lastLoginAt: { type: "string", format: "date-time", nullable: true },
    },
    required: ["id", "email", "role", "permissions"],
  },
  AdminChangePasswordRequest: {
    type: "object",
    required: ["current", "next"],
    properties: {
      current: { type: "string", example: "old-pass" },
      next: { type: "string", minLength: 8, example: "new-stronger-pass" },
    },
  },

  // ---- Forgot / reset password (public — a locked-out admin must reach these) ----
  AdminForgotPasswordRequest: {
    type: "object",
    required: ["email"],
    properties: {
      email: { type: "string", format: "email", example: "ops@aimess.io" },
    },
  },
  AdminForgotPasswordResponse: {
    type: "object",
    description:
      "Neutral response — identical whether or not an admin account exists for `email` (no account enumeration).",
    properties: {
      success: { type: "boolean", example: true },
      message: {
        type: "string",
        example: "If an account exists for that email, an OTP has been sent.",
      },
      data: {
        type: "object",
        properties: {
          email: { type: "string", format: "email", example: "ops@aimess.io" },
        },
        required: ["email"],
      },
    },
    required: ["success", "message", "data"],
  },
  AdminVerifyOtpRequest: {
    type: "object",
    required: ["email", "code"],
    properties: {
      email: { type: "string", format: "email", example: "ops@aimess.io" },
      code: {
        type: "string",
        pattern: "^[0-9]{6}$",
        minLength: 6,
        maxLength: 6,
        example: "482915",
        description: "6-digit password-reset OTP.",
      },
    },
  },
  AdminVerifyOtpResponse: {
    type: "object",
    description:
      "Successful OTP verification — returns a short-lived single-use reset token to authorize the password change.",
    properties: {
      success: { type: "boolean", example: true },
      message: { type: "string", example: "OTP verified" },
      data: {
        type: "object",
        properties: {
          resetToken: {
            type: "string",
            example: "rst_3f9c1a2b8d4e7f0a...",
          },
          resetTokenExpiresIn: {
            type: "integer",
            example: 600,
            description: "Reset-token lifetime in seconds.",
          },
        },
        required: ["resetToken", "resetTokenExpiresIn"],
      },
    },
    required: ["success", "message", "data"],
  },
  AdminResendOtpRequest: {
    type: "object",
    required: ["email"],
    properties: {
      email: { type: "string", format: "email", example: "ops@aimess.io" },
    },
  },
  AdminResendOtpResponse: {
    type: "object",
    description:
      "Neutral response — identical whether or not an admin account exists for `email`. Subject to a 60s cooldown (sliding window).",
    properties: {
      success: { type: "boolean", example: true },
      message: {
        type: "string",
        example:
          "If an account exists for that email, a new OTP has been sent.",
      },
      data: {
        type: "object",
        properties: {
          email: { type: "string", format: "email", example: "ops@aimess.io" },
        },
        required: ["email"],
      },
    },
    required: ["success", "message", "data"],
  },
  AdminResetPasswordRequest: {
    type: "object",
    required: ["resetToken", "password", "confirmPassword"],
    properties: {
      resetToken: {
        type: "string",
        example: "rst_3f9c1a2b8d4e7f0a...",
        description:
          "Single-use reset token from POST /admin/v1/auth/verify-otp.",
      },
      password: {
        type: "string",
        minLength: 12,
        example: "N3w$trongPass99!",
        description:
          "Min 12 chars, must include uppercase, lowercase, a digit and a special character.",
      },
      confirmPassword: {
        type: "string",
        minLength: 12,
        example: "N3w$trongPass99!",
        description: "Must match `password`.",
      },
    },
  },
  AdminResetPasswordResponse: {
    type: "object",
    description:
      "Successful password reset — the reset token is consumed and all existing admin sessions may be revoked.",
    properties: {
      success: { type: "boolean", example: true },
      message: { type: "string", example: "Password reset successful" },
      data: {
        type: "object",
        properties: {
          reset: { type: "boolean", example: true },
        },
        required: ["reset"],
      },
    },
    required: ["success", "message", "data"],
  },

  // ---- Dashboard ----
  AdminDashboard: {
    type: "object",
    description:
      "Merged dashboard payload returned by GET /admin/v1/dashboard/stats — all four widgets in one response.",
    properties: {
      stats: { $ref: "#/components/schemas/AdminDashboardStats" },
      activeVsChurned: { $ref: "#/components/schemas/AdminActiveVsChurned" },
      communitiesGroups: {
        $ref: "#/components/schemas/AdminCommunitiesGroups",
      },
      serviceStatus: { $ref: "#/components/schemas/AdminServiceStatus" },
    },
    required: [
      "stats",
      "activeVsChurned",
      "communitiesGroups",
      "serviceStatus",
    ],
  },
  AdminDashboardStats: {
    type: "object",
    properties: {
      totalUsers: { type: "integer", example: 5234 },
      newUsersToday: { type: "integer", example: 23 },
      dailyActiveUsers: { type: "integer", example: 3456 },
      monthlyActiveUsers: { type: "integer", example: 4821 },
      totalCommunities: { type: "integer", example: 248 },
      totalGroups: { type: "integer", example: 1342 },
      totalLivestreams: {
        type: "integer",
        example: 17,
        description: "STATIC stub for now — see `stale`.",
      },
      openReports: {
        type: "integer",
        example: 8,
        description: "STATIC stub for now — see `stale`.",
      },
      bannedUsers: { type: "integer", example: 34 },
      churnedUsers: {
        type: "integer",
        example: 0,
        description: "STATIC stub (0) for now — see `stale.churned`.",
      },
      asOf: { type: "string", format: "date-time" },
      stale: {
        type: "object",
        description:
          "Flags fields currently served from static stubs OR degraded to 0 because their source service was unreachable.",
        example: { totalLivestreams: true, openReports: true, churned: true },
      },
    },
  },
  AdminActiveVsChurned: {
    type: "object",
    properties: {
      period: {
        type: "string",
        enum: ["daily", "weekly", "monthly"],
        example: "monthly",
        description:
          "Drives the per-day date range (all UTC, day granularity): `daily`=last 15 days ending today (15 points), `weekly`=last 8 days ending today (8 points), `monthly`=1st → last day of the current month (days after today come back as 0).",
      },
      series: {
        type: "array",
        description:
          "Real per-day series (oldest → newest, one point per day) computed live from session `lastActiveAt`. Length follows `period`: daily=15, weekly=8, monthly=days-in-current-month (future days = 0).",
        items: {
          type: "object",
          properties: {
            bucket: {
              type: "string",
              example: "2026-06-03",
              description: "Day in YYYY-MM-DD (UTC).",
            },
            dailyActive: {
              type: "integer",
              example: 550,
              description: "Distinct users active that day.",
            },
            monthlyActive: {
              type: "integer",
              example: 450,
              description:
                "Distinct users active in the trailing 30 days ending that day.",
            },
            churned: {
              type: "integer",
              example: 12,
              description:
                "Users active in the prior trailing-30d window who dropped out of the current one (approximate).",
            },
          },
        },
      },
      note: {
        type: "string",
        description:
          "Documents the live per-day series + the undercount caveat: `lastActiveAt` keeps only each session's most-recent activity, so older days undercount true history (most recent days are most accurate). Superseded later by a snapshot read-model.",
      },
    },
  },
  AdminCommunitiesGroups: {
    type: "object",
    properties: {
      communities: { type: "integer", example: 248 },
      groups: { type: "integer", example: 1342 },
      total: { type: "integer", example: 1590 },
    },
  },
  AdminServiceStatus: {
    type: "object",
    properties: {
      services: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string", example: "chat" },
            label: { type: "string", example: "Chat Service" },
            status: {
              type: "string",
              enum: ["operational", "degraded", "down"],
              example: "operational",
            },
            latencyMs: { type: "integer", nullable: true, example: 21 },
            breaker: {
              type: "string",
              nullable: true,
              example: "half-open",
              description: "opossum circuit-breaker state when not closed.",
            },
            note: {
              type: "string",
              description:
                "Present for services with no backoffice gRPC client (status unknown, reported degraded).",
            },
          },
        },
      },
      checkedAt: { type: "string", format: "date-time" },
    },
  },
  AdminQuickLinks: {
    type: "object",
    properties: {
      openReports: { type: "integer", example: 8 },
      liveLivestreams: { type: "integer", example: 3 },
    },
  },

  // ---- User Management ----
  AdminUserListItem: {
    type: "object",
    properties: {
      id: { type: "string", example: "u_8f3a" },
      username: { type: "string", example: "brianna" },
      email: { type: "string", nullable: true, example: "b@x.com" },
      status: {
        type: "string",
        enum: ["active", "suspended", "banned", "pending_deletion"],
        example: "active",
      },
      banned: { type: "boolean", example: false },
      createdAt: { type: "string", format: "date-time" },
      communities: { type: "integer", example: 4 },
      lastActiveAt: {
        type: "string",
        format: "date-time",
        nullable: true,
      },
    },
    required: ["id", "username", "status"],
  },
  AdminUserDetail: {
    type: "object",
    description:
      "Full user profile: identity (auth-service) + profile/stats (user-service) + moderation history (admin_db ModerationAction).",
    properties: {
      id: { type: "string", example: "u_8f3a" },
      username: { type: "string", example: "brianna" },
      email: { type: "string", nullable: true },
      status: {
        type: "string",
        enum: ["active", "suspended", "banned", "pending_deletion"],
      },
      banned: { type: "boolean" },
      profile: {
        type: "object",
        description: "Profile/stats projected from user-service.",
      },
      moderationHistory: {
        type: "array",
        items: { $ref: "#/components/schemas/AdminModerationAction" },
      },
      createdAt: { type: "string", format: "date-time" },
    },
    required: ["id", "username", "status"],
  },
  AdminModerationAction: {
    type: "object",
    properties: {
      id: { type: "string", example: "ma_77" },
      type: {
        type: "string",
        enum: [
          "ban",
          "unban",
          "suspend",
          "force_logout",
          "delete",
          "content_delete",
        ],
        example: "ban",
      },
      targetType: { type: "string", example: "user" },
      targetId: { type: "string", example: "u_8f3a" },
      reason: { type: "string", nullable: true },
      actorId: { type: "string", example: "adm_1" },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  AdminSuspendRequest: {
    type: "object",
    required: ["reason"],
    properties: {
      reason: { type: "string", example: "Repeated harassment" },
      until: {
        type: "string",
        format: "date-time",
        nullable: true,
        description: "Suspension end. Omit/null for an indefinite suspend.",
      },
      durationDays: {
        type: "integer",
        nullable: true,
        example: 7,
        description: "Alternative to `until`.",
      },
      notifyUser: { type: "boolean", example: true },
    },
  },
  AdminBanRequest: {
    type: "object",
    required: ["reason"],
    properties: {
      reason: { type: "string", example: "Repeated harassment" },
      evidenceReportIds: {
        type: "array",
        items: { type: "string" },
        example: ["r_12"],
      },
      notifyUser: { type: "boolean", example: true },
    },
  },
  AdminModerationResult: {
    type: "object",
    description:
      "Result of a moderation mutation. Writes a ModerationAction (admin trail) and emits the matching admin.* event.",
    properties: {
      id: { type: "string", example: "u_8f3a" },
      status: { type: "string", example: "banned" },
      moderationActionId: { type: "string", example: "ma_77" },
      until: { type: "string", format: "date-time", nullable: true },
      emittedEvent: {
        type: "string",
        nullable: true,
        example: "admin.user_banned",
      },
    },
  },
  AdminUserSession: {
    type: "object",
    properties: {
      sessionId: { type: "string", format: "uuid" },
      device: { type: "string", nullable: true, example: "iPhone 15" },
      ip: { type: "string", example: "203.0.113.7" },
      lastActiveAt: { type: "string", format: "date-time" },
      isCurrent: { type: "boolean", example: false },
    },
  },

  // ---- Communities (Community Management module — shipped contract) ----
  // Source of truth: apps/backoffice-service/src/types/community.types.ts.
  // Field names + casing MUST match those view-model types exactly.
  AdminCommunityType: {
    type: "string",
    enum: ["PUBLIC", "PRIVATE"],
    example: "PUBLIC",
  },
  AdminCommunityModerationStatus: {
    type: "string",
    description: '"Closed" in the UI maps to repo CLOSED.',
    enum: ["ACTIVE", "CLOSED"],
    example: "ACTIVE",
  },
  AdminCommunityCloseReasonCode: {
    type: "string",
    enum: [
      "GUIDELINES_VIOLATION",
      "SPAM",
      "ILLEGAL_CONTENT",
      "INACTIVE",
      "ADMIN_ACTION",
    ],
    example: "GUIDELINES_VIOLATION",
  },
  AdminCommunityCategoryRef: {
    type: "object",
    properties: {
      id: { type: "string", example: "cat_food" },
      name: { type: "string", example: "Food & Drink" },
      slug: { type: "string", example: "food-drink" },
    },
    required: ["id", "name", "slug"],
  },
  AdminCommunityAdminRef: {
    type: "object",
    description: "Compact owner/admin reference shown in the list table.",
    properties: {
      userId: { type: "string", example: "u_8f3a" },
      name: { type: "string", example: "John Doe" },
      avatarUrl: {
        type: "string",
        nullable: true,
        example: "https://cdn.aimess.app/av/8f3.jpg",
      },
    },
    required: ["userId", "name", "avatarUrl"],
  },
  AdminCommunityLivestreamCounter: {
    type: "object",
    description:
      'Livestream counter projected onto the list ("value/max" in the UI).',
    properties: {
      value: { type: "integer", example: 1 },
      max: { type: "integer", example: 5 },
      stale: {
        type: "boolean",
        description:
          "Phase 1 fixtures are not live data — always stale until stream-service gRPC.",
        example: true,
      },
    },
    required: ["value", "max", "stale"],
  },
  AdminCommunityActions: {
    type: "object",
    description:
      "Row-level capability flags driving the action menu in the table.",
    properties: {
      canView: { type: "boolean", example: true },
      canClose: { type: "boolean", example: true },
      canReopen: { type: "boolean", example: false },
    },
    required: ["canView", "canClose", "canReopen"],
  },
  AdminCommunityListItem: {
    type: "object",
    description: "One row of the Communities table (list projection).",
    properties: {
      communityId: { type: "string", example: "comm_001" },
      communityName: { type: "string", example: "Hanoi Foodies" },
      admin: { $ref: "#/components/schemas/AdminCommunityAdminRef" },
      type: { $ref: "#/components/schemas/AdminCommunityType" },
      category: { $ref: "#/components/schemas/AdminCommunityCategoryRef" },
      status: { $ref: "#/components/schemas/AdminCommunityModerationStatus" },
      memberCount: { type: "integer", example: 1280 },
      livestreamCount: {
        $ref: "#/components/schemas/AdminCommunityLivestreamCounter",
      },
      createdAt: { type: "string", format: "date-time" },
      actions: { $ref: "#/components/schemas/AdminCommunityActions" },
    },
    required: [
      "communityId",
      "communityName",
      "admin",
      "type",
      "category",
      "status",
      "memberCount",
      "livestreamCount",
      "createdAt",
      "actions",
    ],
  },
  AdminCommunityListResponse: {
    type: "object",
    description:
      "List envelope for the communities table: data[] + pagination + meta.",
    properties: {
      success: { type: "boolean", example: true },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/AdminCommunityListItem" },
      },
      pagination: { $ref: "#/components/schemas/AdminModerationPagination" },
      meta: { $ref: "#/components/schemas/AdminResponseMeta" },
    },
    required: ["success", "data", "pagination", "meta"],
  },
  AdminCommunityOwner: {
    type: "object",
    description: "Full owner profile with moderation signals (detail view).",
    properties: {
      userId: { type: "string", example: "u_8f3a" },
      displayName: { type: "string", example: "John Doe" },
      username: { type: "string", example: "john_doe" },
      avatarUrl: { type: "string", nullable: true },
      email: { type: "string", nullable: true, example: "john@aimess.io" },
      accountStatus: {
        type: "string",
        enum: ["ACTIVE", "SUSPENDED", "BANNED", "DELETED"],
        example: "ACTIVE",
      },
    },
    required: [
      "userId",
      "displayName",
      "username",
      "avatarUrl",
      "email",
      "accountStatus",
    ],
  },
  AdminCommunityMemberStats: {
    type: "object",
    description: "Aggregated membership stats (detail view).",
    properties: {
      total: { type: "integer", example: 1280 },
      active: { type: "integer", example: 1190 },
      pending: { type: "integer", example: 12 },
      banned: { type: "integer", example: 4 },
      moderators: { type: "integer", example: 6 },
      joinedLast7d: { type: "integer", example: 34 },
    },
    required: [
      "total",
      "active",
      "pending",
      "banned",
      "moderators",
      "joinedLast7d",
    ],
  },
  AdminCommunityLivestreamStats: {
    type: "object",
    description:
      "Aggregated livestream stats (detail view). null when stream-service has no data.",
    properties: {
      total: { type: "integer", example: 18 },
      live: { type: "integer", example: 1 },
      scheduled: { type: "integer", example: 2 },
      maxConcurrent: { type: "integer", example: 5 },
      stale: {
        type: "boolean",
        description:
          "Phase 1 fixtures are not live data — always true until stream-service gRPC.",
        example: true,
      },
    },
    required: ["total", "live", "scheduled", "maxConcurrent", "stale"],
  },
  AdminCommunityModerationHistoryItem: {
    type: "object",
    description:
      "One entry in the community's moderation timeline (detail view).",
    properties: {
      id: { type: "string", example: "mh_comm_001_1" },
      type: { type: "string", example: "suspend_community" },
      reason: { type: "string", example: "Repeated guideline violations" },
      actor: {
        type: "object",
        properties: {
          adminId: { type: "string", example: "adm_3" },
          name: { type: "string", example: "Sara Admin" },
        },
        required: ["adminId", "name"],
      },
      createdAt: { type: "string", format: "date-time" },
      metadata: { type: "object", additionalProperties: true },
    },
    required: ["id", "type", "reason", "actor", "createdAt", "metadata"],
  },
  AdminCommunitySettingsSummary: {
    type: "object",
    description: "Quick settings snapshot shown on the detail header.",
    properties: {
      joinPolicy: { type: "string", example: "OPEN" },
      type: { $ref: "#/components/schemas/AdminCommunityType" },
      memberCount: { type: "integer", example: 1280 },
      inviteLinksActive: { type: "integer", example: 2 },
      openReports: { type: "integer", example: 3 },
      createdAt: { type: "string", format: "date-time" },
    },
    required: [
      "joinPolicy",
      "type",
      "memberCount",
      "inviteLinksActive",
      "openReports",
      "createdAt",
    ],
  },
  AdminCommunityDetail: {
    type: "object",
    description:
      "Full community detail returned by GET /admin/v1/communities/{communityId}.",
    properties: {
      community: {
        type: "object",
        properties: {
          communityId: { type: "string", example: "comm_001" },
          name: { type: "string", example: "Hanoi Foodies" },
          handle: { type: "string", example: "hanoi-foodies" },
          description: { type: "string", nullable: true },
          type: { $ref: "#/components/schemas/AdminCommunityType" },
          category: { $ref: "#/components/schemas/AdminCommunityCategoryRef" },
          status: {
            $ref: "#/components/schemas/AdminCommunityModerationStatus",
          },
          avatarUrl: { type: "string", nullable: true },
          coverUrl: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          lastActivityAt: { type: "string", format: "date-time" },
        },
        required: [
          "communityId",
          "name",
          "handle",
          "description",
          "type",
          "category",
          "status",
          "avatarUrl",
          "coverUrl",
          "createdAt",
          "lastActivityAt",
        ],
      },
      owner: { $ref: "#/components/schemas/AdminCommunityOwner" },
      memberStats: { $ref: "#/components/schemas/AdminCommunityMemberStats" },
      livestreamStats: {
        oneOf: [{ $ref: "#/components/schemas/AdminCommunityLivestreamStats" }],
        nullable: true,
      },
      moderationHistory: {
        type: "array",
        items: {
          $ref: "#/components/schemas/AdminCommunityModerationHistoryItem",
        },
      },
      settingsSummary: {
        $ref: "#/components/schemas/AdminCommunitySettingsSummary",
      },
      partial: {
        type: "boolean",
        description:
          "True when one or more upstream sources (stream/user) could not be reached.",
        example: false,
      },
    },
    required: [
      "community",
      "owner",
      "memberStats",
      "livestreamStats",
      "moderationHistory",
      "settingsSummary",
      "partial",
    ],
  },
  AdminCommunityDetailResponse: {
    type: "object",
    properties: {
      success: { type: "boolean", example: true },
      data: { $ref: "#/components/schemas/AdminCommunityDetail" },
      meta: { $ref: "#/components/schemas/AdminResponseMeta" },
    },
    required: ["success", "data", "meta"],
  },
  AdminCommunityCloseRequest: {
    type: "object",
    required: ["reasonCode"],
    properties: {
      reasonCode: {
        $ref: "#/components/schemas/AdminCommunityCloseReasonCode",
      },
      reasonNote: {
        type: "string",
        maxLength: 2000,
        example: "Repeated guideline violations",
      },
      notifyOwner: { type: "boolean", default: true, example: true },
    },
  },
  AdminCommunityReopenRequest: {
    type: "object",
    properties: {
      reasonNote: {
        type: "string",
        maxLength: 2000,
        example: "Appeal accepted",
      },
      notifyOwner: { type: "boolean", default: true, example: true },
    },
  },
  AdminCommunityBulkCloseRequest: {
    type: "object",
    required: ["reasonCode", "communityIds"],
    properties: {
      communityIds: {
        type: "array",
        items: { type: "string", maxLength: 64 },
        minItems: 1,
        maxItems: 100,
        example: ["comm_001", "comm_002"],
      },
      reasonCode: {
        $ref: "#/components/schemas/AdminCommunityCloseReasonCode",
      },
      reasonNote: { type: "string", maxLength: 2000 },
      notifyOwner: { type: "boolean", default: true },
    },
  },
  AdminCommunityBulkReopenRequest: {
    type: "object",
    required: ["communityIds"],
    properties: {
      communityIds: {
        type: "array",
        items: { type: "string", maxLength: 64 },
        minItems: 1,
        maxItems: 100,
        example: ["comm_001", "comm_002"],
      },
      reasonNote: { type: "string", maxLength: 2000 },
      notifyOwner: { type: "boolean", default: true },
    },
  },
  AdminCommunityCloseResult: {
    type: "object",
    description: "200 response data for a single close action.",
    properties: {
      success: { type: "boolean", example: true },
      data: {
        type: "object",
        properties: {
          communityId: { type: "string", example: "comm_001" },
          status: {
            $ref: "#/components/schemas/AdminCommunityModerationStatus",
          },
          closedAt: { type: "string", format: "date-time" },
          reasonCode: {
            $ref: "#/components/schemas/AdminCommunityCloseReasonCode",
          },
          moderationActionId: { type: "string", example: "ma_01HZX" },
          auditLogId: { type: "string", example: "al_01HZX" },
        },
        required: [
          "communityId",
          "status",
          "closedAt",
          "reasonCode",
          "moderationActionId",
          "auditLogId",
        ],
      },
      meta: { $ref: "#/components/schemas/AdminResponseMeta" },
    },
    required: ["success", "data", "meta"],
  },
  AdminCommunityReopenResult: {
    type: "object",
    description: "200 response data for a single reopen action.",
    properties: {
      success: { type: "boolean", example: true },
      data: {
        type: "object",
        properties: {
          communityId: { type: "string", example: "comm_001" },
          status: {
            $ref: "#/components/schemas/AdminCommunityModerationStatus",
          },
          reopenedAt: { type: "string", format: "date-time" },
          moderationActionId: { type: "string", example: "ma_01HZX" },
          auditLogId: { type: "string", example: "al_01HZX" },
        },
        required: [
          "communityId",
          "status",
          "reopenedAt",
          "moderationActionId",
          "auditLogId",
        ],
      },
      meta: { $ref: "#/components/schemas/AdminResponseMeta" },
    },
    required: ["success", "data", "meta"],
  },
  AdminCommunityBulkResult: {
    type: "object",
    description:
      "207 Multi-Status — per-item close/reopen outcome; partial success is normal.",
    properties: {
      success: { type: "boolean", example: true },
      data: {
        type: "object",
        properties: {
          requested: { type: "integer", example: 3 },
          succeeded: { type: "integer", example: 2 },
          failed: { type: "integer", example: 1 },
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                communityId: { type: "string", example: "comm_002" },
                status: {
                  $ref: "#/components/schemas/AdminCommunityModerationStatus",
                },
                ok: { type: "boolean", example: false },
                error: {
                  type: "object",
                  nullable: true,
                  properties: {
                    code: {
                      type: "string",
                      description:
                        "COMMUNITY_ALREADY_CLOSED | COMMUNITY_NOT_CLOSED | COMMUNITY_NOT_FOUND | BULK_ITEM_FAILED.",
                      example: "COMMUNITY_ALREADY_CLOSED",
                    },
                    message: { type: "string" },
                  },
                  required: ["code", "message"],
                },
              },
              required: ["communityId", "ok"],
            },
          },
        },
        required: ["requested", "succeeded", "failed", "results"],
      },
      meta: { $ref: "#/components/schemas/AdminResponseMeta" },
    },
    required: ["success", "data", "meta"],
  },

  // ---- Groups ----
  AdminGroup: {
    type: "object",
    description: "Maps to a chat-service GroupRoom.",
    properties: {
      id: { type: "string", example: "grp_9a" },
      name: { type: "string", example: "Project X" },
      createdBy: { type: "string", example: "u_8f3a" },
      memberCount: { type: "integer", example: 12 },
      status: {
        type: "string",
        enum: ["active", "suspended", "disbanded"],
        example: "active",
      },
      disbandedAt: { type: "string", format: "date-time", nullable: true },
      createdAt: { type: "string", format: "date-time" },
    },
    required: ["id", "name", "status"],
  },
  AdminModerateRequest: {
    type: "object",
    required: ["reason"],
    properties: {
      reason: { type: "string", example: "Policy violation" },
      durationDays: { type: "integer", nullable: true, example: 7 },
    },
  },

  // ---- Reports & Moderation ----
  AdminReport: {
    type: "object",
    properties: {
      id: { type: "string", example: "r_12" },
      type: {
        type: "string",
        enum: ["user", "community", "message", "stream"],
        example: "message",
      },
      status: {
        type: "string",
        enum: ["open", "reviewing", "resolved", "dismissed"],
        example: "open",
      },
      priority: {
        type: "string",
        enum: ["low", "normal", "high", "urgent"],
        nullable: true,
        example: "high",
      },
      reporterId: { type: "string", example: "u_aa" },
      targetType: { type: "string", example: "message" },
      targetId: { type: "string", example: "m_99" },
      assigneeId: { type: "string", nullable: true },
      createdAt: { type: "string", format: "date-time" },
    },
    required: ["id", "type", "status"],
  },
  AdminReportAssignRequest: {
    type: "object",
    required: ["assigneeId"],
    properties: { assigneeId: { type: "string", example: "adm_5" } },
  },
  AdminReportStatusRequest: {
    type: "object",
    required: ["status"],
    properties: {
      status: {
        type: "string",
        enum: ["open", "reviewing", "resolved", "dismissed"],
        example: "reviewing",
      },
    },
  },
  AdminReportNoteRequest: {
    type: "object",
    required: ["note"],
    properties: {
      note: { type: "string", example: "Reviewed message context." },
    },
  },
  AdminReportAction: {
    type: "object",
    description:
      "Take action on a report — creates a ModerationAction and emits the matching admin.* event in one transaction.",
    required: ["decision"],
    properties: {
      decision: {
        type: "string",
        enum: [
          "ban_user",
          "suspend_user",
          "delete_content",
          "suspend_community",
          "dismiss",
        ],
        example: "ban_user",
      },
      targetId: { type: "string", example: "u_8f3a" },
      reason: { type: "string", example: "Spam" },
      resolveReport: { type: "boolean", example: true },
    },
  },
  AdminReportActionResult: {
    type: "object",
    properties: {
      reportId: { type: "string", example: "r_12" },
      status: { type: "string", example: "resolved" },
      moderationActionId: { type: "string", example: "ma_79" },
      emittedEvent: { type: "string", example: "admin.user_banned" },
    },
  },

  // ---- Reports & Moderation v1 (Reports & Moderation page — see
  //      docs/REPORTS-MODERATION-API-SPEC.md). Phase 1 = static/mock data
  //      behind the real contract; Phase 2 swaps the data source only. ----
  AdminModerationPagination: {
    type: "object",
    description:
      "Hybrid pagination: offset by default (page/limit) with an opt-in keyset `cursor`. `total` is exact when cheap to compute, else null; `totalApprox` is always present. `nextCursor` is only emitted when sorting by createdAt.",
    properties: {
      mode: { type: "string", enum: ["offset", "keyset"], example: "offset" },
      page: { type: "integer", example: 1 },
      limit: { type: "integer", example: 20 },
      total: { type: "integer", nullable: true, example: 1284 },
      totalApprox: { type: "integer", example: 1284 },
      totalPages: { type: "integer", example: 65 },
      hasNext: { type: "boolean", example: true },
      hasPrev: { type: "boolean", example: false },
      nextCursor: {
        type: "string",
        nullable: true,
        example: "eyJjcmVhdGVkQXQiOiIyMD...",
      },
    },
    required: [
      "mode",
      "page",
      "limit",
      "totalApprox",
      "totalPages",
      "hasNext",
      "hasPrev",
    ],
  },
  AdminResponseMeta: {
    type: "object",
    properties: {
      requestId: { type: "string", nullable: true, example: "req_01HZXABC" },
      generatedAt: { type: "string", format: "date-time" },
    },
    required: ["generatedAt"],
  },
  AdminModerationUserRef: {
    type: "object",
    properties: {
      id: { type: "string", example: "u_8f3" },
      username: { type: "string", example: "john_doe" },
      displayName: { type: "string", example: "John Doe" },
      avatarUrl: {
        type: "string",
        nullable: true,
        example: "https://cdn.aimess.app/av/8f3.jpg",
      },
      accountStatus: { type: "string", nullable: true, example: "ACTIVE" },
    },
    required: ["id", "username", "displayName"],
  },
  AdminModeratorRef: {
    type: "object",
    nullable: true,
    properties: {
      id: { type: "string", example: "adm_3" },
      name: { type: "string", example: "Sara Admin" },
    },
    required: ["id", "name"],
  },
  AdminModerationReportType: {
    type: "string",
    enum: [
      "SPAM",
      "HARASSMENT",
      "HATE_SPEECH",
      "NUDITY",
      "VIOLENCE",
      "SELF_HARM",
      "IMPERSONATION",
      "MISINFORMATION",
      "ILLEGAL_CONTENT",
      "CSAM",
      "TERRORISM",
      "OTHER",
    ],
    example: "HARASSMENT",
  },
  AdminModerationTargetType: {
    type: "string",
    enum: ["USER", "MESSAGE", "GROUP", "COMMUNITY", "POST", "COMMENT", "MEDIA"],
    example: "MESSAGE",
  },
  AdminModerationStatus: {
    type: "string",
    enum: ["PENDING", "UNDER_REVIEW", "RESOLVED", "DISMISSED", "ESCALATED"],
    example: "PENDING",
  },
  AdminModerationPriority: {
    type: "string",
    enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
    example: "HIGH",
  },
  AdminModerationReportListItem: {
    type: "object",
    description: "One row of the Reports & Moderation table.",
    properties: {
      reportId: { type: "string", example: "RPT-2026-0001284" },
      reportedUser: { $ref: "#/components/schemas/AdminModerationUserRef" },
      reporterUser: { $ref: "#/components/schemas/AdminModerationUserRef" },
      reportType: { $ref: "#/components/schemas/AdminModerationReportType" },
      targetType: { $ref: "#/components/schemas/AdminModerationTargetType" },
      status: { $ref: "#/components/schemas/AdminModerationStatus" },
      priority: { $ref: "#/components/schemas/AdminModerationPriority" },
      createdAt: { type: "string", format: "date-time" },
      resolvedAt: { type: "string", format: "date-time", nullable: true },
      moderator: { $ref: "#/components/schemas/AdminModeratorRef" },
    },
    required: [
      "reportId",
      "reportedUser",
      "reporterUser",
      "reportType",
      "targetType",
      "status",
      "priority",
      "createdAt",
    ],
  },
  AdminModerationListResponse: {
    type: "object",
    description:
      "List envelope for the moderation table: data[] + pagination + meta.",
    properties: {
      success: { type: "boolean", example: true },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/AdminModerationReportListItem" },
      },
      pagination: { $ref: "#/components/schemas/AdminModerationPagination" },
      meta: { $ref: "#/components/schemas/AdminResponseMeta" },
    },
    required: ["success", "data", "pagination", "meta"],
  },
  AdminModerationEvidence: {
    type: "object",
    properties: {
      id: { type: "string", example: "ev_2" },
      type: {
        type: "string",
        enum: [
          "MESSAGE_SNAPSHOT",
          "ATTACHMENT",
          "SCREENSHOT",
          "PROFILE_SNAPSHOT",
          "LINK",
          "SYSTEM_LOG",
        ],
        example: "ATTACHMENT",
      },
      mimeType: { type: "string", nullable: true, example: "image/jpeg" },
      url: {
        type: "string",
        nullable: true,
        description: "Signed, short-TTL URL — never a public CDN link.",
        example: "https://cdn.aimess.app/evidence/ev_2.jpg",
      },
      thumbnailUrl: { type: "string", nullable: true },
      sizeBytes: { type: "integer", nullable: true, example: 84213 },
      content: {
        type: "object",
        nullable: true,
        description:
          "Inline snapshot payload (e.g. message text) for non-binary evidence.",
      },
      restricted: {
        type: "boolean",
        description:
          "CSAM/illegal — gated behind moderation:reports:evidence:restricted:view + access-logged.",
        example: false,
      },
      capturedAt: { type: "string", format: "date-time" },
    },
    required: ["id", "type", "capturedAt"],
  },
  AdminModerationHistoryItem: {
    type: "object",
    properties: {
      id: { type: "string", example: "h_2" },
      action: { type: "string", example: "ASSIGNED" },
      actorType: {
        type: "string",
        enum: ["USER", "ADMIN", "SYSTEM"],
        example: "ADMIN",
      },
      actorId: { type: "string", nullable: true, example: "adm_3" },
      actorName: { type: "string", nullable: true, example: "Sara Admin" },
      at: { type: "string", format: "date-time" },
      note: { type: "string", nullable: true },
    },
    required: ["id", "action", "actorType", "at"],
  },
  AdminModerationReportDetail: {
    type: "object",
    description: "Full report detail for the View Report Details drawer.",
    properties: {
      reportId: { type: "string", example: "RPT-2026-0001284" },
      reportType: { $ref: "#/components/schemas/AdminModerationReportType" },
      targetType: { $ref: "#/components/schemas/AdminModerationTargetType" },
      status: { $ref: "#/components/schemas/AdminModerationStatus" },
      priority: { $ref: "#/components/schemas/AdminModerationPriority" },
      reason: {
        type: "string",
        example: "Sending threatening messages repeatedly",
      },
      reporterNote: { type: "string", nullable: true },
      sourceService: { type: "string", example: "messaging-service" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      resolvedAt: { type: "string", format: "date-time", nullable: true },
      slaDueAt: { type: "string", format: "date-time", nullable: true },
      reportedUser: {
        type: "object",
        description: "Enriched reported-user profile with moderation signals.",
      },
      reporterUser: {
        type: "object",
        description:
          "Enriched reporter profile with moderation signals (falseReportRate, etc.).",
      },
      target: {
        type: "object",
        description:
          "The reported entity (message/post/user) snapshot + deep link.",
      },
      evidence: {
        type: "array",
        items: { $ref: "#/components/schemas/AdminModerationEvidence" },
      },
      history: {
        type: "array",
        items: { $ref: "#/components/schemas/AdminModerationHistoryItem" },
      },
      relatedReports: { type: "array", items: { type: "object" } },
      availableActions: {
        type: "array",
        items: {
          type: "string",
          enum: ["RESOLVE", "DISMISS", "ESCALATE", "ASSIGN"],
        },
        description:
          "Server-computed from status + the admin's RBAC. The UI must not hardcode this.",
      },
    },
    required: [
      "reportId",
      "reportType",
      "targetType",
      "status",
      "priority",
      "reason",
      "createdAt",
      "reportedUser",
      "reporterUser",
      "evidence",
      "history",
      "availableActions",
    ],
  },
  AdminResolveReportRequest: {
    type: "object",
    description:
      "Resolve a report. The enforcement action is recorded as a decision and emitted as `moderation.action.requested` (RabbitMQ) — auth/user-service own actual account state.",
    required: ["resolution"],
    properties: {
      resolution: {
        type: "string",
        enum: ["ACTION_TAKEN", "WARNING_ISSUED", "CONTENT_REMOVED"],
        example: "ACTION_TAKEN",
      },
      actionOnReportedUser: {
        type: "string",
        enum: [
          "NONE",
          "WARN",
          "CONTENT_REMOVE",
          "MUTE",
          "SUSPEND_7D",
          "SUSPEND_30D",
          "BAN",
        ],
        default: "NONE",
        example: "SUSPEND_7D",
      },
      note: { type: "string", maxLength: 2000 },
      notifyReporter: { type: "boolean", default: false },
      notifyReportedUser: { type: "boolean", default: false },
    },
  },
  AdminDismissReportRequest: {
    type: "object",
    required: ["reason"],
    properties: {
      reason: {
        type: "string",
        enum: [
          "NO_VIOLATION",
          "INSUFFICIENT_EVIDENCE",
          "DUPLICATE",
          "FALSE_REPORT",
        ],
        example: "NO_VIOLATION",
      },
      note: { type: "string", maxLength: 2000 },
      notifyReporter: { type: "boolean", default: false },
      flagFalseReport: {
        type: "boolean",
        default: false,
        description:
          "Phase 1: captured in the audit trail but not yet persisted to a reporter-reputation store.",
      },
    },
  },
  AdminModerationActionResult: {
    type: "object",
    description: "Result of resolve/dismiss.",
    properties: {
      reportId: { type: "string", example: "RPT-2026-0001284" },
      status: { $ref: "#/components/schemas/AdminModerationStatus" },
      resolution: { type: "string", nullable: true, example: "ACTION_TAKEN" },
      dismissReason: { type: "string", nullable: true },
      resolvedAt: { type: "string", format: "date-time" },
      moderator: { $ref: "#/components/schemas/AdminModeratorRef" },
      appliedActions: {
        type: "array",
        nullable: true,
        items: {
          type: "object",
          properties: {
            type: { type: "string", example: "SUSPEND_7D" },
            targetUserId: { type: "string", example: "u_8f3" },
            effectiveUntil: {
              type: "string",
              format: "date-time",
              nullable: true,
            },
          },
        },
      },
    },
    required: ["reportId", "status", "resolvedAt", "moderator"],
  },
  AdminBulkResolveRequest: {
    type: "object",
    required: ["reportIds", "resolution"],
    properties: {
      reportIds: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 100,
        example: ["RPT-2026-0001284", "RPT-2026-0001280"],
      },
      resolution: {
        type: "string",
        enum: ["ACTION_TAKEN", "WARNING_ISSUED", "CONTENT_REMOVED"],
        example: "CONTENT_REMOVED",
      },
      actionOnReportedUser: {
        type: "string",
        enum: [
          "NONE",
          "WARN",
          "CONTENT_REMOVE",
          "MUTE",
          "SUSPEND_7D",
          "SUSPEND_30D",
          "BAN",
        ],
        default: "NONE",
      },
      note: { type: "string", maxLength: 2000 },
      notifyReporter: { type: "boolean", default: false },
    },
  },
  AdminBulkDismissRequest: {
    type: "object",
    required: ["reportIds", "reason"],
    properties: {
      reportIds: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 100,
      },
      reason: {
        type: "string",
        enum: [
          "NO_VIOLATION",
          "INSUFFICIENT_EVIDENCE",
          "DUPLICATE",
          "FALSE_REPORT",
        ],
      },
      note: { type: "string", maxLength: 2000 },
      notifyReporter: { type: "boolean", default: false },
      flagFalseReport: { type: "boolean", default: false },
    },
  },
  AdminBulkActionResult: {
    type: "object",
    description:
      "207 Multi-Status — per-item outcome; partial success is normal.",
    properties: {
      success: { type: "boolean", example: true },
      data: {
        type: "object",
        properties: {
          requested: { type: "integer", example: 3 },
          succeeded: { type: "integer", example: 2 },
          failed: { type: "integer", example: 1 },
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                reportId: { type: "string", example: "RPT-2026-0001277" },
                status: { $ref: "#/components/schemas/AdminModerationStatus" },
                ok: { type: "boolean", example: false },
                error: {
                  type: "object",
                  nullable: true,
                  properties: {
                    code: {
                      type: "string",
                      example: "REPORT_ALREADY_RESOLVED",
                    },
                    message: { type: "string" },
                  },
                },
              },
              required: ["reportId", "ok"],
            },
          },
        },
        required: ["requested", "succeeded", "failed", "results"],
      },
      meta: { $ref: "#/components/schemas/AdminResponseMeta" },
    },
    required: ["success", "data"],
  },

  // ---- Livestreams ----
  AdminLivestream: {
    type: "object",
    properties: {
      id: { type: "string", example: "ls_3" },
      title: { type: "string", nullable: true },
      status: {
        type: "string",
        enum: ["live", "ended", "scheduled"],
        example: "live",
      },
      communityId: { type: "string", nullable: true },
      hostId: { type: "string", example: "u_8f3a" },
      viewers: { type: "integer", example: 134 },
      startedAt: { type: "string", format: "date-time", nullable: true },
    },
    required: ["id", "status"],
  },
  AdminForceEndRequest: {
    type: "object",
    properties: { reason: { type: "string", example: "Policy violation" } },
  },

  // ---- Announcements ----
  AdminAnnouncementTranslationInput: {
    type: "object",
    properties: {
      title: { type: "string", example: "Scheduled maintenance" },
      body: { type: "string", example: "We will be down 02:00–03:00 UTC." },
    },
    required: ["title", "body"],
  },
  AdminAnnouncement: {
    type: "object",
    properties: {
      id: { type: "string", example: "an_5" },
      status: {
        type: "string",
        enum: ["draft", "scheduled", "published"],
        example: "draft",
      },
      audience: {
        type: "string",
        enum: ["all", "community", "role"],
        example: "all",
      },
      publishAt: { type: "string", format: "date-time", nullable: true },
      translations: {
        type: "object",
        properties: {
          en: {
            $ref: "#/components/schemas/AdminAnnouncementTranslationInput",
          },
          vi: {
            $ref: "#/components/schemas/AdminAnnouncementTranslationInput",
          },
        },
      },
      createdAt: { type: "string", format: "date-time" },
    },
    required: ["id", "status"],
  },
  AdminAnnouncementCreateRequest: {
    type: "object",
    required: ["translations", "audience"],
    properties: {
      translations: {
        type: "object",
        properties: {
          en: {
            $ref: "#/components/schemas/AdminAnnouncementTranslationInput",
          },
          vi: {
            $ref: "#/components/schemas/AdminAnnouncementTranslationInput",
          },
        },
      },
      audience: {
        type: "string",
        enum: ["all", "community", "role"],
        example: "all",
      },
      publishAt: { type: "string", format: "date-time", nullable: true },
    },
  },
  AdminAnnouncementUpdateRequest: {
    type: "object",
    properties: {
      translations: {
        type: "object",
        properties: {
          en: {
            $ref: "#/components/schemas/AdminAnnouncementTranslationInput",
          },
          vi: {
            $ref: "#/components/schemas/AdminAnnouncementTranslationInput",
          },
        },
      },
      audience: { type: "string", enum: ["all", "community", "role"] },
      publishAt: { type: "string", format: "date-time", nullable: true },
    },
  },

  // ---- Categories ----
  AdminCategory: {
    type: "object",
    properties: {
      id: { type: "string", example: "cat_food" },
      name: {
        type: "object",
        description: "Localized name per locale.",
        example: { en: "Food", vi: "Ẩm thực" },
      },
      icon: { type: "string", nullable: true, example: "utensils" },
      order: { type: "integer", example: 1 },
    },
    required: ["id", "name"],
  },
  AdminCategoryCreateRequest: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "object", example: { en: "Food", vi: "Ẩm thực" } },
      icon: { type: "string", nullable: true, example: "utensils" },
      order: { type: "integer", example: 1 },
    },
  },
  AdminCategoryUpdateRequest: {
    type: "object",
    properties: {
      name: { type: "object", example: { en: "Food", vi: "Ẩm thực" } },
      icon: { type: "string", nullable: true },
      order: { type: "integer" },
    },
  },

  // ---- Audit Logs ----
  AdminAuditLog: {
    type: "object",
    properties: {
      id: { type: "string", example: "al_900" },
      actorId: { type: "string", example: "adm_1" },
      actorEmail: { type: "string", example: "ops@x.com" },
      action: { type: "string", example: "user.ban" },
      targetType: { type: "string", example: "user" },
      targetId: { type: "string", example: "u_8f3a" },
      before: { type: "object", nullable: true, example: { status: "active" } },
      after: { type: "object", nullable: true, example: { status: "banned" } },
      ip: { type: "string", example: "203.0.113.7" },
      userAgent: { type: "string", nullable: true },
      createdAt: { type: "string", format: "date-time" },
    },
    required: ["id", "actorId", "action", "targetType", "createdAt"],
  },
  AdminAuditLogExport: {
    type: "object",
    properties: {
      format: { type: "string", enum: ["csv", "json"], example: "csv" },
      downloadUrl: {
        type: "string",
        description: "Presigned MinIO URL (private bucket) for large exports.",
      },
      expiresAt: { type: "string", format: "date-time" },
    },
  },

  // ---- Admin Accounts & Roles ----
  AdminAccount: {
    type: "object",
    properties: {
      id: { type: "string", example: "adm_5" },
      email: { type: "string", format: "email", example: "mod@aimess.io" },
      name: { type: "string", example: "Mod User" },
      role: {
        type: "string",
        enum: ["SUPER_ADMIN", "ADMIN", "MODERATOR", "SUPPORT_AGENT", "ANALYST"],
        example: "MODERATOR",
      },
      status: {
        type: "string",
        enum: ["ACTIVE", "DISABLED", "INVITED"],
        example: "ACTIVE",
      },
      totpEnabled: { type: "boolean", example: true },
      lastLoginAt: { type: "string", format: "date-time", nullable: true },
      createdAt: { type: "string", format: "date-time" },
    },
    required: ["id", "email", "role", "status"],
  },
  AdminAccountCreateRequest: {
    type: "object",
    required: ["email", "name", "role"],
    properties: {
      email: { type: "string", format: "email", example: "mod@aimess.io" },
      name: { type: "string", example: "Mod User" },
      role: {
        type: "string",
        enum: ["SUPER_ADMIN", "ADMIN", "MODERATOR", "SUPPORT_AGENT", "ANALYST"],
        example: "MODERATOR",
      },
    },
  },
  AdminAccountRoleRequest: {
    type: "object",
    required: ["role"],
    properties: {
      role: {
        type: "string",
        enum: ["SUPER_ADMIN", "ADMIN", "MODERATOR", "SUPPORT_AGENT", "ANALYST"],
        example: "MODERATOR",
      },
    },
  },
  AdminRole: {
    type: "object",
    properties: {
      key: {
        type: "string",
        enum: ["SUPER_ADMIN", "ADMIN", "MODERATOR", "SUPPORT_AGENT", "ANALYST"],
        example: "MODERATOR",
      },
      name: { type: "string", example: "Moderator" },
      description: { type: "string", nullable: true },
      permissions: {
        type: "array",
        items: { type: "string" },
        example: ["dashboard.read", "users.read", "users.moderate"],
      },
    },
    required: ["key", "permissions"],
  },

  // ---- System Health ----
  AdminSystemQueues: {
    type: "object",
    properties: {
      queues: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", example: "aimess.events" },
            depth: { type: "integer", example: 4 },
            dlqDepth: { type: "integer", example: 0 },
          },
        },
      },
      checkedAt: { type: "string", format: "date-time" },
    },
  },
  AdminSystemMetrics: {
    type: "object",
    description: "Aggregate platform metrics snapshot (read-model + redis).",
    properties: {
      metrics: { type: "object" },
      asOf: { type: "string", format: "date-time" },
    },
  },

  ApiSuccessResponse: {
    type: "object",
    properties: {
      success: { type: "boolean", example: true },
      message: { type: "string", example: "Đăng ký thành công" },
      data: { type: "object" },
    },
    required: ["success"],
  },
  ApiErrorResponse: {
    type: "object",
    properties: {
      success: { type: "boolean", example: false },
      message: {
        type: "string",
        example: "Tài khoản hoặc mật khẩu không đúng",
      },
      errors: { type: "object", description: "Present on validation errors" },
    },
    required: ["success", "message"],
  },
  AuthUser: {
    type: "object",
    properties: {
      userId: { type: "string", format: "uuid" },
      account: { type: "string", example: "johndoe" },
      createdAt: { type: "string", format: "date-time" },
    },
    required: ["userId", "account"],
  },
  AuthTokens: {
    type: "object",
    properties: {
      accessToken: { type: "string" },
      refreshToken: { type: "string" },
      accessTokenExpiresIn: { type: "integer", example: 3600 },
      refreshTokenExpiresIn: { type: "integer", example: 604800 },
    },
    required: [
      "accessToken",
      "refreshToken",
      "accessTokenExpiresIn",
      "refreshTokenExpiresIn",
    ],
  },
  FcmTokens: {
    type: "array",
    items: { type: "string", minLength: 1 },
    description:
      "FCM device push tokens. Optional — omit or send an empty array when the device has no push token.",
    example: ["fcm-token-abc123"],
  },
  RegisterRequest: {
    type: "object",
    properties: {
      account: {
        type: "string",
        minLength: 3,
        maxLength: 32,
        pattern: "^[a-z0-9_]+$",
        example: "johndoe",
      },
      password: { type: "string", minLength: 8, maxLength: 128 },
      fcmTokens: { $ref: "#/components/schemas/FcmTokens" },
    },
    required: ["account", "password"],
  },
  ValidateAccountRequest: {
    type: "object",
    properties: {
      account: {
        type: "string",
        minLength: 3,
        maxLength: 32,
        pattern: "^[a-z0-9_]+$",
        example: "johndoe",
      },
    },
    required: ["account"],
  },
  ValidateAccountResponseData: {
    type: "object",
    properties: {
      account: { type: "string", example: "johndoe" },
      available: { type: "boolean", example: true },
    },
    required: ["account", "available"],
  },
  LoginRequest: {
    type: "object",
    properties: {
      account: {
        type: "string",
        description:
          "Username (`account`) or verified linked email. Email login requires `emailVerified` on the account.",
        example: "johndoe",
      },
      password: { type: "string", minLength: 8, maxLength: 128 },
      rememberMe: {
        type: "boolean",
        default: false,
        description:
          "When true, the issued refresh token is longer-lived (30 days) so the session persists across app restarts. Access-token lifetime is unchanged.",
      },
      fcmTokens: { $ref: "#/components/schemas/FcmTokens" },
    },
    required: ["account", "password"],
  },
  RegisterResponseData: {
    type: "object",
    properties: {
      user: {
        allOf: [
          { $ref: "#/components/schemas/AuthUser" },
          {
            type: "object",
            required: ["createdAt"],
          },
        ],
      },
      tokens: { $ref: "#/components/schemas/AuthTokens" },
    },
    required: ["user", "tokens"],
  },
  LoginResponseData: {
    type: "object",
    properties: {
      tokens: { $ref: "#/components/schemas/AuthTokens" },
      isProfileCompleted: {
        type: "boolean",
        description:
          "Whether the user has filled in their required profile fields (username, firstName, lastName — all must be non-empty). Lets the client route to the edit-profile screen on first login. Mirrored from user-service via the user.profile_updated event.",
      },
    },
    required: ["tokens", "isProfileCompleted"],
  },
  AccessTokenResponseData: {
    type: "object",
    properties: {
      accessToken: { type: "string" },
      accessTokenExpiresIn: { type: "integer", example: 900 },
    },
    required: ["accessToken", "accessTokenExpiresIn"],
  },
  RefreshTokenRequest: {
    type: "object",
    properties: {
      refreshToken: {
        type: "string",
        description:
          "Refresh token from login, register, or a previous refresh",
      },
    },
    required: ["refreshToken"],
  },
  ActiveSession: {
    type: "object",
    properties: {
      sessionId: { type: "string", format: "uuid" },
      deviceId: { type: "string", example: "device-abc-123" },
      deviceName: {
        type: "string",
        nullable: true,
        example: "Pixel 8 — Hanoi",
      },
      deviceType: {
        type: "string",
        enum: ["IOS", "ANDROID", "WEB", "DESKTOP"],
      },
      osVersion: { type: "string", nullable: true, example: "14" },
      appVersion: { type: "string", nullable: true, example: "1.0.0" },
      ipAddress: { type: "string", nullable: true, example: "203.0.113.1" },
      countryCode: { type: "string", nullable: true, example: "VN" },
      lastActiveAt: { type: "string", format: "date-time" },
      createdAt: { type: "string", format: "date-time" },
      isCurrent: {
        type: "boolean",
        description:
          "True for the session tied to the access token used for this request",
      },
    },
    required: [
      "sessionId",
      "deviceId",
      "deviceType",
      "lastActiveAt",
      "createdAt",
      "isCurrent",
    ],
  },
  ListSessionsResponseData: {
    type: "object",
    properties: {
      sessions: {
        type: "array",
        items: { $ref: "#/components/schemas/ActiveSession" },
      },
    },
    required: ["sessions"],
  },
  RevokeSessionsResponseData: {
    type: "object",
    properties: {
      revokedCount: {
        type: "integer",
        description: "Number of sessions revoked",
        example: 2,
      },
    },
    required: ["revokedCount"],
  },
  ForgotPasswordRequest: {
    type: "object",
    properties: {
      email: { type: "string", format: "email", example: "user@example.com" },
    },
    required: ["email"],
  },
  ForgotPasswordVerifyRequest: {
    type: "object",
    properties: {
      email: { type: "string", format: "email", example: "user@example.com" },
      code: { type: "string", pattern: "^\\d{6}$", example: "123456" },
    },
    required: ["email", "code"],
  },
  ForgotPasswordResetRequest: {
    type: "object",
    properties: {
      resetToken: { type: "string", minLength: 32 },
      password: { type: "string", minLength: 8, maxLength: 128 },
    },
    required: ["resetToken", "password"],
  },
  ForgotPasswordVerifyResponseData: {
    type: "object",
    properties: {
      resetToken: { type: "string" },
      resetTokenExpiresIn: { type: "integer", example: 900 },
    },
    required: ["resetToken", "resetTokenExpiresIn"],
  },
  GoogleLoginRequest: {
    type: "object",
    properties: {
      idToken: {
        type: "string",
        description:
          "Google ID token obtained from the client's Google Sign-In flow (verified server-side against the configured Google OAuth client id).",
      },
      fcmTokens: { $ref: "#/components/schemas/FcmTokens" },
    },
    required: ["idToken"],
  },
  AppleLoginRequest: {
    type: "object",
    properties: {
      identityToken: {
        type: "string",
        description:
          "Apple identity token (`identityToken` from ASAuthorizationAppleIDCredential on iOS, or `id_token` from Sign in with Apple JS on web). Verified directly against Apple's JWKS at https://appleid.apple.com/auth/keys.",
      },
      email: {
        type: "string",
        format: "email",
        description:
          "Optional. Apple only includes `email` in the identity token on the FIRST authorization; clients should cache it and resend on subsequent logins. Never trusted as verified — used only as a display fallback.",
      },
      fullName: { type: "string", maxLength: 100 },
    },
    required: ["identityToken"],
  },
  LinkEmailRequest: {
    type: "object",
    properties: {
      email: { type: "string", format: "email", example: "user@example.com" },
    },
    required: ["email"],
  },
  LinkEmailVerifyRequest: {
    type: "object",
    properties: {
      email: { type: "string", format: "email", example: "user@example.com" },
      code: { type: "string", pattern: "^\\d{6}$", example: "123456" },
    },
    required: ["email", "code"],
  },
  LinkEmailResponseData: {
    type: "object",
    properties: {
      userId: { type: "string", format: "uuid" },
      emailVerified: { type: "boolean", example: true },
    },
    required: ["userId", "emailVerified"],
  },
  ChangeEmailRequest: {
    type: "object",
    properties: {
      oldEmail: { type: "string", format: "email" },
      newEmail: { type: "string", format: "email" },
    },
    required: ["oldEmail", "newEmail"],
  },
  ChangeEmailVerifyRequest: {
    type: "object",
    properties: {
      oldEmail: { type: "string", format: "email" },
      newEmail: { type: "string", format: "email" },
      code: { type: "string", pattern: "^\\d{6}$", example: "123456" },
    },
    required: ["oldEmail", "newEmail", "code"],
  },
  ChangeEmailResponseData: {
    type: "object",
    properties: {
      userId: { type: "string", format: "uuid" },
      emailVerified: { type: "boolean", example: true },
    },
    required: ["userId", "emailVerified"],
  },
  ChangePasswordRequest: {
    type: "object",
    properties: {
      currentPassword: { type: "string", minLength: 8 },
      newPassword: { type: "string", minLength: 8 },
    },
    required: ["currentPassword", "newPassword"],
  },
  LinkGoogleRequest: {
    type: "object",
    properties: {
      idToken: {
        type: "string",
        description:
          "Google ID token from the client's Google Sign-In flow (verified server-side against the configured Google OAuth client id).",
      },
    },
    required: ["idToken"],
  },
  LinkAppleRequest: {
    type: "object",
    properties: {
      identityToken: {
        type: "string",
        description:
          "Apple identity token from Sign in with Apple. Verified directly against Apple's JWKS.",
      },
      email: { type: "string", format: "email" },
      fullName: { type: "string", maxLength: 100 },
    },
    required: ["identityToken"],
  },
  UnlinkSocialRequest: {
    type: "object",
    properties: {
      provider: { type: "string", enum: ["GOOGLE", "APPLE"] },
    },
    required: ["provider"],
  },
  SocialLinkResponseData: {
    type: "object",
    properties: {
      provider: { type: "string", enum: ["GOOGLE", "APPLE"] },
    },
    required: ["provider"],
  },
  SocialLoginResponseData: {
    type: "object",
    properties: {
      isNewUser: { type: "boolean" },
      user: {
        type: "object",
        properties: {
          userId: { type: "string", format: "uuid" },
          account: { type: "string" },
          email: { type: "string", format: "email", nullable: true },
          provider: { type: "string", enum: ["GOOGLE", "APPLE"] },
        },
        required: ["userId", "account", "provider"],
      },
      isProfileCompleted: {
        type: "boolean",
        description:
          "Whether the user has filled in their required profile fields. Always false for a brand-new account (isNewUser=true).",
      },
      tokens: { $ref: "#/components/schemas/AuthTokens" },
    },
    required: ["isNewUser", "user", "isProfileCompleted", "tokens"],
  },
  UpdateProfileRequest: {
    type: "object",
    properties: {
      firstName: { type: "string", minLength: 1, maxLength: 50 },
      lastName: { type: "string", minLength: 1, maxLength: 50 },
      username: {
        type: "string",
        minLength: 3,
        maxLength: 32,
        pattern: "^[a-zA-Z0-9_]+$",
        description:
          "Normalized to lowercase for storage; uniqueness is case-insensitive.",
      },
      bio: {
        type: "string",
        maxLength: 280,
        nullable: true,
      },
      dateOfBirth: {
        type: "string",
        format: "date",
        example: "2000-01-15",
        description: "YYYY-MM-DD; must be at least 13 years ago",
      },
      gender: {
        type: "string",
        nullable: true,
        enum: ["MALE", "FEMALE", "NON_BINARY", "PREFER_NOT_TO_SAY", "OTHER"],
      },
      avatarObjectKey: {
        type: "string",
        nullable: true,
        description:
          "MinIO object key after uploading via presigned URL (e.g. avatars/{userId}/{uuid}.jpg). Send null to remove avatar.",
        example: "avatars/550e8400-e29b-41d4-a716-446655440000/a1b2c3d4.jpg",
      },
    },
  },
  GenerateUsernameRequest: {
    type: "object",
    properties: {
      account: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        description: "Auth account from registration/login",
        example: "john_doe",
      },
    },
    required: ["account"],
  },
  GenerateUsernameResponseData: {
    type: "object",
    properties: {
      username: { type: "string", example: "john_doe" },
    },
    required: ["username"],
  },
  ValidateUsernameRequest: {
    type: "object",
    properties: {
      username: {
        type: "string",
        minLength: 3,
        maxLength: 32,
        pattern: "^[a-zA-Z0-9_]+$",
        description:
          "Letters are normalized to lowercase; stored usernames are lowercase.",
        example: "john_doe",
      },
    },
    required: ["username"],
  },
  ValidateUsernameResponseData: {
    type: "object",
    properties: {
      username: {
        type: "string",
        description:
          "Canonical lowercase username used for storage and lookup.",
      },
      available: {
        type: "boolean",
        description:
          "True if the handle is free, or it is already your username (same user id from the token).",
      },
    },
    required: ["username", "available"],
  },
  UserUploadUrlRequest: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["AVATAR"],
        description: "Upload type registered in the user-service.",
      },
      contentType: {
        type: "string",
        enum: ["image/jpeg", "image/png", "image/webp"],
      },
      contentLength: {
        type: "integer",
        minimum: 1,
        description:
          "Exact file size in bytes. Must match the PUT body and not exceed the server max.",
        example: 245678,
      },
    },
    required: ["type", "contentType", "contentLength"],
  },
  UploadUrlResponseData: {
    type: "object",
    properties: {
      uploadUrl: { type: "string", format: "uri" },
      objectKey: { type: "string" },
      uploadExpiresIn: {
        type: "integer",
        example: 900,
        description: "Seconds until uploadUrl expires",
      },
      maxBytes: {
        type: "integer",
        example: 5242880,
        description: "Server max file size in bytes for this upload type",
      },
      headers: {
        type: "object",
        properties: {
          "Content-Type": { type: "string", example: "image/jpeg" },
        },
        required: ["Content-Type"],
      },
    },
    required: [
      "uploadUrl",
      "objectKey",
      "uploadExpiresIn",
      "maxBytes",
      "headers",
    ],
  },
  ConnectedProviderInfo: {
    type: "object",
    properties: {
      provider: { type: "string", enum: ["EMAIL", "GOOGLE", "APPLE"] },
      connected: { type: "boolean" },
      providerUserId: {
        type: "string",
        nullable: true,
        description:
          "Google sub, Apple sub, or primary email when EMAIL is connected.",
      },
      providerEmail: {
        type: "string",
        format: "email",
        nullable: true,
        description:
          "Email from the provider (may differ from primary account email).",
      },
      linkedAt: { type: "string", format: "date-time", nullable: true },
    },
    required: [
      "provider",
      "connected",
      "providerUserId",
      "providerEmail",
      "linkedAt",
    ],
  },
  AuthAccountSummary: {
    type: "object",
    properties: {
      userId: { type: "string", format: "uuid" },
      account: { type: "string" },
      email: {
        type: "string",
        format: "email",
        nullable: true,
        description: "Primary account email from auth.",
      },
      emailVerified: { type: "boolean" },
      hasPassword: { type: "boolean" },
      providers: {
        type: "array",
        items: { $ref: "#/components/schemas/ConnectedProviderInfo" },
      },
    },
    required: [
      "userId",
      "account",
      "email",
      "emailVerified",
      "hasPassword",
      "providers",
    ],
  },
  UserProfileData: {
    type: "object",
    description: "Profile fields (GET/PATCH /profiles/me response).",
    properties: {
      userId: { type: "string", format: "uuid" },
      username: { type: "string" },
      firstName: { type: "string" },
      lastName: { type: "string" },
      bio: { type: "string", nullable: true },
      email: {
        type: "string",
        format: "email",
        nullable: true,
        description: "Primary account email from auth-service.",
      },
      isGoogleLogin: {
        type: "boolean",
        description:
          "True when a GOOGLE provider is linked to the account in auth-service.",
      },
      isAppleLogin: {
        type: "boolean",
        description:
          "True when an APPLE provider is linked to the account in auth-service.",
      },
      dateOfBirth: { type: "string", format: "date" },
      gender: {
        type: "string",
        nullable: true,
        enum: ["MALE", "FEMALE", "NON_BINARY", "PREFER_NOT_TO_SAY", "OTHER"],
      },
      avatarUrl: {
        type: "string",
        format: "uri",
        nullable: true,
        description:
          "Presigned GET URL (private MinIO). Expires after avatarUrlExpiresIn seconds — call GET /profiles/me again to refresh.",
      },
      avatarUrlExpiresIn: {
        type: "integer",
        nullable: true,
        example: 3600,
      },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: [
      "userId",
      "username",
      "firstName",
      "lastName",
      "bio",
      "email",
      "isGoogleLogin",
      "isAppleLogin",
      "dateOfBirth",
      "gender",
      "avatarUrl",
      "avatarUrlExpiresIn",
      "updatedAt",
    ],
  },
  AccountLoadStatus: {
    type: "string",
    enum: ["live", "cached", "unavailable"],
    description:
      "live = from auth-service; cached = auth down, stale Redis copy; unavailable = auth down, no cache (providers is null).",
  },
  ConnectedAccountsResponse: {
    type: "object",
    description:
      "GET /accounts/me — linked sign-in providers (EMAIL, GOOGLE, APPLE).",
    properties: {
      providers: {
        type: "array",
        nullable: true,
        items: { $ref: "#/components/schemas/ConnectedProviderInfo" },
      },
      accountStatus: { $ref: "#/components/schemas/AccountLoadStatus" },
    },
    required: ["providers", "accountStatus"],
  },
  PrivacyScope: {
    type: "string",
    enum: ["EVERYONE", "FRIENDS_OF_FRIENDS", "FRIENDS", "NO_ONE"],
  },
  CallPrivacyScope: {
    type: "string",
    enum: ["FRIENDS", "SELECTED_FRIENDS", "NO_ONE"],
  },
  AutoDeleteTimer: {
    type: "string",
    enum: ["OFF", "DAYS_7", "DAYS_15", "DAYS_30"],
  },
  AppTheme: {
    type: "string",
    enum: ["LIGHT", "DARK", "AUTO"],
    description: '`AUTO` is shown as "System" in the UI.',
  },
  LiveStreamQuality: {
    type: "string",
    enum: ["AUTO", "HIGH_1080P", "STANDARD_720P", "DATA_SAVER_480P"],
    description: "`AUTO` adapts to connection speed (Recommended).",
  },
  UserPrivacySettings: {
    type: "object",
    properties: {
      whoCanFindMe: { $ref: "#/components/schemas/PrivacyScope" },
      whoCanSendFriendRequests: { $ref: "#/components/schemas/PrivacyScope" },
      whoCanSeeOnlineStatus: { $ref: "#/components/schemas/PrivacyScope" },
      whoCanViewProfile: { $ref: "#/components/schemas/PrivacyScope" },
      whoCanCallMe: { $ref: "#/components/schemas/CallPrivacyScope" },
      callAllowedFriendIds: {
        type: "array",
        items: { type: "string", format: "uuid" },
        description:
          "Friends allowed to call when `whoCanCallMe` is `SELECTED_FRIENDS`.",
      },
    },
    required: [
      "whoCanFindMe",
      "whoCanSendFriendRequests",
      "whoCanSeeOnlineStatus",
      "whoCanViewProfile",
      "whoCanCallMe",
      "callAllowedFriendIds",
    ],
  },
  UserChatSettings: {
    type: "object",
    properties: {
      autoDeleteTimer: { $ref: "#/components/schemas/AutoDeleteTimer" },
      typingIndicators: { type: "boolean" },
      readReceipts: { type: "boolean" },
    },
    required: ["autoDeleteTimer", "typingIndicators", "readReceipts"],
  },
  UserAppSettings: {
    type: "object",
    properties: {
      language: {
        type: "string",
        enum: ["en", "vi", "th"],
        example: "en",
        description: "Supported app language (ISO 639-1).",
      },
      theme: { $ref: "#/components/schemas/AppTheme" },
    },
    required: ["language", "theme"],
  },
  QuietHoursSettings: {
    type: "object",
    properties: {
      enabled: { type: "boolean" },
      start: {
        type: "string",
        nullable: true,
        example: "22:00",
        description: "HH:mm 24-hour, or null when unset.",
      },
      end: {
        type: "string",
        nullable: true,
        example: "07:00",
        description: "HH:mm 24-hour, or null when unset.",
      },
      days: {
        type: "array",
        items: { type: "integer", minimum: 0, maximum: 6 },
        description:
          "Days the quiet window applies to; 0=Sunday .. 6=Saturday.",
      },
    },
    required: ["enabled", "start", "end", "days"],
  },
  UserNotificationSettings: {
    type: "object",
    properties: {
      chat: { type: "boolean" },
      call: { type: "boolean" },
      friendRequest: { type: "boolean" },
      system: { type: "boolean" },
      community: { type: "boolean" },
      liveStream: { type: "boolean" },
      quietHours: { $ref: "#/components/schemas/QuietHoursSettings" },
    },
    required: [
      "chat",
      "call",
      "friendRequest",
      "system",
      "community",
      "liveStream",
      "quietHours",
    ],
  },
  UserLiveStreamSettings: {
    type: "object",
    properties: {
      defaultVideoQuality: { $ref: "#/components/schemas/LiveStreamQuality" },
    },
    required: ["defaultVideoQuality"],
  },
  UserSettingsResponse: {
    type: "object",
    description:
      "GET/PATCH /settings/me — privacy, chat, app, notification, and livestream preferences.",
    properties: {
      privacy: { $ref: "#/components/schemas/UserPrivacySettings" },
      chat: { $ref: "#/components/schemas/UserChatSettings" },
      app: { $ref: "#/components/schemas/UserAppSettings" },
      notifications: { $ref: "#/components/schemas/UserNotificationSettings" },
      liveStream: { $ref: "#/components/schemas/UserLiveStreamSettings" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: [
      "privacy",
      "chat",
      "app",
      "notifications",
      "liveStream",
      "updatedAt",
    ],
  },
  UpdateUserPrivacySettingsRequest: {
    type: "object",
    properties: {
      whoCanFindMe: { $ref: "#/components/schemas/PrivacyScope" },
      whoCanSendFriendRequests: { $ref: "#/components/schemas/PrivacyScope" },
      whoCanSeeOnlineStatus: { $ref: "#/components/schemas/PrivacyScope" },
      whoCanViewProfile: { $ref: "#/components/schemas/PrivacyScope" },
      whoCanCallMe: { $ref: "#/components/schemas/CallPrivacyScope" },
      callAllowedFriendIds: {
        type: "array",
        items: { type: "string", format: "uuid" },
        maxItems: 500,
      },
    },
  },
  UpdateUserChatSettingsRequest: {
    type: "object",
    properties: {
      autoDeleteTimer: { $ref: "#/components/schemas/AutoDeleteTimer" },
      typingIndicators: { type: "boolean" },
      readReceipts: { type: "boolean" },
    },
  },
  UpdateUserAppSettingsRequest: {
    type: "object",
    properties: {
      language: { type: "string", enum: ["en", "vi", "th"], example: "en" },
      theme: { $ref: "#/components/schemas/AppTheme" },
    },
  },
  UpdateQuietHoursRequest: {
    type: "object",
    properties: {
      enabled: { type: "boolean" },
      start: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
      end: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
      days: {
        type: "array",
        maxItems: 7,
        items: { type: "integer", minimum: 0, maximum: 6 },
      },
    },
  },
  UpdateUserNotificationSettingsRequest: {
    type: "object",
    properties: {
      chat: { type: "boolean" },
      call: { type: "boolean" },
      friendRequest: { type: "boolean" },
      system: { type: "boolean" },
      community: { type: "boolean" },
      liveStream: { type: "boolean" },
      quietHours: { $ref: "#/components/schemas/UpdateQuietHoursRequest" },
    },
  },
  UpdateUserLiveStreamSettingsRequest: {
    type: "object",
    properties: {
      defaultVideoQuality: { $ref: "#/components/schemas/LiveStreamQuality" },
    },
  },
  UpdateUserSettingsRequest: {
    type: "object",
    description:
      "Partial update — include one or more groups (`privacy`, `chat`, `app`, `notifications`, `liveStream`).",
    properties: {
      privacy: {
        $ref: "#/components/schemas/UpdateUserPrivacySettingsRequest",
      },
      chat: { $ref: "#/components/schemas/UpdateUserChatSettingsRequest" },
      app: { $ref: "#/components/schemas/UpdateUserAppSettingsRequest" },
      notifications: {
        $ref: "#/components/schemas/UpdateUserNotificationSettingsRequest",
      },
      liveStream: {
        $ref: "#/components/schemas/UpdateUserLiveStreamSettingsRequest",
      },
    },
  },
  AppVersionCheckRequest: {
    type: "object",
    properties: {
      platform: {
        type: "string",
        enum: ["android", "ios"],
        example: "android",
      },
      version: {
        type: "string",
        pattern: "^\\d{1,5}\\.\\d{1,5}\\.\\d{1,5}$",
        example: "1.0.5",
        description: "App build version: major.minor.patch",
      },
    },
    required: ["platform", "version"],
  },
  AppVersionCheckResponseData: {
    type: "object",
    properties: {
      platform: { type: "string", enum: ["android", "ios"] },
      clientVersion: { type: "string", example: "1.0.5" },
      minimumRequiredVersion: {
        type: "string",
        example: "1.0.0",
        description: "Below this → force update.",
      },
      latestRecommendedVersion: {
        type: "string",
        example: "1.2.0",
        description: "Below this (but ≥ minimum) → optional update.",
      },
      forceUpdate: {
        type: "boolean",
        example: false,
        description: "If true, block the app and show force-update UI.",
      },
      optionalUpdate: {
        type: "boolean",
        example: true,
        description: "If true, show optional (dismissible) update UI.",
      },
      isUpToDate: {
        type: "boolean",
        example: false,
        description: "If true, continue without update UI.",
      },
      storeUrl: { type: "string", format: "uri", nullable: true },
    },
    required: [
      "platform",
      "clientVersion",
      "minimumRequiredVersion",
      "latestRecommendedVersion",
      "forceUpdate",
      "optionalUpdate",
      "isUpToDate",
    ],
  },
  DeviceLinkInitiateRequest: {
    type: "object",
    description:
      "Optional device descriptors from the new (unauthenticated) device.",
    properties: {
      deviceName: {
        type: "string",
        maxLength: 100,
        example: "Chrome on macOS",
      },
      deviceType: {
        type: "string",
        enum: ["IOS", "ANDROID", "DESKTOP", "WEB"],
        example: "DESKTOP",
      },
      os: { type: "string", maxLength: 100, example: "macOS 14" },
      appVersion: { type: "string", maxLength: 100, example: "1.4.0" },
    },
  },
  DeviceLinkInitiateResponseData: {
    type: "object",
    properties: {
      linkToken: {
        type: "string",
        description: "Embed in the QR code shown to the authenticated device.",
      },
      pollSecret: {
        type: "string",
        description:
          "Secret held only by the new device; required to poll status.",
      },
      expiresAt: { type: "string", format: "date-time" },
    },
    required: ["linkToken", "pollSecret", "expiresAt"],
  },
  DeviceLinkStatusResponseData: {
    type: "object",
    properties: {
      state: {
        type: "string",
        enum: ["PENDING", "APPROVED", "CONSUMED", "EXPIRED"],
        description:
          "PENDING = waiting for the signed-in device to scan and approve; APPROVED = approved, tokens returned exactly once; CONSUMED = tokens already delivered (poll again returns this); EXPIRED = 120 s TTL elapsed, call initiate again.",
      },
      approvedDeviceLabel: { type: "string", nullable: true },
      tokens: {
        nullable: true,
        allOf: [{ $ref: "#/components/schemas/AuthTokens" }],
        description: "Returned exactly once when the session is approved.",
      },
    },
    required: ["state", "approvedDeviceLabel", "tokens"],
  },
  DeviceLinkApproveRequest: {
    type: "object",
    properties: {
      linkToken: { type: "string" },
      deviceLabel: { type: "string", maxLength: 100, example: "My laptop" },
    },
    required: ["linkToken"],
  },
  DeviceLinkApproveResponseData: {
    type: "object",
    properties: {
      linkedAt: { type: "string", format: "date-time" },
      sessionId: {
        type: "string",
        format: "uuid",
        description:
          "Session id of the newly-linked device; revoke it via DELETE /auth/sessions/{sessionId} to undo the link.",
      },
    },
    required: ["linkedAt", "sessionId"],
  },
  DeleteAccountResponseData: {
    type: "object",
    properties: {
      deletedAt: { type: "string", format: "date-time" },
    },
    required: ["deletedAt"],
  },

  // ===========================================================================
  // user-service · friends
  // ===========================================================================
  FriendListItem: {
    type: "object",
    properties: {
      userId: { type: "string", format: "uuid" },
      username: { type: "string" },
      firstName: { type: "string" },
      lastName: { type: "string" },
      avatarUrl: {
        type: "string",
        format: "uri",
        nullable: true,
        description: "Presigned GET URL (private MinIO); null if no avatar.",
      },
      section: {
        type: "string",
        description:
          "Uppercased first letter of firstName, or '#' for non-alphabetic names.",
        example: "A",
      },
    },
    required: [
      "userId",
      "username",
      "firstName",
      "lastName",
      "avatarUrl",
      "section",
    ],
  },
  FriendsListResponseData: {
    type: "object",
    properties: {
      friends: {
        type: "array",
        items: { $ref: "#/components/schemas/FriendListItem" },
      },
      nextCursor: {
        type: "string",
        format: "uuid",
        nullable: true,
        description: "userId cursor for the next page; null when no more.",
      },
    },
    required: ["friends", "nextCursor"],
  },

  // ===========================================================================
  // user-service · user discovery
  // ===========================================================================
  UserDiscoveryItem: {
    type: "object",
    properties: {
      userId: { type: "string", format: "uuid" },
      username: { type: "string" },
      firstName: { type: "string" },
      lastName: { type: "string" },
      bio: { type: "string", nullable: true },
      avatarUrl: {
        type: "string",
        format: "uri",
        nullable: true,
        description: "Presigned GET URL; null if no avatar.",
      },
      avatarUrlExpiresIn: {
        type: "integer",
        nullable: true,
        description: "Seconds until avatarUrl expires; null if no avatar.",
      },
      isOnline: { type: "boolean" },
      relationshipStatus: {
        type: "string",
        enum: ["FRIEND", "PENDING_IN", "PENDING_OUT", "NONE"],
        nullable: true,
        description:
          "Omitted when section=all. PENDING_IN = they sent the request to you.",
      },
      friendshipId: {
        type: "string",
        format: "uuid",
        nullable: true,
        description: "Present when relationshipStatus is FRIEND or PENDING_*.",
      },
    },
    required: [
      "userId",
      "username",
      "firstName",
      "lastName",
      "bio",
      "avatarUrl",
      "avatarUrlExpiresIn",
      "isOnline",
    ],
  },
  UserDiscoveryResponseData: {
    type: "object",
    properties: {
      users: {
        type: "array",
        items: { $ref: "#/components/schemas/UserDiscoveryItem" },
      },
      total: {
        type: "integer",
        description: "Total matching users (across all pages).",
      },
    },
    required: ["users", "total"],
  },

  // ===========================================================================
  // community-service
  // ===========================================================================
  CommunityData: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      handle: { type: "string" },
      description: { type: "string", nullable: true },
      type: { type: "string", enum: ["PUBLIC", "PRIVATE"] },
      category: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
        },
        required: ["id", "name"],
      },
      creatorId: { type: "string", format: "uuid" },
      adminId: { type: "string", format: "uuid" },
      memberCount: { type: "integer", example: 1 },
      avatarUrl: {
        type: "string",
        format: "uri",
        nullable: true,
        description: "Presigned GET URL (private MinIO).",
      },
      avatarUrlExpiresIn: { type: "integer", nullable: true, example: 3600 },
      coverUrl: {
        type: "string",
        format: "uri",
        nullable: true,
        description: "Presigned GET URL (private MinIO).",
      },
      coverUrlExpiresIn: { type: "integer", nullable: true, example: 3600 },
      myRole: {
        type: "string",
        nullable: true,
        enum: ["ADMIN", "MODERATOR", "MEMBER"],
        description: "Caller's membership role; null if not a member.",
      },
      myIsMuted: {
        type: "boolean",
        description: "True if the caller has any mute row for this community.",
      },
      myMuteUntil: {
        type: "string",
        format: "date-time",
        nullable: true,
        description:
          "When the caller's mute expires; null = not muted OR muted indefinitely (use myIsMuted to disambiguate).",
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: [
      "id",
      "name",
      "handle",
      "description",
      "type",
      "category",
      "creatorId",
      "adminId",
      "memberCount",
      "avatarUrl",
      "avatarUrlExpiresIn",
      "coverUrl",
      "coverUrlExpiresIn",
      "myRole",
      "myIsMuted",
      "myMuteUntil",
      "createdAt",
      "updatedAt",
    ],
  },
  CreateCommunityRequest: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 3, maxLength: 50 },
      handle: {
        type: "string",
        minLength: 3,
        maxLength: 32,
        description: "Lowercase letters, numbers, underscores. Unique @-slug.",
      },
      type: { type: "string", enum: ["PUBLIC", "PRIVATE"] },
      categoryId: {
        type: "string",
        description: "24-char hex ObjectId of an active category.",
      },
      description: { type: "string", maxLength: 500 },
      avatarObjectKey: {
        type: "string",
        description: "Object key from /communities/uploads/url.",
      },
      memberIds: {
        type: "array",
        items: { type: "string", format: "uuid" },
        description: "Optional initial members (deduped, creator excluded).",
        default: [],
      },
    },
    required: ["name", "handle", "type", "categoryId"],
  },
  UpdateCommunityRequest: {
    type: "object",
    description: "Partial update; at least one field required. Admin only.",
    properties: {
      name: { type: "string", minLength: 3, maxLength: 50 },
      handle: { type: "string", minLength: 3, maxLength: 32 },
      type: { type: "string", enum: ["PUBLIC", "PRIVATE"] },
      categoryId: { type: "string" },
      description: { type: "string", maxLength: 500, nullable: true },
      avatarObjectKey: { type: "string", nullable: true },
    },
  },
  CommunityNameAvailabilityData: {
    type: "object",
    properties: {
      name: { type: "string" },
      available: { type: "boolean" },
    },
    required: ["name", "available"],
  },
  CommunityHandleAvailabilityData: {
    type: "object",
    properties: {
      handle: { type: "string" },
      available: { type: "boolean" },
    },
    required: ["handle", "available"],
  },
  CommunityCategoryData: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      slug: { type: "string" },
    },
    required: ["id", "name", "slug"],
  },
  CategoryListResponseData: {
    type: "object",
    properties: {
      categories: {
        type: "array",
        items: { $ref: "#/components/schemas/CommunityCategoryData" },
      },
    },
    required: ["categories"],
  },
  CommunityListItem: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      handle: { type: "string" },
      type: { type: "string", enum: ["PUBLIC", "PRIVATE"] },
      memberCount: { type: "integer" },
      avatarUrl: { type: "string", format: "uri", nullable: true },
      avatarUrlExpiresIn: { type: "integer", nullable: true },
      myRole: { type: "string", enum: ["ADMIN", "MODERATOR", "MEMBER"] },
      myIsMuted: {
        type: "boolean",
        description: "True if the caller has any mute row for this community.",
      },
      myMuteUntil: {
        type: "string",
        format: "date-time",
        nullable: true,
        description:
          "When the caller's mute expires; null = not muted OR muted indefinitely (use myIsMuted to disambiguate).",
      },
      lastActivityAt: {
        type: "string",
        format: "date-time",
        description:
          "Latest activity (latest community message, else createdAt). The sort key; feed its epoch-ms into before_ts/after_ts to page.",
      },
    },
    required: [
      "id",
      "name",
      "handle",
      "type",
      "memberCount",
      "avatarUrl",
      "avatarUrlExpiresIn",
      "myRole",
      "myIsMuted",
      "myMuteUntil",
      "lastActivityAt",
    ],
  },
  PaginationMeta: {
    type: "object",
    description: "Offset/page pagination metadata.",
    properties: {
      totalData: { type: "integer", description: "Total matching records." },
      totalPage: { type: "integer", description: "Total number of pages." },
      currentPage: {
        type: "integer",
        description: "The requested page (1-based).",
      },
      limit: { type: "integer", description: "Page size." },
      nextCursor: {
        type: "string",
        nullable: true,
        description: "Always null for offset pagination (reserved field).",
      },
      hasMore: {
        type: "boolean",
        description: "True when currentPage < totalPage.",
      },
    },
    required: [
      "totalData",
      "totalPage",
      "currentPage",
      "limit",
      "nextCursor",
      "hasMore",
    ],
  },
  MyCommunitiesResponseData: {
    type: "object",
    properties: {
      pagination: { $ref: "#/components/schemas/PaginationMeta" },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/CommunityListItem" },
      },
    },
    required: ["pagination", "data"],
  },
  CommunityDiscoverItem: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      handle: { type: "string" },
      description: { type: "string", nullable: true },
      type: { type: "string", enum: ["PUBLIC", "PRIVATE"] },
      category: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
        },
        required: ["id", "name"],
      },
      memberCount: { type: "integer" },
      avatarUrl: { type: "string", format: "uri", nullable: true },
      avatarUrlExpiresIn: { type: "integer", nullable: true },
      myIsMuted: {
        type: "boolean",
        description:
          "True if the caller has any mute row for this community. Discovered communities are ones the caller is not an active member of, so this is normally false (present for parity with the other community DTOs).",
      },
      myMuteUntil: {
        type: "string",
        format: "date-time",
        nullable: true,
        description:
          "When the caller's mute expires; null = not muted OR muted indefinitely.",
      },
      createdAt: { type: "string", format: "date-time" },
    },
    required: [
      "id",
      "name",
      "handle",
      "description",
      "type",
      "category",
      "memberCount",
      "avatarUrl",
      "avatarUrlExpiresIn",
      "myIsMuted",
      "myMuteUntil",
      "createdAt",
    ],
  },
  CommunityDiscoverResponseData: {
    type: "object",
    properties: {
      pagination: { $ref: "#/components/schemas/PaginationMeta" },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/CommunityDiscoverItem" },
      },
    },
    required: ["pagination", "data"],
  },
  CommunityUploadUrlRequest: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["COMMUNITY_AVATAR"],
        description: "Upload type registered in the community-service.",
      },
      contentType: {
        type: "string",
        enum: ["image/jpeg", "image/png", "image/webp"],
      },
      contentLength: {
        type: "integer",
        minimum: 1,
        description: "File size in bytes (must not exceed server max).",
      },
    },
    required: ["type", "contentType", "contentLength"],
  },
  CommunityMemberData: {
    type: "object",
    properties: {
      userId: { type: "string", format: "uuid" },
      role: {
        type: "string",
        enum: ["ADMIN", "MODERATOR", "MEMBER"],
        description:
          "ADMIN = community owner (1 per community); MODERATOR = can kick/ban members; MEMBER = regular participant.",
      },
      status: {
        type: "string",
        enum: ["ACTIVE", "PENDING", "BANNED", "LEFT"],
        description:
          "ACTIVE = current member; PENDING = join request awaiting approval (private communities); BANNED = banned by admin; LEFT = voluntarily left or kicked.",
      },
      joinedAt: { type: "string", format: "date-time" },
      snapshotUsername: { type: "string" },
      snapshotDisplayName: { type: "string" },
      snapshotAvatarUrl: { type: "string", nullable: true },
      snapshotAvatarUrlExpiresIn: { type: "integer", nullable: true },
      bannedAt: {
        type: "string",
        format: "date-time",
        nullable: true,
        description: "When the member was banned; null when not banned.",
      },
      bannedBy: {
        type: "string",
        format: "uuid",
        nullable: true,
        description:
          "User ID of the admin who banned the member; null when not banned.",
      },
      banReason: {
        type: "string",
        nullable: true,
        description:
          "Operator-supplied ban reason; null when not banned or no reason given.",
      },
    },
    required: [
      "userId",
      "role",
      "status",
      "joinedAt",
      "snapshotUsername",
      "snapshotDisplayName",
      "snapshotAvatarUrl",
      "snapshotAvatarUrlExpiresIn",
      "bannedAt",
      "bannedBy",
      "banReason",
    ],
  },
  CommunityMembersResponseData: {
    type: "object",
    properties: {
      pagination: { $ref: "#/components/schemas/PaginationMeta" },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/CommunityMemberData" },
      },
    },
    required: ["pagination", "data"],
  },
  UpdateMemberRoleRequest: {
    type: "object",
    properties: {
      role: {
        type: "string",
        enum: ["MODERATOR", "MEMBER"],
        description: "Target role. ADMIN cannot be assigned via this endpoint.",
      },
    },
    required: ["role"],
  },
  AddMembersRequest: {
    type: "object",
    properties: {
      userIds: {
        type: "array",
        items: { type: "string", format: "uuid" },
        minItems: 1,
        maxItems: 100,
        description: "User ids to add (deduped). 1–100 per request.",
      },
    },
    required: ["userIds"],
  },
  TransferAdminRequest: {
    type: "object",
    properties: {
      userId: {
        type: "string",
        format: "uuid",
        description:
          "Target user id — must be an ACTIVE member of the community and not the current admin.",
      },
    },
    required: ["userId"],
  },
  AddMembersResponseData: {
    type: "object",
    properties: {
      added: {
        type: "array",
        items: { $ref: "#/components/schemas/CommunityMemberData" },
        description: "Members newly created or reactivated as ACTIVE.",
      },
      skipped: {
        type: "array",
        items: {
          type: "object",
          properties: {
            userId: { type: "string", format: "uuid" },
            reason: {
              type: "string",
              enum: ["ALREADY_MEMBER", "BANNED", "NOT_FRIEND"],
            },
          },
          required: ["userId", "reason"],
        },
        description:
          "User ids not added: already ACTIVE members, BANNED (must be unbanned first), or NOT_FRIEND with the caller (must be an accepted friend or invited via /invites).",
      },
    },
    required: ["added", "skipped"],
  },
  CommunityAuditLogData: {
    type: "object",
    properties: {
      id: { type: "string" },
      communityId: { type: "string" },
      actorId: {
        type: "string",
        format: "uuid",
        description: "User who performed the action.",
      },
      action: {
        type: "string",
        enum: [
          "MEMBER_PROMOTED",
          "MEMBER_DEMOTED",
          "MEMBER_KICKED",
          "MEMBER_BANNED",
          "MEMBER_UNBANNED",
          "ADMIN_TRANSFERRED",
          "COMMUNITY_JOINED",
          "COMMUNITY_DELETED",
          "JOIN_REQUEST_APPROVED",
          "JOIN_REQUEST_REJECTED",
          "MEMBER_INVITED",
          "INVITE_ACCEPTED",
          "INVITE_DECLINED",
          "COMMUNITY_REPORT_REVIEWED",
          "COMMUNITY_REPORT_ACTIONED",
          "COMMUNITY_REPORT_DISMISSED",
          "MEMBER_LEFT",
          "INVITE_LINK_CREATED",
          "INVITE_LINK_REVOKED",
          "INVITE_LINK_REDEEMED",
        ],
      },
      targetUserId: {
        type: "string",
        format: "uuid",
        nullable: true,
        description: "Member the action targeted, if any.",
      },
      reason: {
        type: "string",
        nullable: true,
        description: "Operator-supplied moderation reason, if any.",
      },
      metadata: {
        type: "object",
        nullable: true,
        description: "Action-specific structured context (e.g. `{ role }`).",
      },
      createdAt: { type: "string", format: "date-time" },
    },
    required: [
      "id",
      "communityId",
      "actorId",
      "action",
      "targetUserId",
      "reason",
      "metadata",
      "createdAt",
    ],
  },
  CommunityAuditLogsResponseData: {
    type: "object",
    properties: {
      pagination: { $ref: "#/components/schemas/PaginationMeta" },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/CommunityAuditLogData" },
      },
    },
    required: ["pagination", "data"],
  },
  // --- Join requests ------------------------------------------------------
  CreateJoinRequestRequest: {
    type: "object",
    properties: {
      message: {
        type: "string",
        maxLength: 500,
        description: "Optional message included with the join request.",
      },
    },
  },
  JoinRequestData: {
    type: "object",
    properties: {
      requestId: { type: "string" },
      communityId: { type: "string" },
      userId: { type: "string", format: "uuid" },
      status: {
        type: "string",
        enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"],
      },
      message: { type: "string", nullable: true },
      decidedBy: { type: "string", format: "uuid", nullable: true },
      decidedAt: { type: "string", format: "date-time", nullable: true },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: [
      "requestId",
      "communityId",
      "userId",
      "status",
      "message",
      "decidedBy",
      "decidedAt",
      "createdAt",
      "updatedAt",
    ],
  },
  JoinRequestUserSummary: {
    type: "object",
    properties: {
      userId: { type: "string", format: "uuid" },
      username: { type: "string" },
      displayName: { type: "string" },
      avatarUrl: { type: "string", nullable: true },
      avatarUrlExpiresIn: { type: "integer", nullable: true },
    },
    required: [
      "userId",
      "username",
      "displayName",
      "avatarUrl",
      "avatarUrlExpiresIn",
    ],
  },
  JoinRequestWithUserData: {
    allOf: [
      { $ref: "#/components/schemas/JoinRequestData" },
      {
        type: "object",
        properties: {
          user: { $ref: "#/components/schemas/JoinRequestUserSummary" },
        },
        required: ["user"],
      },
    ],
  },
  EmbeddedCommunitySummary: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      handle: { type: "string" },
      type: { type: "string", enum: ["PUBLIC", "PRIVATE"] },
      memberCount: { type: "integer" },
      avatarUrl: { type: "string", nullable: true },
      avatarUrlExpiresIn: { type: "integer", nullable: true },
    },
    required: [
      "id",
      "name",
      "handle",
      "type",
      "memberCount",
      "avatarUrl",
      "avatarUrlExpiresIn",
    ],
  },
  MyJoinRequestData: {
    allOf: [
      { $ref: "#/components/schemas/JoinRequestData" },
      {
        type: "object",
        properties: {
          community: { $ref: "#/components/schemas/EmbeddedCommunitySummary" },
        },
        required: ["community"],
      },
    ],
  },
  JoinRequestApprovedData: {
    type: "object",
    properties: {
      request: { $ref: "#/components/schemas/JoinRequestData" },
      member: { $ref: "#/components/schemas/CommunityMemberData" },
    },
    required: ["request", "member"],
  },
  JoinRequestPage: {
    type: "object",
    properties: {
      pagination: { $ref: "#/components/schemas/PaginationMeta" },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/JoinRequestWithUserData" },
      },
    },
    required: ["pagination", "data"],
  },
  MyJoinRequestPage: {
    type: "object",
    properties: {
      pagination: { $ref: "#/components/schemas/PaginationMeta" },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/MyJoinRequestData" },
      },
    },
    required: ["pagination", "data"],
  },
  // --- Invites ------------------------------------------------------------
  CreateInviteRequest: {
    type: "object",
    properties: {
      inviteeId: { type: "string", format: "uuid" },
    },
    required: ["inviteeId"],
  },
  InviteData: {
    type: "object",
    properties: {
      inviteId: { type: "string" },
      communityId: { type: "string" },
      inviterId: { type: "string", format: "uuid" },
      inviteeId: { type: "string", format: "uuid" },
      status: {
        type: "string",
        enum: ["PENDING", "ACCEPTED", "DECLINED", "EXPIRED"],
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: [
      "inviteId",
      "communityId",
      "inviterId",
      "inviteeId",
      "status",
      "createdAt",
      "updatedAt",
    ],
  },
  InviteUserSummary: {
    type: "object",
    properties: {
      userId: { type: "string", format: "uuid" },
      username: { type: "string" },
      displayName: { type: "string" },
      avatarUrl: { type: "string", nullable: true },
      avatarUrlExpiresIn: { type: "integer", nullable: true },
    },
    required: [
      "userId",
      "username",
      "displayName",
      "avatarUrl",
      "avatarUrlExpiresIn",
    ],
  },
  InviteWithUserData: {
    allOf: [
      { $ref: "#/components/schemas/InviteData" },
      {
        type: "object",
        properties: {
          invitee: { $ref: "#/components/schemas/InviteUserSummary" },
        },
        required: ["invitee"],
      },
    ],
  },
  MyInviteData: {
    allOf: [
      { $ref: "#/components/schemas/InviteData" },
      {
        type: "object",
        properties: {
          community: { $ref: "#/components/schemas/EmbeddedCommunitySummary" },
        },
        required: ["community"],
      },
    ],
  },
  InviteAcceptedData: {
    type: "object",
    properties: {
      invite: { $ref: "#/components/schemas/InviteData" },
      member: { $ref: "#/components/schemas/CommunityMemberData" },
    },
    required: ["invite", "member"],
  },
  InvitePage: {
    type: "object",
    properties: {
      pagination: { $ref: "#/components/schemas/PaginationMeta" },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/InviteWithUserData" },
      },
    },
    required: ["pagination", "data"],
  },
  MyInvitePage: {
    type: "object",
    properties: {
      pagination: { $ref: "#/components/schemas/PaginationMeta" },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/MyInviteData" },
      },
    },
    required: ["pagination", "data"],
  },
  // --- Reports ------------------------------------------------------------
  CreateReportRequest: {
    type: "object",
    properties: {
      targetUserId: {
        type: "string",
        format: "uuid",
        description:
          "User id being reported. Omit (null) to report the community itself. Must currently have a member row in the community (any status).",
      },
      reason: {
        type: "string",
        minLength: 3,
        maxLength: 1000,
        description: "Reporter-supplied reason text.",
      },
    },
    required: ["reason"],
  },
  ReportResolutionRequest: {
    type: "object",
    properties: {
      resolution: {
        type: "string",
        maxLength: 1000,
        description: "Optional moderator note describing the resolution.",
      },
    },
  },
  ReportData: {
    type: "object",
    properties: {
      reportId: { type: "string" },
      communityId: { type: "string" },
      reporterId: { type: "string", format: "uuid" },
      targetUserId: { type: "string", format: "uuid", nullable: true },
      reason: { type: "string" },
      status: {
        type: "string",
        enum: ["OPEN", "REVIEWED", "ACTIONED", "DISMISSED", "WITHDRAWN"],
      },
      reviewedBy: { type: "string", format: "uuid", nullable: true },
      reviewedAt: { type: "string", format: "date-time", nullable: true },
      resolution: { type: "string", nullable: true },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: [
      "reportId",
      "communityId",
      "reporterId",
      "targetUserId",
      "reason",
      "status",
      "reviewedBy",
      "reviewedAt",
      "resolution",
      "createdAt",
      "updatedAt",
    ],
  },
  ReportUserSummary: {
    type: "object",
    properties: {
      userId: { type: "string", format: "uuid" },
      username: { type: "string" },
      displayName: { type: "string" },
      avatarUrl: { type: "string", nullable: true },
      avatarUrlExpiresIn: { type: "integer", nullable: true },
    },
    required: [
      "userId",
      "username",
      "displayName",
      "avatarUrl",
      "avatarUrlExpiresIn",
    ],
  },
  ReportWithUsersData: {
    allOf: [
      { $ref: "#/components/schemas/ReportData" },
      {
        type: "object",
        properties: {
          reporter: { $ref: "#/components/schemas/ReportUserSummary" },
          target: {
            allOf: [{ $ref: "#/components/schemas/ReportUserSummary" }],
            nullable: true,
          },
        },
        required: ["reporter", "target"],
      },
    ],
  },
  MyReportData: {
    allOf: [
      { $ref: "#/components/schemas/ReportData" },
      {
        type: "object",
        properties: {
          community: { $ref: "#/components/schemas/EmbeddedCommunitySummary" },
        },
        required: ["community"],
      },
    ],
  },
  ReportPage: {
    type: "object",
    properties: {
      pagination: { $ref: "#/components/schemas/PaginationMeta" },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/ReportWithUsersData" },
      },
    },
    required: ["pagination", "data"],
  },
  MyReportPage: {
    type: "object",
    properties: {
      pagination: { $ref: "#/components/schemas/PaginationMeta" },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/MyReportData" },
      },
    },
    required: ["pagination", "data"],
  },

  // --- Leave reason -------------------------------------------------------
  LeaveCommunityRequest: {
    type: "object",
    description:
      "Optional leave-reason body. When `reason` is `OTHER`, `reasonText` is required.",
    properties: {
      reason: {
        type: "string",
        enum: [
          "UNINTERESTED",
          "TOO_NOISY",
          "INAPPROPRIATE_CONTENT",
          "PRIVACY_CONCERN",
          "OTHER",
        ],
        description: "Leave reason. When OTHER, reasonText is required.",
      },
      reasonText: { type: "string", maxLength: 500 },
    },
  },

  // --- Mute settings ------------------------------------------------------
  CommunityMuteData: {
    type: "object",
    properties: {
      communityId: { type: "string" },
      mutedUntil: {
        type: "string",
        format: "date-time",
        nullable: true,
        description: "null = muted indefinitely.",
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: ["communityId", "mutedUntil", "createdAt", "updatedAt"],
  },
  SetMuteRequest: {
    type: "object",
    description:
      "null or omitted → indefinite mute; positive integer → mute for N minutes.",
    properties: {
      durationMinutes: {
        type: "integer",
        minimum: 1,
        maximum: 525600,
        nullable: true,
      },
    },
  },

  // --- Member moderation: mute / warn -------------------------------------
  CommunityMutedMemberData: {
    type: "object",
    description: "A single moderation-muted member row.",
    properties: {
      userId: { type: "string", format: "uuid" },
      username: { type: "string" },
      displayName: { type: "string" },
      avatarUrl: { type: "string", nullable: true },
      avatarUrlExpiresIn: { type: "integer", nullable: true },
      mutedBy: {
        type: "string",
        format: "uuid",
        description: "User ID of the moderator/admin who muted the member.",
      },
      reason: { type: "string", nullable: true },
      mutedAt: { type: "string", format: "date-time" },
      mutedUntil: {
        type: "string",
        format: "date-time",
        nullable: true,
        description: "null = muted indefinitely.",
      },
    },
    required: [
      "userId",
      "username",
      "displayName",
      "avatarUrl",
      "avatarUrlExpiresIn",
      "mutedBy",
      "reason",
      "mutedAt",
      "mutedUntil",
    ],
  },
  CommunityMutedMembersResponseData: {
    type: "object",
    properties: {
      pagination: { $ref: "#/components/schemas/PaginationMeta" },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/CommunityMutedMemberData" },
      },
    },
    required: ["pagination", "data"],
  },
  SetMemberMuteRequest: {
    type: "object",
    description:
      "durationMinutes null/omitted → mute indefinitely; positive integer → mute for N minutes.",
    properties: {
      durationMinutes: {
        type: "integer",
        minimum: 1,
        maximum: 525600,
        nullable: true,
      },
      reason: {
        type: "string",
        maxLength: 500,
        description: "Optional moderation reason.",
      },
    },
  },
  CommunityMemberWarningData: {
    type: "object",
    description: "A single moderation warning issued to a member.",
    properties: {
      warningId: { type: "string" },
      userId: { type: "string", format: "uuid" },
      warnedBy: {
        type: "string",
        format: "uuid",
        description: "User ID of the moderator/admin who issued the warning.",
      },
      note: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
    },
    required: ["warningId", "userId", "warnedBy", "note", "createdAt"],
  },
  CommunityMemberWarningsResponseData: {
    type: "object",
    properties: {
      pagination: { $ref: "#/components/schemas/PaginationMeta" },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/CommunityMemberWarningData" },
      },
    },
    required: ["pagination", "data"],
  },
  WarnMemberRequest: {
    type: "object",
    properties: {
      note: {
        type: "string",
        minLength: 1,
        maxLength: 1000,
        description: "Required warning note.",
      },
    },
    required: ["note"],
  },

  // --- Notification preferences -------------------------------------------
  CommunityNotificationPreferenceData: {
    type: "object",
    description:
      "Per-community notification preference toggles for the caller.",
    properties: {
      communityId: { type: "string" },
      mutedUntil: {
        type: "string",
        format: "date-time",
        nullable: true,
        description: "null = not muted or muted indefinitely.",
      },
      streamEnabled: { type: "boolean" },
      chatEnabled: { type: "boolean" },
      announcementEnabled: { type: "boolean" },
      createdAt: { type: "string", format: "date-time", nullable: true },
      updatedAt: { type: "string", format: "date-time", nullable: true },
    },
    required: [
      "communityId",
      "mutedUntil",
      "streamEnabled",
      "chatEnabled",
      "announcementEnabled",
      "createdAt",
      "updatedAt",
    ],
  },
  SetNotificationPrefsRequest: {
    type: "object",
    description:
      "At least one of the toggles must be present; omitted fields are left unchanged.",
    properties: {
      streamEnabled: { type: "boolean" },
      chatEnabled: { type: "boolean" },
      announcementEnabled: { type: "boolean" },
    },
  },

  // --- Invite links -------------------------------------------------------
  CommunityInviteLinkData: {
    type: "object",
    properties: {
      linkId: { type: "string" },
      code: { type: "string" },
      url: {
        type: "string",
        description:
          "Built from INVITE_LINK_BASE_URL when set, else just the code.",
      },
      communityId: { type: "string" },
      createdBy: { type: "string", format: "uuid" },
      maxUses: { type: "integer", nullable: true },
      usedCount: { type: "integer" },
      autoApprove: {
        type: "boolean",
        description:
          "When true, redeeming this link adds the member directly (no join-request flow).",
      },
      expiresAt: { type: "string", format: "date-time", nullable: true },
      revokedAt: { type: "string", format: "date-time", nullable: true },
      createdAt: { type: "string", format: "date-time" },
      isActive: {
        type: "boolean",
        description: "Computed: not revoked, not expired, not exhausted.",
      },
    },
    required: [
      "linkId",
      "code",
      "url",
      "communityId",
      "createdBy",
      "maxUses",
      "usedCount",
      "autoApprove",
      "expiresAt",
      "revokedAt",
      "createdAt",
      "isActive",
    ],
  },
  CreateInviteLinkRequest: {
    type: "object",
    properties: {
      maxUses: { type: "integer", minimum: 1, maximum: 1000 },
      expiresInMinutes: { type: "integer", minimum: 1, maximum: 525600 },
      autoApprove: {
        type: "boolean",
        description:
          "When true, anyone redeeming this link is added as a member directly. Default false (creates a join request instead).",
      },
    },
  },
  InviteLinkListResponseData: {
    type: "object",
    properties: {
      pagination: { $ref: "#/components/schemas/PaginationMeta" },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/CommunityInviteLinkData" },
      },
    },
    required: ["pagination", "data"],
  },
  RedeemInviteLinkResponseData: {
    type: "object",
    description:
      "link is always present. member is set when autoApprove=true (direct add); request is set when autoApprove=false (join-request flow).",
    properties: {
      link: { $ref: "#/components/schemas/CommunityInviteLinkData" },
      member: { $ref: "#/components/schemas/CommunityMemberData" },
      request: { $ref: "#/components/schemas/CommunityJoinRequestData" },
    },
    required: ["link"],
  },

  // ===========================================================================
  // chat-service
  // ===========================================================================

  // --- Private rooms & messages ---
  ChatPrivateRoom: {
    type: "object",
    properties: {
      id: { type: "string" },
      roomId: { type: "string" },
      participants: {
        type: "array",
        items: { type: "string" },
      },
      lastMessageAt: { type: "string", format: "date-time", nullable: true },
      lastMessage: { type: "object", nullable: true },
      pinnedCount: { type: "integer" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: ["id", "roomId", "participants", "createdAt", "updatedAt"],
  },
  ChatPrivateRoomList: {
    type: "array",
    items: { $ref: "#/components/schemas/ChatPrivateRoom" },
  },
  // --- Unified inbox (private rooms + group chats merged by lastMessageAt) ---
  ChatInboxItem: {
    type: "object",
    description:
      "A single inbox entry — either a 1:1 private room or a group chat, discriminated by `type`. Fields specific to the other kind are null.",
    properties: {
      type: { type: "string", enum: ["PRIVATE", "GROUP"] },
      roomId: { type: "string" },
      lastMessageAt: { type: "string", format: "date-time", nullable: true },
      lastMessageId: { type: "string", nullable: true },
      lastMessage: {
        type: "object",
        nullable: true,
        description:
          "Last message preview. Shape differs by `type` (private: room.lastMessage; group: room.lastMessagePreview) — branch on `type` to read it.",
      },
      unreadCount: { type: "integer" },
      isMuted: { type: "boolean" },
      pinnedCount: { type: "integer" },
      peer: {
        nullable: true,
        description: "PRIVATE only — the other participant's snapshot.",
        allOf: [{ $ref: "#/components/schemas/ChatPeer" }],
      },
      name: { type: "string", nullable: true, description: "GROUP only." },
      avatar: { type: "string", nullable: true, description: "GROUP only." },
      description: {
        type: "string",
        nullable: true,
        description: "GROUP only.",
      },
      memberCount: {
        type: "integer",
        nullable: true,
        description: "GROUP only.",
      },
      role: {
        type: "string",
        nullable: true,
        description: "GROUP only — the viewer's role.",
      },
    },
    required: ["type", "roomId", "unreadCount", "isMuted", "pinnedCount"],
  },
  ChatPeer: {
    type: "object",
    properties: {
      id: { type: "string" },
      displayName: { type: "string" },
      memberId: { type: "string" },
      avatar: { type: "string" },
      isDeletedUser: { type: "boolean" },
      isOnline: { type: "boolean" },
    },
  },
  ChatInboxList: {
    type: "array",
    items: { $ref: "#/components/schemas/ChatInboxItem" },
  },
  ChatMessage: {
    type: "object",
    properties: {
      id: { type: "string" },
      roomId: { type: "string" },
      senderId: { type: "string", nullable: true },
      receiverId: { type: "string", nullable: true },
      content: {
        type: "object",
        description:
          "Message body. Validation caps (applied when a message is sent): `text` maxLength 4000 chars; for IMAGE messages at most 10 files; each VIDEO file ≤100MB and ≤180000ms (3 min); each VOICE file ≤300000ms (5 min); other files (GIF/DOCUMENT) ≤50MB.",
        properties: {
          text: {
            type: "string",
            maxLength: 4000,
            description: "Plain-text body. Max 4000 characters.",
          },
          urls: { type: "array", items: { type: "string" } },
          files: {
            type: "array",
            maxItems: 10,
            description:
              "Media files. IMAGE messages allow at most 10 files; VIDEO files are capped at 100MB / 180000ms; VOICE at 300000ms; GIF/DOCUMENT at 50MB.",
            items: {
              type: "object",
              properties: {
                url: { type: "string", format: "uri" },
                name: { type: "string" },
                size: { type: "number" },
                mime: { type: "string" },
                durationMs: {
                  type: "number",
                  description:
                    "Playback duration in milliseconds (video/voice).",
                },
              },
            },
          },
          location: { $ref: "#/components/schemas/ChatLocationAttachment" },
          contact: { $ref: "#/components/schemas/ChatContactAttachment" },
          sticker: { $ref: "#/components/schemas/ChatSticker" },
        },
      },
      messageType: {
        type: "string",
        enum: [
          "TEXT",
          "IMAGE",
          "DOCUMENT",
          "VIDEO",
          "GIF",
          "VOICE",
          "STICKER",
          "SYSTEM",
          "LOCATION",
          "CONTACT",
        ],
        description:
          "SYSTEM = server-generated event (e.g. member joined/left). LOCATION = shared map pin. CONTACT = shared contact card. STICKER = sticker message (see `content.sticker`).",
      },
      reactions: { type: "object" },
      parentMessageId: { type: "string", nullable: true },
      quoteData: { type: "object", nullable: true },
      isDeleted: { type: "boolean" },
      sequenceNumber: {
        type: "integer",
        description:
          "Per-room monotonic sequence number assigned at send time. Use for ordering and for the `chat:catchup` reconnect gap-fill (`sinceSeq`).",
      },
      createdAt: { type: "string", format: "date-time" },
    },
    required: ["id", "roomId", "messageType", "createdAt"],
  },
  ChatMessageList: {
    type: "array",
    items: { $ref: "#/components/schemas/ChatMessage" },
  },
  ChatDeletePrivateMessageRequest: {
    type: "object",
    properties: {
      messageId: { type: "string", minLength: 4 },
      type: { type: "string", enum: ["forMe", "forEveryone"] },
    },
    required: ["messageId", "type"],
  },
  ChatPin: {
    type: "object",
    properties: {
      id: { type: "string" },
      roomId: { type: "string" },
      messageId: { type: "string" },
      pinnedBy: { type: "string" },
      pinnedAt: { type: "string", format: "date-time" },
      senderId: { type: "string" },
      senderDisplayName: { type: "string" },
      contentPinned: { type: "object" },
      messageCreatedAt: { type: "string", format: "date-time" },
    },
    required: ["id", "roomId", "messageId", "pinnedBy", "pinnedAt"],
  },
  ChatPinList: {
    type: "array",
    items: { $ref: "#/components/schemas/ChatPin" },
  },

  // --- Group rooms ---
  ChatGroupRoom: {
    type: "object",
    properties: {
      id: { type: "string" },
      roomId: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      avatar: { type: "string" },
      type: { type: "string" },
      createdBy: { type: "string" },
      status: { type: "string", enum: ["ACTIVE", "DISBANDED"] },
      memberLimit: { type: "integer" },
      memberCount: { type: "integer" },
      settings: { type: "object" },
      lastMessageAt: { type: "string", format: "date-time", nullable: true },
      pinnedCount: { type: "integer" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: ["id", "roomId", "name", "createdBy", "status", "createdAt"],
  },
  ChatGroupRoomList: {
    type: "array",
    items: { $ref: "#/components/schemas/ChatGroupRoom" },
  },
  ChatCreateGroupRequest: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 100 },
      description: { type: "string", maxLength: 1000 },
      avatar: { type: "string" },
      memberLimit: { type: "integer", minimum: 2, maximum: 5000, default: 50 },
    },
    required: ["name"],
  },
  ChatUpdateGroupRequest: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 100 },
      description: { type: "string", maxLength: 1000 },
      avatar: { type: "string" },
      memberLimit: { type: "integer", minimum: 2, maximum: 5000 },
    },
  },

  // --- Group members ---
  ChatGroupMember: {
    type: "object",
    properties: {
      id: { type: "string" },
      roomId: { type: "string" },
      userId: { type: "string" },
      role: {
        type: "string",
        enum: ["OWNER", "ADMIN", "MODERATOR", "MEMBER"],
        description:
          "Role hierarchy (highest → lowest): OWNER > ADMIN > MODERATOR > MEMBER.",
      },
      status: {
        type: "string",
        enum: ["ACTIVE", "KICKED", "LEFT", "BANNED"],
        description:
          "ACTIVE = current member; KICKED = removed by admin/owner; LEFT = voluntarily left; BANNED = banned by admin.",
      },
      joinedAt: { type: "string", format: "date-time" },
      unreadCount: { type: "integer" },
    },
    required: ["id", "roomId", "userId", "role", "status", "joinedAt"],
  },
  ChatGroupMemberList: {
    type: "array",
    items: { $ref: "#/components/schemas/ChatGroupMember" },
  },
  ChatAddMemberRequest: {
    type: "object",
    properties: {
      roomId: { type: "string", minLength: 5 },
      userId: { type: "string", minLength: 5 },
    },
    required: ["roomId", "userId"],
  },
  ChatKickMemberRequest: {
    type: "object",
    properties: {
      roomId: { type: "string", minLength: 5 },
      userId: { type: "string", minLength: 5 },
      reason: { type: "string", maxLength: 1000 },
    },
    required: ["roomId", "userId"],
  },
  ChatUpdateRoleRequest: {
    type: "object",
    properties: {
      roomId: { type: "string", minLength: 5 },
      userId: { type: "string", minLength: 5 },
      role: {
        type: "string",
        enum: ["OWNER", "ADMIN", "MODERATOR", "MEMBER"],
      },
    },
    required: ["roomId", "userId", "role"],
  },
  ChatDeleteGroupMessageRequest: {
    type: "object",
    properties: {
      messageId: { type: "string", minLength: 4 },
      roomId: { type: "string", minLength: 4 },
    },
    required: ["messageId", "roomId"],
  },

  // --- Group invite links ---
  ChatInviteLink: {
    type: "object",
    properties: {
      id: { type: "string" },
      roomId: { type: "string" },
      token: { type: "string" },
      createdBy: { type: "string" },
      status: { type: "string", enum: ["ACTIVE", "REVOKED", "EXPIRED"] },
      expiresAt: { type: "string", format: "date-time", nullable: true },
      maxUses: { type: "integer", nullable: true },
      usedCount: { type: "integer" },
      shareName: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
    },
    required: ["id", "roomId", "token", "createdBy", "status", "createdAt"],
  },
  ChatInviteLinkList: {
    type: "array",
    items: { $ref: "#/components/schemas/ChatInviteLink" },
  },
  ChatInviteLinkPreview: {
    type: "object",
    description: "Public preview of a group invite link.",
    properties: {
      token: { type: "string" },
      groupName: { type: "string" },
      groupAvatar: { type: "string" },
      memberCount: { type: "integer" },
      shareName: { type: "string" },
    },
    required: ["token", "groupName", "memberCount"],
  },
  ChatCreateInviteLinkRequest: {
    type: "object",
    properties: {
      roomId: { type: "string", minLength: 5 },
      expiresAt: {
        type: "string",
        format: "date-time",
        nullable: true,
        description: "Optional expiry (ISO 8601).",
      },
      maxUses: {
        type: "integer",
        minimum: 1,
        nullable: true,
        description: "Optional maximum number of uses.",
      },
      shareName: { type: "string", maxLength: 200 },
    },
    required: ["roomId"],
  },
  ChatRevokeInviteLinkRequest: {
    type: "object",
    properties: {
      token: { type: "string", minLength: 10 },
    },
    required: ["token"],
  },
  ChatJoinByInviteLinkRequest: {
    type: "object",
    properties: {
      token: { type: "string", minLength: 10 },
    },
    required: ["token"],
  },

  // --- Notifications ---
  ChatNotification: {
    type: "object",
    properties: {
      id: { type: "string" },
      userId: { type: "string" },
      actorId: { type: "string" },
      type: { type: "string" },
      entity: { type: "object" },
      actorSnapshot: { type: "object" },
      payload: { type: "object" },
      isRead: { type: "boolean" },
      readAt: { type: "string", format: "date-time", nullable: true },
      createdAt: { type: "string", format: "date-time" },
    },
    required: ["id", "userId", "actorId", "type", "isRead", "createdAt"],
  },
  ChatNotificationList: {
    type: "array",
    items: { $ref: "#/components/schemas/ChatNotification" },
  },
  ChatMarkReadRequest: {
    type: "object",
    properties: {
      notificationId: { type: "string", minLength: 5 },
    },
    required: ["notificationId"],
  },
  ChatUnreadCountData: {
    type: "object",
    properties: {
      count: { type: "integer", example: 5 },
    },
    required: ["count"],
  },

  // --- Community rooms & messages ---
  ChatCommunityRoom: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      owner: { type: "string", nullable: true },
      logo: { type: "string", nullable: true },
      title: { type: "string", nullable: true },
      desc: { type: "string", nullable: true },
      memberNumber: { type: "integer" },
      onlineNember: { type: "integer" },
      isLive: { type: "boolean" },
      tags: { type: "array", items: { type: "string" } },
      status: { type: "string" },
      lastMessageAt: { type: "string", format: "date-time", nullable: true },
      createdAt: { type: "string", format: "date-time" },
    },
    required: ["id", "name", "status", "createdAt"],
  },
  ChatCommunityRoomList: {
    type: "array",
    items: { $ref: "#/components/schemas/ChatCommunityRoom" },
  },
  ChatCommunityMessage: {
    type: "object",
    properties: {
      id: { type: "string" },
      roomId: { type: "string" },
      sentBy: { type: "string" },
      senderName: { type: "string", nullable: true },
      senderAvatar: { type: "string", nullable: true },
      message: { type: "string", nullable: true },
      reactions: { type: "object" },
      parentMessageId: { type: "string", nullable: true },
      messageType: {
        type: "string",
        description:
          "Community message kind (stored lower-case): text, image, voice, custom, location, contact, sticker.",
      },
      attachments: {
        type: "array",
        description:
          "Media / sticker / location / contact attachments. Sticker entries follow ChatSticker. Send-time caps: text ≤4000 chars; ≤10 images; video ≤100MB/180000ms; voice ≤300000ms; other files ≤50MB.",
        items: { type: "object" },
      },
      deletedForAll: { type: "boolean" },
      createdAt: { type: "string", format: "date-time" },
    },
    required: ["id", "roomId", "sentBy", "createdAt"],
  },
  ChatCommunityMessageList: {
    type: "array",
    items: { $ref: "#/components/schemas/ChatCommunityMessage" },
  },

  // --- Attachments: location & contact ---
  ChatLocationAttachment: {
    type: "object",
    description:
      "Location share. Lives in message content (private/group) or attachments[] (community).",
    properties: {
      lat: { type: "number", minimum: -90, maximum: 90, example: 21.0285 },
      lng: { type: "number", minimum: -180, maximum: 180, example: 105.8542 },
      placeName: { type: "string", maxLength: 200, example: "Hoan Kiem Lake" },
      placeAddress: {
        type: "string",
        maxLength: 500,
        example: "Hanoi, Vietnam",
      },
    },
    required: ["lat", "lng"],
  },
  ChatContactAttachment: {
    type: "object",
    description:
      "Contact share. Lives in message content (private/group) or attachments[] (community).",
    properties: {
      name: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        example: "Emily Cooper",
      },
      phone: {
        type: "string",
        minLength: 1,
        maxLength: 50,
        example: "+12345 67890",
      },
      avatar: { type: "string", maxLength: 3000, nullable: true },
      userId: { type: "string", maxLength: 100, nullable: true },
    },
    required: ["name", "phone"],
  },
  ChatSticker: {
    type: "object",
    description:
      "Sticker payload. Lives in message content (private/group) or attachments[] (community). Exactly one of `objectKey` or `url` is required.",
    properties: {
      objectKey: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description:
          "Object-storage key for the sticker asset. One of objectKey / url is required.",
      },
      url: {
        type: "string",
        format: "uri",
        description:
          "Direct URL to the sticker asset. One of objectKey / url is required.",
      },
      packId: { type: "string", maxLength: 100 },
      stickerId: { type: "string", maxLength: 100 },
    },
    required: ["packId", "stickerId"],
  },

  // --- Media upload/download ---
  ChatDownloadUrlRequest: {
    type: "object",
    properties: {
      objectKey: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description:
          "Object key returned by /chat/media/upload-url (must start with chat-uploads/).",
        example: "chat-uploads/<userId>/<uuid>.mp3",
      },
    },
    required: ["objectKey"],
  },
  ChatDownloadUrlData: {
    type: "object",
    properties: {
      objectKey: { type: "string" },
      downloadUrl: {
        type: "string",
        format: "uri",
        description:
          "Short-lived presigned GET URL for playing/downloading the object.",
      },
    },
    required: ["objectKey", "downloadUrl"],
  },
  ChatUploadUrlRequest: {
    type: "object",
    properties: {
      filename: { type: "string", minLength: 1, maxLength: 255 },
      contentType: {
        type: "string",
        enum: [
          "image/jpeg",
          "image/png",
          "image/webp",
          "image/gif",
          "video/mp4",
          "video/quicktime",
          "audio/mpeg",
          "audio/ogg",
          "audio/wav",
          "application/pdf",
          "application/msword",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ],
      },
    },
    required: ["filename", "contentType"],
  },
  ChatUploadUrlData: {
    type: "object",
    properties: {
      objectKey: { type: "string", example: "chat-uploads/user123/abc.jpg" },
      uploadUrl: { type: "string", format: "uri" },
      contentType: { type: "string", example: "image/jpeg" },
    },
    required: ["objectKey", "uploadUrl", "contentType"],
  },

  // --- Calls ---
  ChatCall: {
    type: "object",
    properties: {
      id: { type: "string" },
      callId: { type: "string", format: "uuid" },
      callerId: { type: "string", format: "uuid" },
      calleeId: { type: "string", format: "uuid" },
      type: { type: "string", enum: ["AUDIO", "VIDEO"] },
      status: {
        type: "string",
        enum: [
          "RINGING",
          "IN_PROGRESS",
          "ENDED",
          "MISSED",
          "DECLINED",
          "FAILED",
        ],
      },
      privateRoomId: { type: "string", nullable: true },
      initiatedAt: { type: "string", format: "date-time" },
      answeredAt: { type: "string", format: "date-time", nullable: true },
      endedAt: { type: "string", format: "date-time", nullable: true },
      durationSec: { type: "integer", nullable: true },
      endedBy: { type: "string", format: "uuid", nullable: true },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: [
      "id",
      "callId",
      "callerId",
      "calleeId",
      "type",
      "status",
      "initiatedAt",
      "createdAt",
      "updatedAt",
    ],
  },
  ChatCallList: {
    type: "object",
    properties: {
      calls: {
        type: "array",
        items: { $ref: "#/components/schemas/ChatCall" },
      },
      nextCursor: { type: "string", format: "date-time", nullable: true },
      hasMore: { type: "boolean" },
    },
    required: ["calls", "nextCursor", "hasMore"],
  },

  // --- WebRTC ---
  ChatIceServer: {
    type: "object",
    properties: {
      urls: { type: "array", items: { type: "string" } },
      username: { type: "string" },
      credential: { type: "string" },
      credentialType: { type: "string", enum: ["password", "oauth"] },
    },
    required: ["urls"],
  },
  ChatRtcConfiguration: {
    type: "object",
    properties: {
      iceServers: {
        type: "array",
        items: { $ref: "#/components/schemas/ChatIceServer" },
      },
      iceCandidatePoolSize: { type: "integer", example: 10 },
      iceTransportPolicy: { type: "string", enum: ["all", "relay"] },
    },
    required: ["iceServers", "iceCandidatePoolSize", "iceTransportPolicy"],
  },

  // --- Message reactions ---
  ChatReactionUser: {
    type: "object",
    properties: {
      userId: { type: "string", format: "uuid" },
      displayName: { type: "string" },
      avatar: { type: "string", nullable: true },
    },
    required: ["userId", "displayName", "avatar"],
  },
  ChatReactionGroup: {
    type: "object",
    properties: {
      emoji: { type: "string", example: "👍" },
      count: { type: "integer" },
      users: {
        type: "array",
        items: { $ref: "#/components/schemas/ChatReactionUser" },
      },
      selfReacted: { type: "boolean" },
    },
    required: ["emoji", "count", "users", "selfReacted"],
  },
  ChatMessageReactions: {
    type: "object",
    properties: {
      messageId: { type: "string" },
      reactions: {
        type: "array",
        items: { $ref: "#/components/schemas/ChatReactionGroup" },
      },
    },
    required: ["messageId", "reactions"],
  },
  ChatEditMessageRequest: {
    type: "object",
    required: ["content"],
    properties: {
      content: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", minLength: 1, maxLength: 10000 },
          urls: { type: "array", items: { type: "string" } },
          files: { type: "array", items: { type: "object" } },
        },
      },
    },
  },
  ChatEditCommunityMessageRequest: {
    type: "object",
    required: ["communityId", "content"],
    properties: {
      communityId: {
        type: "string",
        minLength: 1,
        description:
          "Community the message belongs to — required so the edit broadcast reaches the right community room.",
      },
      content: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", minLength: 1, maxLength: 4000 },
        },
      },
    },
  },
  ChatConversationPage: {
    type: "object",
    description:
      "Offset-paginated message envelope. `data` is newest-first; reading a page also advances the caller's read pointer up to the newest returned message.",
    properties: {
      pagination: {
        type: "object",
        properties: {
          totalData: { type: "integer" },
          totalPage: { type: "integer" },
          currentPage: { type: "integer" },
          limit: { type: "integer" },
          hasMore: { type: "boolean" },
        },
      },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/ChatMessage" },
      },
    },
    required: ["pagination", "data"],
  },
  ChatCommunityConversationPage: {
    type: "object",
    description:
      "Offset-paginated community message envelope. `data` is newest-first; reading a page also advances the caller's read pointer up to the newest returned message.",
    properties: {
      pagination: {
        type: "object",
        properties: {
          totalData: { type: "integer" },
          totalPage: { type: "integer" },
          currentPage: { type: "integer" },
          limit: { type: "integer" },
          hasMore: { type: "boolean" },
        },
      },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/ChatCommunityMessage" },
      },
    },
    required: ["pagination", "data"],
  },
  ChatMuteRoomRequest: {
    type: "object",
    properties: {
      muteUntil: { type: "string", format: "date-time", nullable: true },
    },
  },
  ChatReportMessageRequest: {
    type: "object",
    required: ["reason"],
    properties: {
      reason: {
        type: "string",
        enum: [
          "SPAM",
          "HARASSMENT",
          "HATE_SPEECH",
          "NUDITY",
          "VIOLENCE",
          "SCAM",
          "OTHER",
        ],
      },
      description: { type: "string", maxLength: 1000 },
    },
  },
  ChatPresence: {
    type: "object",
    properties: {
      userId: { type: "string" },
      isOnline: { type: "boolean" },
      lastSeen: { type: "integer", nullable: true },
    },
  },
} as const;
