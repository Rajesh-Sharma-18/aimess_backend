export const openApiSchemas = {
  // ===========================================================================
  // Shared media descriptor — reusable object-storage reference returned
  // ADDITIVELY alongside the legacy flat avatarUrl/coverUrl/objectKey/... fields.
  // ===========================================================================
  MediaObject: {
    type: "object",
    description:
      "Reusable media descriptor for an object-storage asset. Returned ADDITIVELY alongside the legacy flat fields (avatarUrl/coverUrl/objectKey/downloadUrl/uploadUrl, etc.). All nine scalar fields are always present (may be null); `uploadHeaders` is only present on upload-url responses.",
    properties: {
      mediaId: {
        type: "string",
        nullable: true,
        description:
          "Stable, immutable media identity — independent of objectKey/url, never changes for this file. Null for legacy media registered before this field existed.",
      },
      fileId: { type: "string", nullable: true },
      objectKey: { type: "string", nullable: true },
      fileName: { type: "string", nullable: true },
      contentType: { type: "string", nullable: true },
      size: { type: "integer", nullable: true },
      downloadUrl: { type: "string", nullable: true },
      downloadUrlExpiresIn: { type: "integer", nullable: true },
      uploadUrl: { type: "string", nullable: true },
      uploadUrlExpiresIn: { type: "integer", nullable: true },
      uploadHeaders: {
        type: "object",
        additionalProperties: { type: "string" },
        description:
          "Headers the client must send on the PUT to uploadUrl. Present only on upload-url responses.",
      },
    },
    required: [
      "fileId",
      "objectKey",
      "fileName",
      "contentType",
      "size",
      "downloadUrl",
      "downloadUrlExpiresIn",
      "uploadUrl",
      "uploadUrlExpiresIn",
    ],
    example: {
      fileId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      objectKey: "uploads/users/abc123/a1b2c3d4.webp",
      fileName: "profile-photo.jpg",
      contentType: "image/webp",
      size: 204800,
      downloadUrl:
        "https://storage.example.com/uploads/users/abc123/a1b2c3d4.webp?X-Amz-Expires=3600&...",
      downloadUrlExpiresIn: 3600,
      uploadUrl: null,
      uploadUrlExpiresIn: null,
    },
  },

  MediaUploadUrlResponse: {
    type: "object",
    required: [
      "uploadUrl",
      "objectKey",
      "uploadExpiresIn",
      "maxBytes",
      "headers",
      "media",
    ],
    properties: {
      uploadUrl: {
        type: "string",
        example:
          "https://storage.example.com/avatars/user123/abc.webp?X-Amz-Expires=900&...",
      },
      objectKey: { type: "string", example: "avatars/user123/a1b2c3d4.webp" },
      uploadExpiresIn: {
        type: "integer",
        example: 900,
        description: "Presigned URL lifetime in seconds.",
      },
      maxBytes: {
        type: "integer",
        example: 5242880,
        description: "Maximum file size in bytes for this category.",
      },
      headers: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Headers the client must include on the PUT to uploadUrl.",
        example: { "Content-Type": "image/jpeg" },
      },
      media: { $ref: "#/components/schemas/MediaObject" },
    },
    example: {
      uploadUrl:
        "https://storage.example.com/avatars/user123/a1b2c3d4.webp?X-Amz-Expires=900&X-Amz-Signature=...",
      objectKey: "avatars/user123/a1b2c3d4.webp",
      uploadExpiresIn: 900,
      maxBytes: 5242880,
      media: {
        fileId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        objectKey: "avatars/user123/a1b2c3d4.webp",
        fileName: null,
        contentType: "image/jpeg",
        size: null,
        downloadUrl: null,
        downloadUrlExpiresIn: null,
        uploadUrl: "https://storage.example.com/...",
        uploadUrlExpiresIn: 900,
        uploadHeaders: { "Content-Type": "image/jpeg" },
      },
    },
  },

  MediaDownloadUrlResponse: {
    type: "object",
    required: ["downloadUrl", "downloadUrlExpiresIn", "media"],
    properties: {
      downloadUrl: {
        type: "string",
        example:
          "https://storage.example.com/avatars/user123/abc.webp?X-Amz-Expires=3600&...",
      },
      downloadUrlExpiresIn: {
        type: "integer",
        example: 3600,
        description: "Presigned URL lifetime in seconds.",
      },
      media: { $ref: "#/components/schemas/MediaObject" },
    },
  },

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
      mode: { type: "string", enum: ["offset", "keyset"], example: "offset" },
      page: { type: "integer", example: 1 },
      limit: { type: "integer", example: 20 },
      total: { type: "integer", example: 5234 },
      totalApprox: { type: "integer", example: 5234 },
      totalPages: { type: "integer", example: 262 },
      hasNext: { type: "boolean", example: true },
      hasPrev: { type: "boolean", example: false },
      nextCursor: { type: "string", nullable: true },
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
  AdminRefreshRequest: {
    type: "object",
    required: ["refreshToken"],
    properties: {
      refreshToken: {
        type: "string",
        description:
          "Opaque admin refresh token from login or a previous refresh",
      },
    },
  },
  AdminTokens: {
    type: "object",
    description:
      "Admin token pair — access token is a compact JWT (8h, JWT_ADMIN_SECRET); refresh token is an opaque random string (7d) hashed at rest and validated server-side. Expiries are in seconds.",
    properties: {
      accessToken: { type: "string", example: "eyJhbGciOiJIUzI1NiIs..." },
      refreshToken: {
        type: "string",
        example:
          "hOY0NnBT5NzlJuC9iWpXW16Eh1RLJY2piemrzYfPh7VeMeSJm9sr_IiNilQb7PI6",
      },
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
      message: { type: "string", example: "Login successful." },
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
      avatar: {
        allOf: [{ $ref: "#/components/schemas/MediaObject" }],
        nullable: true,
        description:
          "Standard avatar object (see MediaObject) — matches the shape used across every other admin API. `null` when no avatar is set. Replaces the legacy bare avatarUrl string.",
      },
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
    required: ["id", "email", "avatar", "role", "permissions"],
  },
  AdminLogoutResponse: {
    type: "object",
    description:
      "Successful admin logout — standard `{ success, message, data }` envelope confirming the current session was revoked.",
    properties: {
      success: { type: "boolean", example: true },
      message: { type: "string", example: "Logged out successfully" },
      data: {
        type: "object",
        properties: {
          loggedOut: { type: "boolean", example: true },
        },
        required: ["loggedOut"],
      },
    },
    required: ["success", "data"],
  },
  AdminUpdateMeRequest: {
    type: "object",
    description:
      "Self-service profile update body. At least one field required. `avatarObjectKey` is the MinIO object key returned by the shared `/media/upload-url` USER_AVATAR flow; pass `null` to clear the avatar.",
    properties: {
      username: {
        type: "string",
        minLength: 2,
        maxLength: 100,
        example: "Ops Admin",
      },
      email: {
        type: "string",
        format: "email",
        example: "ops@aimess.io",
      },
      avatarObjectKey: {
        type: "string",
        nullable: true,
        example: "avatars/adm_1/2026-07/abc.png",
        description:
          "MinIO object key from the shared upload flow. `null` clears the current avatar.",
      },
    },
  },
  AdminChangePasswordRequest: {
    type: "object",
    required: ["currentPassword", "newPassword", "confirmPassword"],
    properties: {
      currentPassword: { type: "string", example: "OldP@ss1" },
      newPassword: {
        type: "string",
        minLength: 6,
        example: "NewStr0ng!",
        description:
          "≥6 chars with at least one upper, lower, digit and special char.",
      },
      confirmPassword: {
        type: "string",
        example: "NewStr0ng!",
        description: "Must equal `newPassword`.",
      },
    },
  },
  AdminChangePasswordResponse: {
    type: "object",
    description: "Successful admin self-service password change.",
    properties: {
      success: { type: "boolean", example: true },
      message: {
        type: "string",
        example: "Password changed successfully.",
      },
      data: {
        type: "object",
        properties: {
          passwordChanged: { type: "boolean", example: true },
        },
        required: ["passwordChanged"],
      },
    },
    required: ["success", "data"],
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
        minLength: 6,
        example: "N3w$trongPass99!",
        description:
          "Min 6 chars as CURRENTLY ENFORCED by password-reset.validator.ts (an in-code comment there and an earlier version of this doc both said 12 — that was never the enforced rule; confirm with backend before relying on either number). Must include uppercase, lowercase, a digit and a special character.",
      },
      confirmPassword: {
        type: "string",
        minLength: 6,
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
  AdminDashboardOverview: {
    type: "object",
    description:
      "Stat-card payload returned by GET /admin/v1/dashboard/overview.",
    properties: {
      stats: { $ref: "#/components/schemas/AdminDashboardStats" },
    },
    required: ["stats"],
  },
  AdminDashboardCharts: {
    type: "object",
    description:
      "Chart payload returned by GET /admin/v1/dashboard/charts — the active-vs-churned series (filtered by `?period=`) and the communities/groups donut.",
    properties: {
      activeVsChurned: { $ref: "#/components/schemas/AdminActiveVsChurned" },
      communitiesGroups: {
        $ref: "#/components/schemas/AdminCommunitiesGroups",
      },
    },
    required: ["activeVsChurned", "communitiesGroups"],
  },
  AdminDashboardServiceStatusResponse: {
    type: "object",
    description:
      "Service-status payload returned by GET /admin/v1/dashboard/service-status.",
    properties: {
      serviceStatus: { $ref: "#/components/schemas/AdminServiceStatus" },
    },
    required: ["serviceStatus"],
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
        description: "STATIC stub for now — no live source wired yet.",
      },
      openReports: {
        type: "integer",
        example: 8,
        description: "STATIC stub for now — no live source wired yet.",
      },
      bannedUsers: { type: "integer", example: 34 },
      churnedUsers: {
        type: "integer",
        example: 0,
        description: "STATIC stub (0) for now — no live source wired yet.",
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
                "Optional short reason string — set on degraded/down rows (probe error, HTTP status code, slow-response warning).",
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
    description:
      "Source of truth: apps/backoffice-service/src/types/user-management.types.ts UserListItem.",
    properties: {
      userId: { type: "string", example: "u_8f3a" },
      username: { type: "string", example: "brianna" },
      fullName: {
        type: "string",
        nullable: true,
        description:
          "firstName + lastName (trimmed, single-spaced). Null when both are absent.",
        example: "Brianna Doe",
      },
      email: { type: "string", nullable: true, example: "b@x.com" },
      status: {
        type: "string",
        enum: ["ACTIVE", "BANNED", "SUSPENDED", "DELETED"],
        example: "ACTIVE",
      },
      joinedAt: { type: "string", format: "date-time" },
      reportCount: { type: "integer", example: 2 },
      avatar: {
        allOf: [{ $ref: "#/components/schemas/MediaObject" }],
        nullable: true,
        description:
          "Standard avatar object; `null` when no avatar is set. Replaces the legacy bare avatarUrl string.",
      },
      moderationStatus: {
        type: "string",
        enum: ["ACTIVE", "BANNED"],
        description:
          "Simplified 2-value moderation view derived from `status` (BANNED covers both a permanent ban and a time-boxed suspension). Never replaces `status`.",
        example: "ACTIVE",
      },
      isBanned: {
        type: "boolean",
        description:
          "True iff the user is currently BANNED or SUSPENDED. Lets the admin panel pick the Ban/Unban row action without an extra request.",
        example: false,
      },
      bannedAt: {
        type: "string",
        format: "date-time",
        nullable: true,
        description: "Present only when `isBanned` is true.",
      },
      bannedBy: {
        type: "string",
        nullable: true,
        description:
          "actorId of the admin who applied the currently active ban/suspend. Present only when `isBanned` is true.",
      },
      banReason: {
        type: "string",
        nullable: true,
        description: "Present only when `isBanned` is true.",
      },
    },
    required: [
      "userId",
      "username",
      "status",
      "joinedAt",
      "reportCount",
      "moderationStatus",
      "isBanned",
    ],
  },
  AdminCommunityMember: {
    type: "object",
    description:
      "One row of a community's member roster (denormalized snapshot from community-service).",
    properties: {
      userId: { type: "string", example: "u_8f3a" },
      username: {
        type: "string",
        description: "Display name (falls back to the @handle).",
        example: "John Doe",
      },
      handle: { type: "string", example: "john_doe_02" },
      avatar: {
        allOf: [{ $ref: "#/components/schemas/MediaObject" }],
        nullable: true,
        description:
          "Standard avatar object; `null` when no avatar is set. Replaces the legacy bare avatarUrl string.",
      },
      role: {
        type: "string",
        enum: ["ADMIN", "MODERATOR", "MEMBER"],
        example: "ADMIN",
      },
      status: { type: "string", example: "ACTIVE" },
      joinedAt: { type: "string", format: "date-time" },
    },
    required: ["userId", "username", "role", "joinedAt"],
  },
  AdminUserCommunity: {
    type: "object",
    description:
      "One row of the user's 'Communities' grid — a community the user is an ACTIVE member of (denormalized snapshot from community-service; avatar already presigned).",
    properties: {
      communityId: { type: "string", example: "comm_001" },
      name: { type: "string", example: "Indie Game Devs" },
      avatar: {
        allOf: [{ $ref: "#/components/schemas/MediaObject" }],
        nullable: true,
        description:
          "Standard avatar object; `null` when no avatar is set. Replaces the legacy bare avatarUrl string.",
      },
      category: {
        type: "object",
        properties: {
          id: { type: "string", example: "cat_07" },
          name: { type: "string", example: "Gaming" },
        },
        required: ["id", "name"],
      },
      description: { type: "string", example: "" },
      memberCount: { type: "integer", example: 1240 },
      role: {
        type: "string",
        enum: ["ADMIN", "MODERATOR", "MEMBER"],
        example: "MEMBER",
      },
      joinedAt: { type: "string", format: "date-time" },
      createdAt: { type: "string", format: "date-time" },
    },
    required: [
      "communityId",
      "name",
      "category",
      "memberCount",
      "role",
      "joinedAt",
      "createdAt",
    ],
  },
  AdminUserCommunityListResponse: {
    type: "object",
    description:
      "Envelope for the user's communities grid: `{ success, data: { items, pagination } }`.",
    properties: {
      success: { type: "boolean", example: true },
      data: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: { $ref: "#/components/schemas/AdminUserCommunity" },
          },
          pagination: { $ref: "#/components/schemas/AdminPagination" },
        },
        required: ["items", "pagination"],
      },
    },
    required: ["success", "data"],
  },
  AdminOtherCommunityMember: {
    type: "object",
    description:
      "One row of the co-member grid — another member of a community the viewed user belongs to (the viewed user is excluded). Email hydrated from auth-service (null when unavailable).",
    properties: {
      userId: { type: "string", example: "u_8f3a" },
      username: { type: "string", example: "John Doe" },
      email: { type: "string", nullable: true, example: "john@example.com" },
      avatar: {
        allOf: [{ $ref: "#/components/schemas/MediaObject" }],
        nullable: true,
        description:
          "Standard avatar object; `null` when no avatar is set. Replaces the legacy bare avatarUrl string.",
      },
      role: {
        type: "string",
        enum: ["ADMIN", "MODERATOR", "MEMBER"],
        example: "MEMBER",
      },
      joinedAt: { type: "string", format: "date-time" },
    },
    required: ["userId", "username", "role", "joinedAt"],
  },
  AdminOtherCommunityMembersResponse: {
    type: "object",
    description:
      "Envelope for the co-member grid: `{ success, data: { community, items, pagination } }`.",
    properties: {
      success: { type: "boolean", example: true },
      data: {
        type: "object",
        properties: {
          community: {
            type: "object",
            properties: {
              communityId: { type: "string", example: "comm_001" },
              name: { type: "string", example: "Indie Game Devs" },
              memberCount: { type: "integer", example: 1240 },
            },
            required: ["communityId", "name", "memberCount"],
          },
          items: {
            type: "array",
            items: {
              $ref: "#/components/schemas/AdminOtherCommunityMember",
            },
          },
          pagination: { $ref: "#/components/schemas/AdminPagination" },
        },
        required: ["community", "items", "pagination"],
      },
    },
    required: ["success", "data"],
  },
  AdminUserReport: {
    type: "object",
    description:
      "One row of the 'Reported Details' panel — a report filed against the user, with the reporter resolved. Offset-only pagination (no cursor).",
    properties: {
      reportId: { type: "string", example: "r_12" },
      reason: { type: "string", example: "HARASSMENT" },
      details: {
        type: "string",
        nullable: true,
        description: "Reporter free-text ('Other Reason').",
      },
      otherReason: {
        type: "string",
        nullable: true,
        description:
          'Custom description when `reason` is "OTHER"; null for every predefined reason.',
        example: "User continuously shares phishing links.",
      },
      status: {
        type: "string",
        enum: ["PENDING", "UNDER_REVIEW", "RESOLVED", "DISMISSED", "ESCALATED"],
        example: "PENDING",
      },
      createdAt: { type: "string", format: "date-time" },
      communityId: {
        type: "string",
        nullable: true,
        description:
          "Community the report was filed in; null for community-less reports (e.g. private-message reports).",
      },
      communityName: {
        type: "string",
        nullable: true,
        description:
          "Name of `communityId`'s community; null when absent/unresolved.",
        example: "Tech Community",
      },
      reporter: {
        type: "object",
        properties: {
          userId: { type: "string", example: "u_aa" },
          username: { type: "string", nullable: true },
          fullname: {
            type: "string",
            nullable: true,
            description:
              "firstName + lastName (trimmed, single-spaced). Null when both are absent.",
            example: "John Doe",
          },
          avatar: {
            allOf: [{ $ref: "#/components/schemas/MediaObject" }],
            nullable: true,
            description:
              "Standard avatar object; `null` when no avatar is set. Replaces the legacy bare avatarUrl string.",
          },
        },
        required: ["userId"],
      },
    },
    required: [
      "reportId",
      "reason",
      "otherReason",
      "status",
      "createdAt",
      "communityId",
      "communityName",
      "reporter",
    ],
  },
  AdminUserDetail: {
    type: "object",
    description:
      "Full user profile: identity (auth-service) + profile (user-service) + report summary (admin_db). Source of truth: apps/backoffice-service/src/types/user-management.types.ts UserDetail.",
    properties: {
      profile: {
        type: "object",
        properties: {
          userId: { type: "string", example: "u_8f3a" },
          username: { type: "string", example: "brianna" },
          fullName: {
            type: "string",
            nullable: true,
            description:
              "firstName + lastName (trimmed, single-spaced). Null when both are absent.",
            example: "Brianna Doe",
          },
          email: {
            type: "string",
            nullable: true,
            description:
              "Null when the user has no email on file (never an empty string).",
          },
          avatar: {
            allOf: [{ $ref: "#/components/schemas/MediaObject" }],
            nullable: true,
            description:
              "Standard avatar object; `null` when no avatar is set. Only avatar field this endpoint returns (no flat avatarUrl/avatarUrlExpiresIn siblings).",
          },
          joinedAt: { type: "string", format: "date-time" },
          lastActiveAt: { type: "string", format: "date-time", nullable: true },
        },
        required: ["userId", "username", "joinedAt"],
      },
      accountStatus: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["ACTIVE", "BANNED", "SUSPENDED", "DELETED"],
          },
          since: { type: "string", format: "date-time", nullable: true },
          reason: { type: "string", nullable: true },
          suspendedUntil: {
            type: "string",
            format: "date-time",
            nullable: true,
          },
          appliedBy: {
            type: "string",
            nullable: true,
            description: "actorId of the most recent moderation action.",
          },
          moderationStatus: {
            type: "string",
            enum: ["ACTIVE", "BANNED"],
            description:
              "Simplified 2-value moderation view derived from `status` (BANNED covers both a permanent ban and a time-boxed suspension). Never replaces `status`.",
          },
          isBanned: {
            type: "boolean",
            description: "True iff `status` is currently BANNED or SUSPENDED.",
          },
        },
        required: ["status", "moderationStatus", "isBanned"],
      },
      reportDetails: {
        type: "object",
        description:
          "'Report Details' panel. Single source for report data on the detail screen — no other field duplicates this data.",
        properties: {
          reporter: {
            type: "string",
            nullable: true,
            description:
              "Username of the most recent reporter, or null when the user has no reports.",
            example: "alice",
          },
          reportDate: {
            type: "string",
            format: "date-time",
            nullable: true,
            description:
              "createdAt of the most recent report, or null when the user has no reports.",
          },
          reportCount: {
            type: "integer",
            example: 9,
            description:
              "Total reports filed against this user, across every reason (predefined + custom).",
          },
          topReasons: {
            type: "array",
            description:
              'Predefined report reasons only (excludes "OTHER"), aggregated to one count per reason. Empty array when the user has no reports.',
            items: {
              type: "object",
              properties: {
                reason: { type: "string", example: "SPAM" },
                count: { type: "integer", example: 3 },
              },
              required: ["reason", "count"],
            },
          },
          otherReasons: {
            type: "array",
            description:
              'Reports filed under the custom "OTHER" reason (one entry per report), each with its free-text description, reporter, and timestamp. Never mixed into `topReasons`. Empty array when none exist.',
            items: {
              type: "object",
              properties: {
                description: {
                  type: "string",
                  example: "Fake profile pictures",
                  description:
                    "Reporter-supplied free-text description (mandatory when filing an OTHER report).",
                },
                reportedBy: {
                  type: "string",
                  nullable: true,
                  description:
                    "Username of the reporter, or null when unresolved.",
                  example: "alice",
                },
                reportedAt: { type: "string", format: "date-time" },
              },
              required: ["description", "reportedBy", "reportedAt"],
            },
          },
        },
        required: [
          "reporter",
          "reportDate",
          "reportCount",
          "topReasons",
          "otherReasons",
        ],
      },
    },
    required: ["profile", "accountStatus", "reportDetails"],
  },
  AdminUserBanReasonCode: {
    type: "string",
    enum: [
      "SPAM",
      "HARASSMENT",
      "HATE_SPEECH",
      "NUDITY",
      "VIOLENCE",
      "IMPERSONATION",
      "MISINFORMATION",
      "ILLEGAL_CONTENT",
      "OTHER",
    ],
    example: "HARASSMENT",
  },
  AdminSuspendRequest: {
    type: "object",
    description:
      "POST /admin/v1/users/{userId}/suspend. durationDays is REQUIRED here (no default) — unlike ban, where it is optional.",
    required: ["reason", "durationDays"],
    properties: {
      reason: { $ref: "#/components/schemas/AdminUserBanReasonCode" },
      durationDays: {
        type: "integer",
        minimum: 1,
        example: 7,
        description: "Required. suspendedUntil = now + durationDays.",
      },
      note: { type: "string", maxLength: 2000, nullable: true },
      notifyUser: { type: "boolean", default: false },
    },
  },
  AdminBanRequest: {
    type: "object",
    description:
      "POST /admin/v1/users/{userId}/ban. If durationDays is omitted/null this is a PERMANENT ban; if durationDays > 0 it is treated as a time-boxed suspend (status becomes SUSPENDED, not BANNED).",
    required: ["reason"],
    properties: {
      reason: {
        oneOf: [
          { $ref: "#/components/schemas/AdminUserBanReasonCode" },
          {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description: "Any free-text custom reason.",
          },
        ],
        description:
          "Either a predefined reason code, OR any custom free-text reason (max 200 chars) typed by the admin. Stored verbatim.",
        example: "HARASSMENT",
      },
      note: { type: "string", maxLength: 2000, nullable: true },
      durationDays: {
        type: "integer",
        minimum: 1,
        nullable: true,
        default: null,
        description: "Omit/null = permanent ban. > 0 = time-boxed suspend.",
      },
      reportId: { type: "string", format: "uuid", nullable: true },
      notifyUser: { type: "boolean", default: false },
      forceLogout: { type: "boolean", default: true },
    },
  },
  AdminUnbanRequest: {
    type: "object",
    description: "POST /admin/v1/users/{userId}/unban. Only field accepted.",
    properties: {
      note: { type: "string", maxLength: 2000, nullable: true },
    },
  },
  AdminModerationResult: {
    type: "object",
    description:
      "Actual result shape returned by ban/suspend/unban (backoffice-service UserStatusResult). Writes a ModerationAction + AuditLog and fire-and-forgets an admin.user_* RabbitMQ event (queue admin.user.queue) — publish failures are only logged, never fail the request. No Socket.IO event is emitted by this service.",
    properties: {
      userId: { type: "string", example: "u_8f3a" },
      status: {
        type: "string",
        enum: ["ACTIVE", "BANNED", "SUSPENDED"],
        example: "BANNED",
      },
      suspendedUntil: { type: "string", format: "date-time", nullable: true },
      bannedAt: { type: "string", format: "date-time", nullable: true },
    },
    required: ["userId", "status"],
  },
  AdminBulkBanRequest: {
    type: "object",
    description:
      "POST /admin/v1/users/bulk/ban. `reason` accepts a predefined code or a custom free-text reason — same rules as the single ban endpoint.",
    required: ["userIds", "reason"],
    properties: {
      userIds: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: { type: "string", minLength: 1, maxLength: 64 },
      },
      reason: {
        oneOf: [
          { $ref: "#/components/schemas/AdminUserBanReasonCode" },
          {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description: "Any free-text custom reason.",
          },
        ],
        description:
          "Either a predefined reason code, OR any custom free-text reason (max 200 chars). Applied to every user in the batch.",
        example: "HARASSMENT",
      },
      note: { type: "string", maxLength: 2000, nullable: true },
      durationDays: { type: "integer", minimum: 1, nullable: true },
      reportId: { type: "string", format: "uuid", nullable: true },
      notifyUser: { type: "boolean", default: false },
      forceLogout: { type: "boolean", default: true },
    },
  },
  AdminBulkActivateRequest: {
    type: "object",
    description:
      "POST /admin/v1/users/bulk/activate. Already-ACTIVE users are idempotently reported as succeeded (ok:true, changed:false) and do NOT write an audit row or publish an event.",
    required: ["userIds"],
    properties: {
      userIds: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: { type: "string", minLength: 1, maxLength: 64 },
      },
      note: { type: "string", maxLength: 2000, nullable: true },
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
      avatar: {
        allOf: [{ $ref: "#/components/schemas/MediaObject" }],
        nullable: true,
        description:
          "Standard avatar object — matches the shape used across User APIs / Community Details. `null` when no avatar is set. Replaces the legacy avatarUrl string field.",
      },
    },
    required: ["userId", "name", "avatar"],
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
      avatar: {
        allOf: [{ $ref: "#/components/schemas/MediaObject" }],
        nullable: true,
        description:
          "Community's own avatar/profile image — same MediaObject structure as GET /api/v1/communities/{communityId}. `null` when no avatar is set.",
      },
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
      "avatar",
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
      avatar: {
        allOf: [{ $ref: "#/components/schemas/MediaObject" }],
        nullable: true,
        description:
          "Standard avatar object — matches the shape used across User APIs / Community Details. `null` when no avatar is set. Replaces the legacy avatarUrl string field.",
      },
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
      "avatar",
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
          avatar: {
            allOf: [{ $ref: "#/components/schemas/MediaObject" }],
            nullable: true,
            description:
              "Standard avatar object — matches the shape used across User APIs / Community Details. `null` when no avatar is set. Replaces the legacy avatarUrl string field.",
          },
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
          "avatar",
          "coverUrl",
          "createdAt",
          "lastActivityAt",
        ],
      },
      owner: { $ref: "#/components/schemas/AdminCommunityOwner" },
      memberStats: {
        type: "integer",
        description: "Current total community members.",
        example: 21,
      },
      livestreamStats: {
        type: "integer",
        description: "Total livestreams associated with the community.",
        example: 0,
      },
    },
    required: ["community", "owner", "memberStats", "livestreamStats"],
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
  AdminGroupAdmin: {
    type: "object",
    description:
      "Group owner identity, composed from the chat-service group (role=OWNER member, fallback createdBy) + user-service (username/avatar) + auth-service (email). email/avatar are null when the upstream identity could not be resolved.",
    properties: {
      userId: {
        type: "string",
        example: "9f3a1c2e-0b6d-4e2a-8b11-2c4d5e6f7a8b",
      },
      username: { type: "string", example: "ada.lovelace" },
      email: {
        type: "string",
        format: "email",
        nullable: true,
        example: "ada@aimess.io",
      },
      avatar: {
        allOf: [{ $ref: "#/components/schemas/MediaObject" }],
        nullable: true,
        description:
          "Standard avatar object; `null` when no avatar is set. Replaces the legacy bare avatarUrl string.",
      },
    },
    required: ["userId", "username"],
  },
  AdminGroup: {
    type: "object",
    description:
      "Admin view of a chat-service GroupRoom (gRPC-live). `id` is the group's roomId.",
    properties: {
      id: { type: "string", example: "grp_9a" },
      name: { type: "string", example: "Project X" },
      avatar: {
        allOf: [{ $ref: "#/components/schemas/MediaObject" }],
        nullable: true,
        description:
          "Standard avatar object; `null` when no avatar is set. Replaces the legacy bare avatarUrl string.",
      },
      description: { type: "string", example: "Sprint coordination room" },
      memberCount: { type: "integer", example: 1250 },
      createdAt: { type: "string", format: "date-time" },
      admin: { $ref: "#/components/schemas/AdminGroupAdmin" },
    },
    required: ["id", "name", "memberCount", "createdAt", "admin"],
  },
  AdminGroupMember: {
    type: "object",
    description: "Admin view of a chat-service group member.",
    properties: {
      userId: {
        type: "string",
        example: "9f3a1c2e-0b6d-4e2a-8b11-2c4d5e6f7a8b",
      },
      username: { type: "string", example: "ada.lovelace" },
      email: {
        type: "string",
        format: "email",
        nullable: true,
        example: "ada@aimess.io",
      },
      avatar: {
        allOf: [{ $ref: "#/components/schemas/MediaObject" }],
        nullable: true,
        description:
          "Standard avatar object; `null` when no avatar is set. Replaces the legacy bare avatarUrl string.",
      },
      role: {
        type: "string",
        enum: ["OWNER", "ADMIN", "MODERATOR", "MEMBER"],
        example: "ADMIN",
      },
      joinedAt: { type: "string", format: "date-time" },
    },
    required: ["userId", "username", "role", "joinedAt"],
  },
  AdminGroupPagination: {
    type: "object",
    description: "Offset pagination meta for the group read endpoints.",
    properties: {
      page: { type: "integer", example: 1 },
      limit: { type: "integer", example: 20 },
      total: { type: "integer", example: 500 },
      totalPages: { type: "integer", example: 25 },
      hasNext: { type: "boolean", example: true },
      hasPrevious: { type: "boolean", example: false },
    },
    required: [
      "page",
      "limit",
      "total",
      "totalPages",
      "hasNext",
      "hasPrevious",
    ],
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
      avatar: {
        allOf: [{ $ref: "#/components/schemas/MediaObject" }],
        nullable: true,
        description:
          "Standard avatar object; `null` when no avatar is set. Replaces the legacy bare avatarUrl string.",
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
      communityName: {
        type: "string",
        nullable: true,
        description:
          "Name of the community the report was filed in; null for community-less reports (e.g. private-message reports).",
        example: "Design Lovers",
      },
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
      "communityName",
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
  AdminReportModerationUserRef: {
    type: "object",
    description:
      "Compact user reference on the Reports & Moderation Details page.",
    properties: {
      id: { type: "string", example: "u_8f3a" },
      username: { type: "string", example: "jdoe" },
      fullName: { type: "string", example: "John Doe" },
      avatar: {
        allOf: [{ $ref: "#/components/schemas/MediaObject" }],
        nullable: true,
        description:
          "Standard avatar object; `null` when no avatar is set. Replaces the legacy bare avatarUrl string.",
      },
    },
    required: ["id", "username", "fullName", "avatar"],
  },
  AdminCommunityReportBlock: {
    type: "object",
    description: "Compact community reference on a report.",
    properties: {
      id: { type: "string", example: "comm_001" },
      name: { type: "string", example: "Indie Game Devs" },
      handle: { type: "string", example: "@indie_devs" },
      avatar: {
        allOf: [{ $ref: "#/components/schemas/MediaObject" }],
        nullable: true,
        description: "Standard avatar object; `null` when no avatar is set.",
      },
    },
    required: ["id", "name", "handle", "avatar"],
  },
  AdminLivestreamReportBlock: {
    type: "object",
    description:
      "Reported livestream — the stream's useful details (present only for LIVESTREAM reports).",
    properties: {
      id: { type: "string", example: "stream_9f2" },
      title: { type: "string", example: "Late-night live coding" },
      description: { type: "string", example: "Building the admin panel" },
      status: {
        type: "string",
        example: "ENDED",
        description: "LIVE | ENDED | SCHEDULED | CANCELLED (as stored).",
      },
      thumbnail: {
        allOf: [{ $ref: "#/components/schemas/MediaObject" }],
        nullable: true,
        description: "Standard media object; `null` when no thumbnail is set.",
      },
      viewerCount: {
        type: "integer",
        example: 200,
        description:
          "TOTAL unique viewers over the stream's lifetime (host + co-hosts + speakers + viewers, current and departed; reconnects deduped). Independent of status.",
      },
      activeViewerCount: {
        type: "integer",
        example: 0,
        description: "Currently watching; 0 once the stream has ended.",
      },
      duration: {
        type: "integer",
        format: "int64",
        example: 3600000,
        description: "Stream duration in milliseconds.",
      },
      startedAt: {
        type: "integer",
        format: "int64",
        nullable: true,
        example: 1783765815123,
        description: "Epoch milliseconds; `null` if never went live.",
      },
      endedAt: {
        type: "integer",
        format: "int64",
        nullable: true,
        example: 1783769415123,
        description: "Epoch milliseconds; `null` while still live/scheduled.",
      },
      host: {
        allOf: [{ $ref: "#/components/schemas/AdminReportModerationUserRef" }],
        nullable: true,
      },
    },
    required: [
      "id",
      "title",
      "description",
      "status",
      "thumbnail",
      "viewerCount",
      "activeViewerCount",
      "duration",
      "startedAt",
      "endedAt",
      "host",
    ],
  },
  AdminMessageReportBlock: {
    type: "object",
    description:
      "Reported community message (present only for MESSAGE reports). Content/media are best-effort `null` until an admin message-content RPC exists in chat-service; the reported `id`/`senderId` are always available.",
    properties: {
      id: { type: "string", example: "msg_42" },
      messageType: { type: "string", nullable: true, example: "TEXT" },
      text: { type: "string", nullable: true, example: "spam spam spam" },
      content: { type: "string", nullable: true },
      media: {
        type: "array",
        items: { $ref: "#/components/schemas/MediaObject" },
      },
      sentAt: {
        type: "integer",
        format: "int64",
        nullable: true,
        example: 1783765815123,
        description: "Epoch milliseconds.",
      },
      senderId: { type: "string", nullable: true, example: "u_1" },
    },
    required: [
      "id",
      "messageType",
      "text",
      "content",
      "media",
      "sentAt",
      "senderId",
    ],
  },
  AdminReportModerationDetail: {
    type: "object",
    description:
      "Aggregate for the admin Reports & Moderation Details page: `{ success, data }`. `data.reportType` identifies the reported entity and drives which entity blocks are present:\n- `USER` → reportedUser only\n- `COMMUNITY` → reportedUser, community, communityAdmin\n- `LIVESTREAM` → reportedUser, community, communityAdmin, livestream\n- `MESSAGE` → reportedUser, community, communityAdmin, message\n\nA community is never itself reportable: a reported community MEMBER is a `COMMUNITY` report; a reported community MESSAGE is a `MESSAGE` report. All timestamps are epoch milliseconds.",
    properties: {
      success: { type: "boolean", example: true },
      data: {
        type: "object",
        properties: {
          id: { type: "string", example: "RPT-2026-0001284" },
          reportType: {
            type: "string",
            enum: ["USER", "COMMUNITY", "LIVESTREAM", "MESSAGE"],
            example: "COMMUNITY",
            description:
              "Reported entity kind. (COMMENT is reserved for future livestream-comment reports and is not emitted yet.)",
          },
          reportReason: { type: "string", example: "Spam Messages" },
          reportMessage: {
            type: "string",
            nullable: true,
            example: "Kept posting spam links",
          },
          reportStatus: {
            $ref: "#/components/schemas/AdminModerationStatus",
          },
          createdAt: {
            type: "integer",
            format: "int64",
            example: 1783765815123,
            description: "Epoch milliseconds.",
          },
          updatedAt: {
            type: "integer",
            format: "int64",
            example: 1783765824000,
            description: "Epoch milliseconds.",
          },
          reporter: {
            allOf: [
              { $ref: "#/components/schemas/AdminReportModerationUserRef" },
            ],
            nullable: true,
          },
          reportedUser: {
            allOf: [
              { $ref: "#/components/schemas/AdminReportModerationUserRef" },
            ],
            nullable: true,
          },
          community: {
            allOf: [{ $ref: "#/components/schemas/AdminCommunityReportBlock" }],
            nullable: true,
            description:
              "Present for COMMUNITY / LIVESTREAM / MESSAGE reports; omitted for USER reports.",
          },
          communityAdmin: {
            allOf: [
              { $ref: "#/components/schemas/AdminReportModerationUserRef" },
            ],
            nullable: true,
            description:
              "Community's current ADMIN. Present for COMMUNITY / LIVESTREAM / MESSAGE reports; omitted for USER reports.",
          },
          livestream: {
            allOf: [
              { $ref: "#/components/schemas/AdminLivestreamReportBlock" },
            ],
            nullable: true,
            description: "Present only for LIVESTREAM reports.",
          },
          message: {
            allOf: [{ $ref: "#/components/schemas/AdminMessageReportBlock" }],
            nullable: true,
            description: "Present only for MESSAGE reports.",
          },
        },
        required: [
          "id",
          "reportType",
          "reportReason",
          "reportMessage",
          "reportStatus",
          "createdAt",
          "updatedAt",
          "reporter",
          "reportedUser",
        ],
      },
    },
    required: ["success", "data"],
  },
  AdminReportUserItem: {
    type: "object",
    description:
      "One row in the Report Details users list — a community member (COMMUNITY/MESSAGE reports) or a livestream viewer (LIVESTREAM reports), unified. `avatar` is the standard media object; `joinedAt` is epoch ms.",
    properties: {
      userId: { type: "string", example: "u_1" },
      username: { type: "string", example: "jdoe" },
      displayName: { type: "string", example: "John Doe" },
      avatar: {
        allOf: [{ $ref: "#/components/schemas/MediaObject" }],
        nullable: true,
      },
      role: {
        type: "string",
        description:
          "Community reports: ADMIN|MODERATOR|MEMBER|BANNED. Livestream reports: Admin|Moderator|Member (viewer's current community role).",
        example: "MEMBER",
      },
      joinedAt: {
        type: "integer",
        format: "int64",
        example: 1783745454545,
        description: "Epoch milliseconds.",
      },
    },
    required: [
      "userId",
      "username",
      "displayName",
      "avatar",
      "role",
      "joinedAt",
    ],
  },
  AdminReportUsersPagination: {
    type: "object",
    description: "Slim offset pagination for the Report Details users list.",
    properties: {
      page: { type: "integer", example: 1 },
      limit: { type: "integer", example: 20 },
      total: { type: "integer", example: 0 },
      totalPages: { type: "integer", example: 0 },
    },
    required: ["page", "limit", "total", "totalPages"],
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

  // ===========================================================================
  // Stream Service — user-facing schemas
  // ===========================================================================

  StreamView: {
    type: "object",
    description: "A livestream record as seen by any authenticated user.",
    required: [
      "id",
      "communityId",
      "creatorId",
      "title",
      "sourceType",
      "status",
      "commentStatus",
      "viewerCount",
      "peakViewers",
      "totalViews",
      "totalComments",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: { type: "string", example: "64a1b2c3d4e5f6a7b8c9d0e1" },
      communityId: {
        type: "string",
        example: "550e8400-e29b-41d4-a716-446655440000",
      },
      creatorId: {
        type: "string",
        example: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      },
      title: { type: "string", example: "Weekly Dev Q&A" },
      description: { type: "string", example: "Ask me anything." },
      thumbnail: {
        type: "string",
        nullable: true,
        example: "stream/thumbnail/64a1.../uuid.jpg",
        description: "MinIO object key for the thumbnail image.",
      },
      sourceType: {
        type: "string",
        enum: ["PHONE_CAMERA", "URL", "YOUTUBE"],
        example: "PHONE_CAMERA",
      },
      sourceUrl: {
        type: "string",
        nullable: true,
        example: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      },
      status: {
        type: "string",
        enum: ["PENDING", "LIVE", "ENDED", "CANCELLED"],
        example: "LIVE",
      },
      commentStatus: {
        type: "boolean",
        example: true,
        description: "true = chat open, false = chat frozen.",
      },
      hlsUrl: {
        type: "string",
        nullable: true,
        example: "http://srs.example.com:8080/live/abc123.m3u8",
      },
      flvUrl: {
        type: "string",
        nullable: true,
        example: "http://srs.example.com:8080/live/abc123.flv",
      },
      dashUrl: {
        type: "string",
        nullable: true,
        example: "http://srs.example.com:8080/live/abc123.mpd",
      },
      viewerCount: {
        type: "integer",
        example: 42,
        description:
          "Live count (from Redis when LIVE, DB fallback otherwise).",
      },
      peakViewers: { type: "integer", example: 87 },
      totalViews: { type: "integer", example: 512 },
      totalComments: { type: "integer", example: 203 },
      livedAt: { type: "string", format: "date-time", nullable: true },
      endedAt: { type: "string", format: "date-time", nullable: true },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },

  StreamCreateResult: {
    type: "object",
    description: "Stream record plus owner-only fields returned on creation.",
    allOf: [{ $ref: "#/components/schemas/StreamView" }],
    properties: {
      streamKey: {
        type: "string",
        example: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
        description:
          "32-char hex key for OBS/SRS RTMP. NEVER share with viewers.",
      },
      ingest: {
        type: "object",
        description:
          "Publish endpoints for PHONE_CAMERA mode (null for YOUTUBE).",
        properties: {
          whipUrl: {
            type: "string",
            nullable: true,
            example:
              "http://srs.example.com:1985/rtc/v1/whip/?app=live&stream=abc123",
          },
          rtmpUrl: {
            type: "string",
            nullable: true,
            example: "rtmp://srs.example.com/live/abc123",
          },
        },
      },
    },
  },

  StreamComment: {
    type: "object",
    description: "A single livestream comment.",
    required: [
      "id",
      "livestreamId",
      "sentBy",
      "senderName",
      "message",
      "createdAt",
    ],
    properties: {
      id: { type: "string", example: "64a1b2c3d4e5f6a7b8c9d0e1" },
      livestreamId: { type: "string" },
      sentBy: { type: "string", description: "userId of the author (UUID)." },
      senderName: {
        type: "string",
        example: "alice",
        description: "Snapshot display name at send time.",
      },
      senderAvatar: {
        type: "string",
        nullable: true,
        description: "Snapshot avatar MinIO key.",
      },
      message: { type: "string", maxLength: 500, example: "Great stream!" },
      clientCommentId: {
        type: "string",
        nullable: true,
        description: "Client-supplied idempotency key.",
      },
      createdAt: { type: "string", format: "date-time" },
    },
  },

  StreamBanItem: {
    type: "object",
    description: "A single ban entry on a livestream.",
    required: ["userId", "bannedAt"],
    properties: {
      userId: { type: "string", description: "UUID of the banned user." },
      reason: { type: "string", nullable: true, example: "Spamming" },
      bannedAt: { type: "string", format: "date-time" },
    },
  },

  StreamCommentReport: {
    type: "object",
    description: "A user-submitted report on a live chat comment.",
    required: [
      "id",
      "commentId",
      "livestreamId",
      "reportedBy",
      "reason",
      "createdAt",
    ],
    properties: {
      id: { type: "string", example: "64a1b2c3d4e5f6a7b8c9d0e1" },
      commentId: {
        type: "string",
        example: "64a1b2c3d4e5f6a7b8c9d0e2",
        description: "ObjectId of the reported comment.",
      },
      livestreamId: { type: "string", example: "64a1b2c3d4e5f6a7b8c9d0e3" },
      reportedBy: {
        type: "string",
        example: "550e8400-e29b-41d4-a716-446655440000",
        description: "userId who submitted the report.",
      },
      reason: {
        type: "string",
        enum: [
          "OFFENSIVE_LANGUAGE",
          "SPAM",
          "INAPPROPRIATE_CONTENT",
          "SCAM_OR_FRAUD",
          "IMPERSONATION",
          "OTHER",
        ],
        example: "SPAM",
      },
      details: {
        type: "string",
        nullable: true,
        maxLength: 500,
        example: "Flooding the chat with the same link.",
      },
      createdAt: { type: "string", format: "date-time" },
    },
  },

  StreamCommentReportWithComment: {
    type: "object",
    description:
      "A comment report enriched with the reported comment's content.",
    required: [
      "id",
      "commentId",
      "livestreamId",
      "reportedBy",
      "reason",
      "createdAt",
      "comment",
    ],
    properties: {
      id: { type: "string", example: "64a1b2c3d4e5f6a7b8c9d0e1" },
      commentId: { type: "string", example: "64a1b2c3d4e5f6a7b8c9d0e2" },
      livestreamId: { type: "string", example: "64a1b2c3d4e5f6a7b8c9d0e3" },
      reportedBy: {
        type: "string",
        example: "550e8400-e29b-41d4-a716-446655440000",
        description: "userId who submitted the report.",
      },
      reporterUsername: {
        type: "string",
        description: 'Reporter\'s snapshot username; "" if unavailable.',
      },
      reporterDisplayName: {
        type: "string",
        description: 'Reporter\'s snapshot display name; "" if unavailable.',
      },
      reporterAvatar: {
        type: "string",
        description:
          "Reporter's raw avatar object key; \"\" if none. Resolve like a comment's senderAvatar.",
      },
      reason: {
        type: "string",
        enum: [
          "OFFENSIVE_LANGUAGE",
          "SPAM",
          "INAPPROPRIATE_CONTENT",
          "SCAM_OR_FRAUD",
          "IMPERSONATION",
          "OTHER",
        ],
        example: "SPAM",
      },
      details: { type: "string", nullable: true, maxLength: 500 },
      createdAt: { type: "string", format: "date-time" },
      comment: {
        type: "object",
        nullable: true,
        description:
          "The reported comment's current content; null if it was deleted.",
        properties: {
          id: { type: "string" },
          sentBy: { type: "string" },
          senderName: { type: "string" },
          message: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
    },
  },

  StreamCommentReportList: {
    type: "object",
    required: ["items", "nextCursor", "hasMore"],
    properties: {
      items: {
        type: "array",
        items: {
          $ref: "#/components/schemas/StreamCommentReportWithComment",
        },
      },
      nextCursor: {
        type: "string",
        nullable: true,
        description: "Pass as `before` for the next page; null when no more.",
      },
      hasMore: { type: "boolean" },
    },
  },

  // ===========================================================================
  // Admin Livestream schemas
  // ===========================================================================

  AdminLivestreamItem: {
    type: "object",
    description: "Compact livestream row for the admin list table.",
    required: [
      "livestreamId",
      "title",
      "status",
      "community",
      "creator",
      "createdAt",
    ],
    properties: {
      livestreamId: { type: "string", example: "64a1b2c3d4e5f6a7b8c9d0e1" },
      title: { type: "string", example: "Weekly Dev Q&A" },
      status: {
        type: "string",
        enum: ["LIVE", "ENDED", "SCHEDULED", "CANCELLED"],
        description: "SCHEDULED maps to a stream-service PENDING stream.",
      },
      community: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          slug: { type: "string" },
          avatar: {
            allOf: [{ $ref: "#/components/schemas/MediaObject" }],
            nullable: true,
            description:
              "Standard avatar object (see MediaObject) — matches the shape used across User APIs / Community Details. `null` when no avatar is set. Replaces the legacy avatarUrl string field.",
          },
        },
      },
      creator: {
        type: "object",
        properties: {
          id: { type: "string" },
          username: { type: "string" },
          displayName: { type: "string" },
          avatar: {
            allOf: [{ $ref: "#/components/schemas/MediaObject" }],
            nullable: true,
            description:
              "Standard avatar object (see MediaObject) — matches the shape used across User APIs / Community Details. `null` when no avatar is set. Replaces the legacy avatarUrl string field.",
          },
        },
      },
      category: {
        type: "object",
        description:
          "The stream's community category (streams have no own category).",
        properties: {
          id: { type: "string" },
          name: { type: "string", example: "Technology" },
          slug: { type: "string", example: "technology" },
        },
      },
      createdAt: { type: "string", format: "date-time" },
      startedAt: { type: "string", format: "date-time" },
      endedAt: { type: "string", format: "date-time", nullable: true },
      durationSeconds: { type: "integer", example: 3600 },
      viewerCount: {
        type: "integer",
        example: 134,
        description:
          "TOTAL unique users who joined this stream at least once during its lifetime (host + co-hosts + speakers + viewers, current and departed; reconnects deduped by userId). Independent of status.",
      },
      reportCount: { type: "integer", example: 2 },
      reportSeverity: {
        type: "string",
        enum: ["NONE", "LOW", "MEDIUM", "HIGH"],
      },
      thumbnailUrl: { type: "string", nullable: true },
    },
  },

  AdminLivestreamDetail: {
    type: "object",
    description:
      "Full livestream detail returned by GET /admin/v1/livestreams/{id}.",
    required: ["livestreamId", "title", "status"],
    properties: {
      livestreamId: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      status: { type: "string", enum: ["LIVE", "ENDED", "CANCELLED"] },
      thumbnailUrl: { type: "string", nullable: true },
      endReasonCode: { type: "string", nullable: true },
      endedBy: {
        type: "object",
        nullable: true,
        properties: {
          adminId: { type: "string" },
          adminName: { type: "string" },
        },
      },
      community: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          slug: { type: "string" },
          avatar: {
            allOf: [{ $ref: "#/components/schemas/MediaObject" }],
            nullable: true,
            description:
              "Standard avatar object; `null` when no avatar is set. Replaces the legacy bare avatarUrl string.",
          },
          memberCount: { type: "integer" },
          creatorRole: { type: "string" },
        },
      },
      creator: {
        type: "object",
        properties: {
          id: { type: "string" },
          username: { type: "string" },
          displayName: { type: "string" },
          avatar: {
            allOf: [{ $ref: "#/components/schemas/MediaObject" }],
            nullable: true,
            description:
              "Standard avatar object; `null` when no avatar is set. Replaces the legacy bare avatarUrl string.",
          },
          accountStatus: { type: "string" },
          totalStreams: { type: "integer" },
          priorStrikes: { type: "integer" },
        },
      },
      viewerStats: {
        type: "object",
        properties: {
          currentViewers: { type: "integer" },
          peakViewers: { type: "integer" },
          totalUniqueViewers: { type: "integer" },
          chatMessageCount: { type: "integer" },
        },
      },
      reportsSummary: {
        type: "object",
        properties: {
          total: { type: "integer" },
          open: { type: "integer" },
          reviewing: { type: "integer" },
          resolved: { type: "integer" },
          dismissed: { type: "integer" },
          severity: { type: "string", enum: ["NONE", "LOW", "MEDIUM", "HIGH"] },
        },
      },
      moderationHistory: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            action: { type: "string" },
            adminId: { type: "string" },
            adminName: { type: "string" },
            reasonCode: { type: "string", nullable: true },
            note: { type: "string", nullable: true },
            createdAt: { type: "string", format: "date-time" },
          },
        },
      },
      createdAt: { type: "string", format: "date-time" },
      startedAt: { type: "string", format: "date-time" },
      endedAt: { type: "string", format: "date-time", nullable: true },
    },
  },

  AdminLivestreamReport: {
    type: "object",
    description: "A single report filed against a livestream.",
    properties: {
      reportId: { type: "string" },
      livestreamId: { type: "string" },
      reporter: {
        type: "object",
        properties: {
          id: { type: "string" },
          username: { type: "string" },
          displayName: { type: "string" },
        },
      },
      reportType: {
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
      description: { type: "string" },
      status: {
        type: "string",
        enum: ["OPEN", "REVIEWING", "RESOLVED", "DISMISSED"],
      },
      resolution: {
        type: "object",
        nullable: true,
        properties: {
          action: { type: "string" },
          note: { type: "string", nullable: true },
          resolvedBy: { type: "string" },
          resolvedAt: { type: "string", format: "date-time" },
        },
      },
      createdAt: { type: "string", format: "date-time" },
    },
  },

  AdminLivestreamUserItem: {
    type: "object",
    description:
      "A viewer-session row for this stream (who watched, not the community roster — see the endpoint description).",
    properties: {
      userId: { type: "string" },
      username: { type: "string", example: "john_doe" },
      fullName: {
        type: "string",
        example: "John Doe",
        description:
          "Same format as the livestream detail's `creator.displayName`: `firstName lastName` trimmed, falling back to `username` when both name parts are empty. Empty string only when the user profile cannot be resolved.",
      },
      avatar: {
        allOf: [{ $ref: "#/components/schemas/MediaObject" }],
        nullable: true,
        description:
          "Standard avatar object; `null` when no avatar is set. Replaces the legacy bare avatarUrl string.",
      },
      joinedAt: { type: "string", format: "date-time" },
      leftAt: {
        type: "string",
        format: "date-time",
        nullable: true,
        description: "null = still watching.",
      },
      watchDurationSeconds: { type: "integer", example: 340 },
      type: {
        type: "string",
        enum: ["Host", "Admin", "Moderator", "Member"],
        description:
          "`Host` for the stream creator (always surfaced, even if they broadcast via RTMP and never emit `stream:join`). Otherwise the viewer's CURRENT community role, defaulting to `Member` when they are no longer a member of the stream's community.",
      },
    },
    required: [
      "userId",
      "username",
      "fullName",
      "joinedAt",
      "watchDurationSeconds",
      "type",
    ],
  },

  AdminEndLivestreamResult: {
    type: "object",
    description: "Result of ending a single livestream via admin action.",
    properties: {
      livestreamId: { type: "string" },
      status: { type: "string", example: "ENDED" },
      endedAt: { type: "string", format: "date-time" },
      endedBy: {
        type: "object",
        properties: {
          adminId: { type: "string" },
          adminName: { type: "string" },
        },
      },
      reasonCode: { type: "string" },
      moderationActionId: { type: "string" },
      auditLogId: { type: "string", nullable: true },
      creatorNotified: { type: "boolean" },
      strikeIssued: { type: "boolean" },
    },
  },

  AdminBulkResult: {
    type: "object",
    description: "Aggregate result of a bulk operation.",
    properties: {
      requested: { type: "integer", example: 5 },
      succeeded: { type: "integer", example: 4 },
      failed: { type: "integer", example: 1 },
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            ok: { type: "boolean" },
            status: { type: "string", nullable: true },
            error: {
              type: "object",
              nullable: true,
              properties: {
                code: { type: "string" },
                message: { type: "string" },
              },
            },
          },
        },
      },
    },
  },

  AdminThumbnailPresignResult: {
    type: "object",
    description: "Presigned PUT URL for a stream thumbnail admin upload.",
    required: ["uploadUrl", "objectKey", "expiresIn", "maxBytes", "headers"],
    properties: {
      uploadUrl: {
        type: "string",
        example:
          "https://minio.example.com/aimess-stream/stream/thumbnail/abc/uuid.jpg?X-Amz-Expires=300&...",
        description:
          "Short-lived presigned PUT URL. PUT the image directly here.",
      },
      objectKey: {
        type: "string",
        example: "stream/thumbnail/64a1b2c3d4e5f6a7b8c9d0e1/f47ac10b.jpg",
        description:
          "Pass this to PATCH /admin/v1/livestreams/{id}/thumbnail to commit the upload.",
      },
      expiresIn: {
        type: "integer",
        example: 300,
        description: "URL lifetime in seconds.",
      },
      maxBytes: {
        type: "integer",
        example: 5242880,
        description: "Maximum allowed file size in bytes (5 MB).",
      },
      headers: {
        type: "object",
        additionalProperties: { type: "string" },
        example: { "Content-Type": "image/jpeg" },
        description: "Headers the client must set on the PUT request.",
      },
    },
  },

  // ---- Livestreams (legacy stub — kept for backward compat, prefer AdminLivestreamItem) ----
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
  // Source of truth: apps/backoffice-service/src/types/announcement.types.ts +
  // src/api/validators/announcement.validator.ts. NOTE: there is NO i18n
  // (single flat title/description strings) and NO update endpoint — only
  // create + read + list exist.
  AdminAnnouncementTarget: {
    type: "string",
    enum: ["ALL", "COMMUNITY"],
    example: "ALL",
  },
  AdminAnnouncementStatus: {
    type: "string",
    enum: ["SCHEDULED", "PROCESSING", "SENT", "FAILED"],
    example: "SENT",
  },
  AdminAnnouncementListItem: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      title: { type: "string", example: "Scheduled maintenance" },
      target: { $ref: "#/components/schemas/AdminAnnouncementTarget" },
      communityId: { type: "string", nullable: true },
      recipientCount: { type: "integer", example: 12000 },
      status: { $ref: "#/components/schemas/AdminAnnouncementStatus" },
      announcedAt: {
        type: "string",
        format: "date-time",
        description: "sentAt if delivered, else createdAt.",
      },
    },
    required: [
      "id",
      "title",
      "target",
      "recipientCount",
      "status",
      "announcedAt",
    ],
  },
  AdminAnnouncement: {
    type: "object",
    description:
      "Full announcement detail (GET /admin/v1/announcements/{id} and the create response).",
    properties: {
      id: { type: "string", format: "uuid" },
      title: { type: "string", example: "Scheduled maintenance" },
      description: {
        type: "string",
        example: "We will be down 02:00-03:00 UTC.",
      },
      target: { $ref: "#/components/schemas/AdminAnnouncementTarget" },
      communityId: {
        type: "string",
        nullable: true,
        description:
          "Required when target=COMMUNITY, must be absent when target=ALL.",
      },
      status: {
        allOf: [{ $ref: "#/components/schemas/AdminAnnouncementStatus" }],
        description:
          "SCHEDULED: not yet due. PROCESSING: in-flight delivery (poll to observe). " +
          "SENT: fully delivered, recipientCount finalized. FAILED: gave up after 3 retries, see failureReason. " +
          "No socket/webhook push exists for status changes — poll GET /announcements/{id} or the list.",
      },
      scheduledAt: { type: "string", format: "date-time", nullable: true },
      recipientCount: { type: "integer", example: 12000 },
      failureReason: { type: "string", nullable: true, maxLength: 2000 },
      createdById: { type: "string", format: "uuid" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      sentAt: { type: "string", format: "date-time", nullable: true },
    },
    required: [
      "id",
      "title",
      "description",
      "target",
      "status",
      "recipientCount",
      "createdAt",
    ],
  },
  AdminAnnouncementCreateRequest: {
    type: "object",
    required: ["title", "description", "target"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200 },
      description: { type: "string", minLength: 1, maxLength: 5000 },
      target: { $ref: "#/components/schemas/AdminAnnouncementTarget" },
      communityId: {
        type: "string",
        format: "uuid",
        nullable: true,
        description:
          "REQUIRED when target=COMMUNITY (400 if missing); FORBIDDEN when target=ALL (400 if present). Validated against community-service (404 COMMUNITY_NOT_FOUND if it doesn't exist).",
      },
      scheduledAt: {
        type: "string",
        format: "date-time",
        nullable: true,
        description:
          "Must be strictly in the future. Omit for immediate delivery (status becomes PROCESSING right away, never SENT immediately).",
      },
    },
  },

  // ---- Categories ----
  // Owned by community-service's `CommunityCategory` (community_db); the
  // admin panel manages it exclusively through a gRPC bridge — no duplicate
  // category table exists in admin_db. Single plain-text `name` (no i18n).
  AdminCategory: {
    type: "object",
    properties: {
      id: { type: "string", example: "665f1b2c3d4e5f6a7b8c9d0e" },
      name: { type: "string", example: "Technology" },
      slug: { type: "string", example: "technology" },
      visible: {
        type: "boolean",
        description: "Shown in the create-community category picker.",
        example: true,
      },
      order: { type: "integer", example: 0 },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      communityCount: {
        type: "integer",
        description:
          "Communities in this category with status=ACTIVE and deletedAt unset.",
        example: 12,
      },
    },
    required: [
      "id",
      "name",
      "slug",
      "visible",
      "order",
      "createdAt",
      "updatedAt",
      "communityCount",
    ],
  },
  AdminCategoryCreateRequest: {
    type: "object",
    required: ["name"],
    properties: {
      name: {
        type: "string",
        minLength: 2,
        maxLength: 80,
        description: "Trimmed; must be unique case-insensitively.",
        example: "Technology",
      },
    },
  },
  AdminCategoryUpdateRequest: {
    type: "object",
    description: "At least one of `name` or `visible` must be provided.",
    properties: {
      name: {
        type: "string",
        minLength: 2,
        maxLength: 80,
        example: "Renamed category",
      },
      visible: { type: "boolean", example: false },
    },
  },
  AdminCategoryVisibilityUpdateRequest: {
    type: "object",
    required: ["status"],
    properties: {
      status: {
        type: "string",
        enum: ["VISIBLE", "HIDDEN"],
        example: "HIDDEN",
      },
    },
  },

  // ---- Audit Logs ----
  // Source of truth: apps/backoffice-service/src/types/audit-log.types.ts.
  AdminAuditLog: {
    type: "object",
    description:
      "Full detail shape (GET /admin/v1/audit-logs/{id}). The list endpoint returns the same shape minus metadata/reason.",
    properties: {
      id: { type: "string", format: "uuid" },
      performer: {
        type: "object",
        description:
          "Resolved actor snapshot; fields are null if the actor row was later removed.",
        properties: {
          id: { type: "string", example: "adm_1" },
          name: { type: "string", nullable: true, example: "Jane Admin" },
          email: { type: "string", nullable: true, example: "ops@x.com" },
          avatar: {
            allOf: [{ $ref: "#/components/schemas/MediaObject" }],
            nullable: true,
            description:
              "Standard avatar object; `null` when no avatar is set. Replaces the legacy bare avatarUrl string.",
          },
        },
        required: ["id"],
      },
      action: { type: "string", example: "user.banned" },
      targetType: { type: "string", example: "user" },
      targetId: { type: "string", nullable: true, example: "u_8f3a" },
      createdAt: { type: "string", format: "date-time" },
      reason: {
        type: "string",
        nullable: true,
        description:
          "Derived: scans metadata.after then metadata.before for the first non-empty string under reason/note/reasonNote/reasonCode. Detail endpoint only.",
      },
      metadata: {
        type: "object",
        description: "Detail endpoint only.",
        properties: {
          before: { type: "object", nullable: true, example: null },
          after: {
            type: "object",
            nullable: true,
            example: { status: "BANNED", reason: "SPAM" },
          },
          ip: { type: "string", nullable: true, example: "203.0.113.7" },
          userAgent: { type: "string", nullable: true },
        },
      },
    },
    required: ["id", "performer", "action", "targetType", "createdAt"],
  },

  // ---- Admin Accounts ----
  // Source of truth: apps/backoffice-service/src/types/admin-account.types.ts.
  // NOTE: no per-admin permission overrides and no TOTP/2FA enrolment flow
  // exist today — the only mutable RBAC surface is swapping an admin's whole
  // role (PATCH .../permissions with { roleKey }).
  AdminRoleKey: {
    type: "string",
    enum: ["SUPER_ADMIN", "ADMIN", "MODERATOR", "SUPPORT_AGENT", "ANALYST"],
    example: "MODERATOR",
  },
  AdminAccountRoleRef: {
    type: "object",
    properties: {
      key: { $ref: "#/components/schemas/AdminRoleKey" },
      name: { type: "string", example: "Moderator" },
    },
    required: ["key", "name"],
  },
  AdminAccount: {
    type: "object",
    description:
      "Row shape for both the list endpoint and the single-account detail endpoint.",
    properties: {
      id: { type: "string", format: "uuid" },
      email: { type: "string", format: "email", example: "mod@aimess.io" },
      name: { type: "string", example: "Mod User" },
      avatar: {
        allOf: [{ $ref: "#/components/schemas/MediaObject" }],
        nullable: true,
        description:
          "Standard avatar object; `null` when no avatar is set. Replaces the legacy bare avatarUrl string.",
      },
      role: { $ref: "#/components/schemas/AdminAccountRoleRef" },
      status: {
        type: "string",
        enum: ["ACTIVE", "DISABLED", "INVITED", "DELETED"],
        example: "ACTIVE",
      },
      lastLoginAt: { type: "string", format: "date-time", nullable: true },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: ["id", "email", "name", "role", "status"],
  },
  AdminAccountCreateRequest: {
    type: "object",
    description:
      "One of `username`/`name` is required (`username` is the wire field; `name` is kept accepted for backward compatibility — same field). `roleKey` defaults to `ADMIN` when omitted.",
    required: ["email", "password"],
    properties: {
      email: { type: "string", format: "email", example: "mod@aimess.io" },
      password: {
        type: "string",
        minLength: 6,
        description:
          "Must contain at least one uppercase, one lowercase, one digit, and one special character.",
      },
      username: {
        type: "string",
        minLength: 2,
        maxLength: 100,
        example: "mod_user",
      },
      name: {
        type: "string",
        minLength: 2,
        maxLength: 100,
        example: "Mod User",
        deprecated: true,
        description: "Alias for `username`, kept for backward compatibility.",
      },
      roleKey: {
        allOf: [{ $ref: "#/components/schemas/AdminRoleKey" }],
        default: "ADMIN",
      },
      avatarUrl: {
        type: "string",
        format: "uri",
        maxLength: 500,
        nullable: true,
      },
    },
  },
  AdminAccountUpdateRequest: {
    type: "object",
    description:
      "PATCH profile fields only — role changes go through .../permissions. At least one of username, email or avatarUrl must be provided. Duplicate email/username are rejected with 409.",
    properties: {
      username: { type: "string", minLength: 2, maxLength: 100 },
      email: { type: "string", format: "email" },
      avatarUrl: {
        type: "string",
        format: "uri",
        maxLength: 500,
        nullable: true,
      },
    },
  },
  AdminAccountStatusRequest: {
    type: "object",
    description:
      "Unified activate/deactivate toggle. `INACTIVE` maps to the internal `DISABLED` status.",
    required: ["status"],
    properties: {
      status: { type: "string", enum: ["ACTIVE", "INACTIVE"] },
    },
  },
  AdminAccountRoleRequest: {
    type: "object",
    description:
      "PATCH .../permissions body. This REPLACES the admin's whole role — there is no per-permission override.",
    required: ["roleKey"],
    properties: {
      roleKey: { $ref: "#/components/schemas/AdminRoleKey" },
    },
  },
  AdminPermissionCatalogueItem: {
    type: "object",
    description:
      "One row of the full permission catalogue (GET .../admin-accounts/permissions) — use this to build a permission-picker/reference UI. group comes from the DB, not derivable from a static enum.",
    properties: {
      key: { type: "string", example: "users.read" },
      group: { type: "string", example: "Users" },
    },
    required: ["key", "group"],
  },
  AdminAccountPermissionsView: {
    type: "object",
    description:
      "Resolved (role-derived) permission set for one admin (GET/PATCH .../admin-accounts/{adminId}/permissions).",
    properties: {
      adminId: { type: "string", format: "uuid" },
      role: { $ref: "#/components/schemas/AdminAccountRoleRef" },
      permissions: {
        type: "array",
        items: { type: "string" },
        example: ["dashboard.read", "users.read", "users.moderate"],
      },
    },
    required: ["adminId", "role", "permissions"],
  },

  // ---- System Health ----
  // Source of truth: apps/backoffice-service/src/types/system-health.types.ts.
  AdminServiceHealthItem: {
    type: "object",
    properties: {
      key: {
        type: "string",
        enum: [
          "auth",
          "community",
          "chat",
          "media",
          "notification",
          "stream",
          "user",
        ],
        example: "auth",
      },
      name: { type: "string", example: "Auth Service" },
      status: {
        type: "string",
        enum: ["healthy", "degraded", "down", "unknown"],
        example: "healthy",
      },
      monitored: {
        type: "boolean",
        description:
          "Always true today — every service (auth/chat/community via gRPC ping, user/media/notification/stream via HTTP /health) is actively probed and rolled up into overall/servicesUp.",
      },
      uptimePercent: {
        type: "number",
        nullable: true,
        example: 99.8,
        description:
          "Rolling availability (%): from the opossum circuit-breaker window for gRPC-probed services (auth/chat/community); from an in-memory 100-slot probe window for the HTTP-probed services (user/media/notification/stream). Null only until the first sample lands.",
      },
      latencyMs: {
        type: "integer",
        nullable: true,
        description:
          "Measured round-trip of the live probe (gRPC ping or HTTP /health). Null only when the probe never began (rare — settle failure).",
      },
      breaker: {
        type: "string",
        nullable: true,
        enum: ["open", "half-open", null],
      },
      lastChecked: { type: "string", format: "date-time" },
      note: { type: "string" },
    },
    required: ["key", "name", "status", "monitored", "lastChecked"],
  },
  AdminInfraHealthItem: {
    type: "object",
    properties: {
      key: {
        type: "string",
        enum: ["database", "redis", "message_queue", "object_storage"],
        example: "database",
      },
      name: { type: "string", example: "PostgreSQL" },
      status: {
        type: "string",
        enum: ["healthy", "degraded", "down"],
        example: "healthy",
      },
      metrics: {
        type: "object",
        description:
          "Component-specific bag (latencyMs, engine, connection, transport, bucket, ...).",
        additionalProperties: true,
      },
      latencyMs: { type: "integer", nullable: true },
      lastChecked: { type: "string", format: "date-time" },
      note: { type: "string" },
    },
    required: ["key", "name", "status", "lastChecked"],
  },
  AdminSystemHealth: {
    type: "object",
    description:
      "GET /admin/v1/system-health. Cannot 500 by design — a partial outage still returns 200 with the affected component(s) marked down/degraded. Redis-cached, 5s TTL; lastUpdated is the true staleness indicator.",
    properties: {
      overall: { type: "string", enum: ["healthy", "degraded", "down"] },
      servicesUp: {
        type: "object",
        description:
          "Counts only MONITORED services; a degraded service still counts as up.",
        properties: {
          up: { type: "integer", example: 3 },
          total: { type: "integer", example: 3 },
          label: { type: "string", example: "3/3" },
        },
        required: ["up", "total", "label"],
      },
      lastUpdated: { type: "string", format: "date-time" },
      services: {
        type: "array",
        items: { $ref: "#/components/schemas/AdminServiceHealthItem" },
      },
      infrastructure: {
        type: "array",
        items: { $ref: "#/components/schemas/AdminInfraHealthItem" },
      },
    },
    required: [
      "overall",
      "servicesUp",
      "lastUpdated",
      "services",
      "infrastructure",
    ],
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
      primaryAccount: {
        type: "string",
        enum: ["EMAIL", "GOOGLE", "APPLE"],
        nullable: true,
        description:
          "The account's primary sign-in method. Set to the first method ever linked and never overwritten thereafter.",
        example: "EMAIL",
      },
    },
    required: ["userId", "emailVerified", "primaryAccount"],
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
      primaryAccount: {
        type: "string",
        enum: ["EMAIL", "GOOGLE", "APPLE"],
        nullable: true,
        description:
          "The account's primary sign-in method. Set to the first method ever linked and never overwritten thereafter.",
        example: "GOOGLE",
      },
    },
    required: ["provider", "primaryAccount"],
  },
  SocialUnlinkResponseData: {
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
          "Object key returned by POST /api/v1/media/upload-url (category USER_AVATAR), after you PUT the file to the presigned uploadUrl (e.g. avatars/{userId}/{uuid}.jpg). Send null to remove the avatar.",
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
  // Request/response for `POST /api/v1/users/uploads/url`, a stable alias that
  // the gateway forwards to the centralized media-service
  // `POST /api/v1/media/upload-url` (category USER_AVATAR).
  UserUploadUrlRequest: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["AVATAR"],
        description:
          "Upload type. Only AVATAR is accepted; forwarded as media category USER_AVATAR.",
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
    description:
      "Presigned upload result. Identical to the data returned by POST /api/v1/media/upload-url.",
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
      media: { $ref: "#/components/schemas/MediaObject" },
    },
    required: [
      "uploadUrl",
      "objectKey",
      "uploadExpiresIn",
      "maxBytes",
      "headers",
      "media",
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
      account: {
        type: "string",
        nullable: true,
        description:
          "Primary auth/login account (the handle used to sign in) resolved from auth-service. Null when auth-service is unavailable and no cached value exists.",
        example: "john_doe",
      },
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
      primaryAccount: {
        type: "string",
        enum: ["EMAIL", "GOOGLE", "APPLE"],
        nullable: true,
        description:
          "The first sign-in method ever linked to the account (auth-service). Always present; null when unset, missing on older records, or auth-service is unavailable.",
        example: "GOOGLE",
      },
      googleEmail: {
        type: "string",
        format: "email",
        nullable: true,
        description:
          "Email of the linked Google account. Non-null only while isGoogleLogin is true; null otherwise. Always present.",
        example: "user@gmail.com",
      },
      appleEmail: {
        type: "string",
        format: "email",
        nullable: true,
        description:
          "Email of the linked Apple account. Non-null only while isAppleLogin is true; null otherwise. Always present.",
        example: "user@privaterelay.appleid.com",
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
      avatar: { $ref: "#/components/schemas/MediaObject" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: [
      "userId",
      "username",
      "firstName",
      "lastName",
      "bio",
      "account",
      "email",
      "isGoogleLogin",
      "isAppleLogin",
      "primaryAccount",
      "googleEmail",
      "appleEmail",
      "dateOfBirth",
      "gender",
      "avatarUrl",
      "avatarUrlExpiresIn",
      "avatar",
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
    description:
      "Broadest privacy visibility union used by response payloads. Individual settings accept a per-field SUBSET on update — see FindMeScope / FriendRequestScope / OnlineStatusScope.",
  },
  CallPrivacyScope: {
    type: "string",
    enum: ["FRIENDS", "SELECTED_FRIENDS", "NO_ONE"],
    description:
      "Who may call you. `SELECTED_FRIENDS` activates the `callAllowedFriendIds` allow-list.",
  },
  FindMeScope: {
    type: "string",
    enum: ["EVERYONE", "FRIENDS_OF_FRIENDS", "NO_ONE"],
    description:
      "Accepted values for `whoCanFindMe` on update. `FRIENDS` is NOT valid here and is rejected with 400.",
  },
  FriendRequestScope: {
    type: "string",
    enum: ["EVERYONE", "FRIENDS_OF_FRIENDS", "NO_ONE"],
    description:
      "Accepted values for `whoCanSendFriendRequests` on update. `FRIENDS` is NOT valid here and is rejected with 400.",
  },
  OnlineStatusScope: {
    type: "string",
    enum: ["EVERYONE", "FRIENDS", "NO_ONE"],
    description:
      "Accepted values for `whoCanSeeOnlineStatus` on update. `FRIENDS_OF_FRIENDS` is NOT valid here and is rejected with 400.",
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
    description:
      "Partial update of the privacy group. Each field accepts a per-field SUBSET of PrivacyScope (see refs). Unknown keys are rejected (400), and the group must contain at least one field when present.",
    additionalProperties: false,
    properties: {
      whoCanFindMe: { $ref: "#/components/schemas/FindMeScope" },
      whoCanSendFriendRequests: {
        $ref: "#/components/schemas/FriendRequestScope",
      },
      whoCanSeeOnlineStatus: { $ref: "#/components/schemas/OnlineStatusScope" },
      whoCanViewProfile: { $ref: "#/components/schemas/PrivacyScope" },
      whoCanCallMe: { $ref: "#/components/schemas/CallPrivacyScope" },
      callAllowedFriendIds: {
        type: "array",
        items: { type: "string", format: "uuid" },
        maxItems: 500,
        description:
          "User IDs allowed to call you when `whoCanCallMe` is `SELECTED_FRIENDS`. Must not contain your own id (400). Duplicates are de-duplicated server-side.",
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
      expiresAt: { type: "string", format: "date-time" },
    },
    required: ["linkToken", "expiresAt"],
  },
  DeviceLinkScanRequest: {
    type: "object",
    description:
      "Telegram-style instant login: scanning IS logging in — no separate approve/reject step.",
    properties: {
      linkToken: { type: "string" },
      appVersion: { type: "string", maxLength: 100, example: "1.4.0" },
      deviceLabel: { type: "string", maxLength: 100, example: "My laptop" },
    },
    required: ["linkToken"],
  },
  DeviceLinkScanResponseData: {
    type: "object",
    allOf: [{ $ref: "#/components/schemas/AuthTokens" }],
    properties: {
      linkedAt: { type: "string", format: "date-time" },
      sessionId: {
        type: "string",
        format: "uuid",
        description:
          "Session id of the newly-linked (browser) device; revoke it via DELETE /users/linked-devices/{sessionId} to undo the link.",
      },
    },
    required: [
      "linkedAt",
      "sessionId",
      "accessToken",
      "refreshToken",
      "accessTokenExpiresIn",
      "refreshTokenExpiresIn",
    ],
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
      avatar: { $ref: "#/components/schemas/MediaObject" },
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
      "avatar",
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
      totalCount: {
        type: "integer",
        example: 128,
        description:
          "Total number of accepted friends for the caller (across all pages, ignoring the `search` filter). 0 when you have no friends.",
      },
    },
    required: ["friends", "nextCursor", "totalCount"],
  },

  // ===========================================================================
  // user-service · friend requests (friendship)
  // ===========================================================================
  FriendshipStatus: {
    type: "string",
    enum: ["PENDING", "ACCEPTED", "REJECTED", "CANCELLED", "UNFRIENDED"],
    description:
      "Lifecycle state of a friendship row. PENDING = request awaiting the addressee's decision; ACCEPTED = active friends; REJECTED = addressee declined; CANCELLED = requester withdrew; UNFRIENDED = a former friend removed the other. A single row is recycled when a request is re-sent after REJECTED/CANCELLED/UNFRIENDED.",
  },
  SendFriendRequestRequest: {
    type: "object",
    description: "Send a friend request to another user.",
    additionalProperties: false,
    properties: {
      addresseeId: {
        type: "string",
        format: "uuid",
        description:
          "userId of the person to befriend. Must differ from your own id (400). If they already sent YOU a pending request, this call auto-accepts it (status ACCEPTED).",
        example: "550e8400-e29b-41d4-a716-446655440000",
      },
    },
    required: ["addresseeId"],
  },
  Friendship: {
    type: "object",
    description:
      "A friendship row as returned by the friend-request endpoints. Timestamp fields are epoch milliseconds (numbers), per the platform response serializer; nullable timestamps are null until that transition occurs.",
    properties: {
      id: {
        type: "string",
        format: "uuid",
        description: "Friendship id — pass this to accept/reject/cancel.",
      },
      requesterId: {
        type: "string",
        format: "uuid",
        description: "userId that initiated the (current) request direction.",
      },
      addresseeId: {
        type: "string",
        format: "uuid",
        description: "userId on the receiving end of the (current) request.",
      },
      status: { $ref: "#/components/schemas/FriendshipStatus" },
      acceptedAt: {
        type: "integer",
        format: "int64",
        nullable: true,
        description: "Epoch ms when accepted; null unless status is ACCEPTED.",
        example: 1749686400000,
      },
      rejectedAt: {
        type: "integer",
        format: "int64",
        nullable: true,
        description: "Epoch ms when rejected; null unless status is REJECTED.",
      },
      cancelledAt: {
        type: "integer",
        format: "int64",
        nullable: true,
        description:
          "Epoch ms when cancelled; null unless status is CANCELLED.",
      },
      unfriendedAt: {
        type: "integer",
        format: "int64",
        nullable: true,
        description:
          "Epoch ms when unfriended; null unless status is UNFRIENDED.",
      },
      unfriendedBy: {
        type: "string",
        format: "uuid",
        nullable: true,
        description:
          "userId that performed the unfriend; null unless status is UNFRIENDED.",
      },
      createdAt: {
        type: "integer",
        format: "int64",
        description: "Epoch ms when the (current) request was created.",
        example: 1749686400000,
      },
      updatedAt: {
        type: "integer",
        format: "int64",
        description: "Epoch ms of the last state change.",
        example: 1749686400000,
      },
    },
    required: [
      "id",
      "requesterId",
      "addresseeId",
      "status",
      "acceptedAt",
      "rejectedAt",
      "cancelledAt",
      "unfriendedAt",
      "unfriendedBy",
      "createdAt",
      "updatedAt",
    ],
  },
  FriendRequestUser: {
    type: "object",
    description: "The other party in a pending friend request.",
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
      avatar: { $ref: "#/components/schemas/MediaObject" },
    },
    required: [
      "userId",
      "username",
      "firstName",
      "lastName",
      "avatarUrl",
      "avatar",
    ],
  },
  FriendRequestItem: {
    type: "object",
    properties: {
      friendshipId: {
        type: "string",
        format: "uuid",
        description: "Pass to POST accept/reject or DELETE cancel.",
      },
      direction: {
        type: "string",
        enum: ["INCOMING", "OUTGOING"],
        description:
          "INCOMING = the other user sent it to you; OUTGOING = you sent it to them.",
      },
      user: { $ref: "#/components/schemas/FriendRequestUser" },
      createdAt: {
        type: "string",
        format: "date-time",
        description: "ISO-8601 timestamp of when the request was created.",
      },
    },
    required: ["friendshipId", "direction", "user", "createdAt"],
  },
  FriendRequestsListResponseData: {
    type: "object",
    properties: {
      requests: {
        type: "array",
        items: { $ref: "#/components/schemas/FriendRequestItem" },
      },
      total: {
        type: "integer",
        example: 3,
        description:
          "Total pending requests for the caller in the requested direction. May exceed the returned page size; can also exceed `requests.length` on a page when a peer profile has been deleted.",
      },
    },
    required: ["requests", "total"],
  },

  // ===========================================================================
  // user-service · friendship record
  // ===========================================================================
  FriendshipRecord: {
    type: "object",
    description:
      "A friendship row returned by send / accept / reject / cancel operations. `status` reflects the new state after the operation.",
    properties: {
      id: { type: "string", format: "uuid", description: "Friendship ID." },
      requesterId: {
        type: "string",
        format: "uuid",
        description: "User who sent the friend request.",
      },
      addresseeId: {
        type: "string",
        format: "uuid",
        description: "User who received the friend request.",
      },
      status: {
        type: "string",
        enum: ["PENDING", "ACCEPTED", "REJECTED", "CANCELLED", "UNFRIENDED"],
        description: "Current friendship status.",
      },
      acceptedAt: {
        type: "string",
        format: "date-time",
        nullable: true,
        description: "When the request was accepted; null otherwise.",
      },
      rejectedAt: {
        type: "string",
        format: "date-time",
        nullable: true,
        description: "When the request was rejected; null otherwise.",
      },
      cancelledAt: {
        type: "string",
        format: "date-time",
        nullable: true,
        description:
          "When the request was cancelled by the sender; null otherwise.",
      },
      unfriendedAt: {
        type: "string",
        format: "date-time",
        nullable: true,
        description: "When the friendship was dissolved; null otherwise.",
      },
      unfriendedBy: {
        type: "string",
        format: "uuid",
        nullable: true,
        description: "userId of who initiated the unfriend; null otherwise.",
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: [
      "id",
      "requesterId",
      "addresseeId",
      "status",
      "acceptedAt",
      "rejectedAt",
      "cancelledAt",
      "unfriendedAt",
      "unfriendedBy",
      "createdAt",
      "updatedAt",
    ],
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
      avatar: { $ref: "#/components/schemas/MediaObject" },
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
      "avatar",
      "isOnline",
    ],
  },
  UserDiscoverySplitData: {
    type: "object",
    description:
      "Response shape when no `type` param is given. Up to 5 users per group; no pagination.",
    properties: {
      friends: {
        type: "array",
        items: { $ref: "#/components/schemas/UserDiscoveryItem" },
        description: "Accepted friends matching the query (max 5).",
      },
      otherPeople: {
        type: "array",
        items: { $ref: "#/components/schemas/UserDiscoveryItem" },
        description:
          "Non-friends matching the query, excluding blocked users (max 5).",
      },
    },
    required: ["friends", "otherPeople"],
  },
  UserDiscoveryPaginatedData: {
    type: "object",
    description:
      "Response shape when `type=friends` or `type=others` is given.",
    properties: {
      users: {
        type: "array",
        items: { $ref: "#/components/schemas/UserDiscoveryItem" },
      },
      pagination: {
        type: "object",
        properties: {
          total: {
            type: "integer",
            description: "Total matching users across all pages.",
          },
          page: { type: "integer" },
          limit: { type: "integer" },
          totalPages: { type: "integer" },
          hasNext: { type: "boolean" },
          hasPrevious: { type: "boolean" },
        },
        required: [
          "total",
          "page",
          "limit",
          "totalPages",
          "hasNext",
          "hasPrevious",
        ],
      },
    },
    required: ["users", "pagination"],
  },

  RecentSearchEntry: {
    oneOf: [
      {
        type: "object",
        description: "A user-profile tap.",
        properties: {
          id: { type: "string", format: "uuid" },
          type: { type: "string", enum: ["USER"] },
          user: {
            type: "object",
            properties: {
              userId: { type: "string", format: "uuid" },
              username: { type: "string" },
              firstName: { type: "string" },
              lastName: { type: "string" },
              bio: { type: "string", nullable: true },
              avatarUrl: { type: "string", format: "uri", nullable: true },
              avatarUrlExpiresIn: { type: "integer", nullable: true },
              avatar: { $ref: "#/components/schemas/MediaObject" },
              isOnline: { type: "boolean" },
            },
            required: [
              "userId",
              "username",
              "firstName",
              "lastName",
              "bio",
              "avatarUrl",
              "avatarUrlExpiresIn",
              "avatar",
              "isOnline",
            ],
          },
          createdAt: { type: "string", format: "date-time" },
        },
        required: ["id", "type", "user", "createdAt"],
      },
      {
        type: "object",
        description: "A text query search.",
        properties: {
          id: { type: "string", format: "uuid" },
          type: { type: "string", enum: ["QUERY"] },
          query: { type: "string", maxLength: 100 },
          createdAt: { type: "string", format: "date-time" },
        },
        required: ["id", "type", "query", "createdAt"],
      },
    ],
  },
  RecordRecentSearchBody: {
    type: "object",
    description:
      "Provide exactly one of `searchedUserId` (user tap) or `query` (text search).",
    properties: {
      searchedUserId: {
        type: "string",
        format: "uuid",
        description: "ID of the user whose profile was tapped.",
      },
      query: {
        type: "string",
        minLength: 1,
        maxLength: 100,
        description: "The search text the caller typed.",
      },
    },
  },

  UserSearchUserItem: {
    type: "object",
    description: "A User result in the unified User Search endpoint.",
    properties: {
      type: { type: "string", enum: ["USER"] },
      userId: { type: "string", format: "uuid" },
      username: { type: "string" },
      firstName: { type: "string" },
      lastName: { type: "string" },
      fullName: { type: "string" },
      avatarUrl: { type: "string", format: "uri", nullable: true },
      avatarUrlExpiresIn: { type: "integer", nullable: true },
      avatar: { $ref: "#/components/schemas/MediaObject" },
      isOnline: { type: "boolean" },
      roomId: {
        type: "string",
        nullable: true,
        description:
          "Existing private-room id with the caller, resolved dynamically; null if none.",
      },
    },
    required: [
      "type",
      "userId",
      "username",
      "firstName",
      "lastName",
      "fullName",
      "avatarUrl",
      "avatarUrlExpiresIn",
      "avatar",
      "isOnline",
      "roomId",
    ],
  },
  UserSearchGroupItem: {
    type: "object",
    description: "A Group result in the unified User Search endpoint.",
    properties: {
      type: { type: "string", enum: ["GROUP"] },
      roomId: {
        type: "string",
        description: "The group's stable id (also its chat roomId).",
      },
      name: { type: "string" },
      avatar: { type: "string" },
      description: { type: "string" },
      memberCount: { type: "integer" },
      isActiveMember: {
        type: "boolean",
        description: "Whether the caller is an ACTIVE member of this group.",
      },
    },
    required: [
      "type",
      "roomId",
      "name",
      "avatar",
      "description",
      "memberCount",
      "isActiveMember",
    ],
  },
  UserSearchResultItem: {
    oneOf: [
      { $ref: "#/components/schemas/UserSearchUserItem" },
      { $ref: "#/components/schemas/UserSearchGroupItem" },
    ],
    discriminator: { propertyName: "type" },
  },
  UserSearchData: {
    type: "object",
    description:
      "`q` empty/missing → only `recent` is present. `q` has a value → only `chat`+`other` are present.",
    properties: {
      recent: {
        type: "array",
        items: { $ref: "#/components/schemas/UserSearchResultItem" },
        description:
          "Latest 4 recently viewed Users/Groups, ordered by lastViewedAt desc. Only present when `q` is empty/missing.",
      },
      chat: {
        type: "array",
        items: { $ref: "#/components/schemas/UserSearchResultItem" },
        description:
          "Max 10: private Users with an existing room + Groups the caller actively belongs to. Only present when `q` has a value.",
      },
      other: {
        type: "array",
        items: { $ref: "#/components/schemas/UserSearchResultItem" },
        description:
          "Max `limit` (default 10, paginated): Users without a room + Groups the caller doesn't belong to. Excludes chat. Only present when `q` has a value.",
      },
    },
  },
  RecordRecentUserSearchBody: {
    type: "object",
    description: "Upsert key is (caller, targetType, targetId).",
    properties: {
      targetType: { type: "string", enum: ["USER", "GROUP"] },
      targetId: {
        type: "string",
        minLength: 1,
        maxLength: 64,
        description:
          "USER: the target userId (UUID). GROUP: the group's roomId.",
      },
    },
    required: ["targetType", "targetId"],
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
      memberLimit: {
        type: "integer",
        example: 256,
        description:
          "Static platform-wide maximum members per community (currently a fixed cap, same for all communities).",
      },
      avatarUrl: {
        type: "string",
        format: "uri",
        nullable: true,
        description: "Presigned GET URL (private MinIO).",
      },
      avatarUrlExpiresIn: { type: "integer", nullable: true, example: 3600 },
      avatar: { $ref: "#/components/schemas/MediaObject" },
      coverUrl: {
        type: "string",
        format: "uri",
        nullable: true,
        description: "Presigned GET URL (private MinIO).",
      },
      coverUrlExpiresIn: { type: "integer", nullable: true, example: 3600 },
      cover: { $ref: "#/components/schemas/MediaObject" },
      role: {
        type: "string",
        nullable: true,
        enum: ["ADMIN", "MODERATOR", "MEMBER"],
        description: "Caller's membership role; null if not a member.",
      },
      isMuted: {
        type: "boolean",
        description: "True if the caller has any mute row for this community.",
      },
      muteUntil: {
        type: "string",
        format: "date-time",
        nullable: true,
        description:
          "When the caller's mute expires; null = not muted OR muted indefinitely (use isMuted to disambiguate).",
      },
      streamEnabled: { type: "boolean" },
      chatEnabled: { type: "boolean" },
      announcementEnabled: { type: "boolean" },
      isJoined: {
        type: "boolean",
        description:
          "True when the caller is an active member of this community.",
      },
      moderationStatus: {
        type: "string",
        enum: ["ACTIVE", "SUSPENDED"],
        description:
          "ACTIVE = open; SUSPENDED = closed by a platform admin (clients show a read-only banner).",
      },
      status: {
        type: "string",
        enum: ["ACTIVE", "CLOSED"],
        description:
          "Owner-controlled lifecycle status. ACTIVE = open; CLOSED = the community owner closed it (all members removed, read-only) until reopened. This is the field clients branch on to disable community actions; `moderationStatus` is a separate platform concern. Absent on legacy data ⇒ ACTIVE.",
      },
      isLive: {
        type: "boolean",
        description:
          "True when the community has at least one active (LIVE) livestream right now. Alias of hasActiveLivestream.",
      },
      hasActiveLivestream: {
        type: "boolean",
        description:
          "Spec-aligned alias of isLive — true when ≥1 livestream is LIVE.",
      },
      activeLivestreamCount: {
        type: "integer",
        description:
          "Number of currently-LIVE streams (0–5, capped). Equals liveStreams.length.",
      },
      isMemberMuted: {
        type: "boolean",
        description:
          "True when the CALLER is currently under a moderation mute in this community (admin/moderator silenced them — they can still read but cannot post). Distinct from isMuted which is the caller's notification mute (push silence).",
      },
      memberMutedUntil: {
        type: "string",
        format: "date-time",
        nullable: true,
        description:
          "ISO-8601 expiry of the caller's moderation mute; null = indefinite mute (when isMemberMuted) or not muted.",
      },
      lastActivity: { $ref: "#/components/schemas/CommunityLastActivity" },
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
      "memberLimit",
      "avatarUrl",
      "avatarUrlExpiresIn",
      "coverUrl",
      "coverUrlExpiresIn",
      "role",
      "isMuted",
      "muteUntil",
      "isMemberMuted",
      "memberMutedUntil",
      "streamEnabled",
      "chatEnabled",
      "announcementEnabled",
      "isJoined",
      "moderationStatus",
      "status",
      "isLive",
      "hasActiveLivestream",
      "activeLivestreamCount",
      "lastActivity",
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
        description:
          "Object key returned by POST /api/v1/media/upload-url (category COMMUNITY_AVATAR).",
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
    description:
      "Partial update; at least one field required. Admin only. " +
      "Optionally supply memberIds with the complete desired member list — the service diffs it against the current ACTIVE members and adds/removes accordingly. " +
      "Newly added users have their profile snapshot (username, displayName, avatarUrl) fetched automatically via gRPC.",
    properties: {
      name: { type: "string", minLength: 3, maxLength: 50 },
      handle: { type: "string", minLength: 3, maxLength: 32 },
      type: { type: "string", enum: ["PUBLIC", "PRIVATE"] },
      categoryId: { type: "string" },
      description: { type: "string", maxLength: 500, nullable: true },
      avatarObjectKey: { type: "string", nullable: true },
      memberIds: {
        type: "array",
        items: { type: "string", format: "uuid" },
        maxItems: 500,
        description:
          "Complete desired member list (UUIDs). The service diffs against current ACTIVE members: users not in this list are removed, new users are added. BANNED users in the list are skipped.",
      },
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
  CommunityLastActivity: {
    type: "object",
    description:
      "Typed summary of the most recent community activity, derived from " +
      "denormalized fields on the Community model. Always present on " +
      "CommunityListItem (joined-mode mine list).",
    properties: {
      type: {
        type: "string",
        enum: [
          "message",
          "join",
          "removal",
          "reaction",
          "edited",
          "deleted",
          "pinned",
          "unpinned",
          "created",
        ],
        description: "Kind of activity that last updated the community.",
      },
      userId: {
        type: "string",
        nullable: true,
        description:
          "Auth user ID of the person who triggered this activity; null for 'created' type.",
      },
      username: {
        type: "string",
        nullable: true,
        description: "Display name of the actor; null for 'created' type.",
      },
      preview: {
        type: "string",
        description: "Short human-readable preview of the activity.",
      },
      dateTime: {
        type: "integer",
        format: "int64",
        description: "Activity timestamp as epoch milliseconds.",
      },
    },
    required: ["type", "userId", "username", "preview", "dateTime"],
  },
  CommunityLastMessageActivity: {
    type: "object",
    description:
      "Preview of the latest community-chat message for the list screen. " +
      "Member-only: only present for communities the caller is an ACTIVE member " +
      "of (null otherwise / when there are no messages).",
    properties: {
      username: {
        type: "string",
        description: "Display name of the last message's sender.",
      },
      message: {
        type: "string",
        description:
          "List-screen preview string (text content, or a placeholder like '📷 Photo' for media).",
      },
      dateTime: {
        type: "integer",
        format: "int64",
        description: "Timestamp of the last message as epoch milliseconds.",
      },
    },
    required: ["username", "message", "dateTime"],
  },
  AdminCategoryData: {
    type: "object",
    description: "Full category record as seen by admins.",
    properties: {
      id: { type: "string", example: "664f1a2b3c4d5e6f7a8b9c0d" },
      name: { type: "string", example: "Technology" },
      slug: { type: "string", example: "technology" },
      visible: {
        type: "boolean",
        description: "true = shown to users; false = hidden from pickers.",
        example: true,
      },
      order: {
        type: "integer",
        description: "Display order (ascending).",
        example: 0,
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      communityCount: {
        type: "integer",
        description:
          "Communities in this category with status=ACTIVE and deletedAt unset.",
        example: 12,
      },
    },
    required: [
      "id",
      "name",
      "slug",
      "visible",
      "order",
      "createdAt",
      "updatedAt",
      "communityCount",
    ],
  },
  AdminCategoryListResult: {
    type: "object",
    properties: {
      categories: {
        type: "array",
        items: { $ref: "#/components/schemas/AdminCategoryData" },
      },
      pagination: {
        type: "object",
        properties: {
          page: { type: "integer", example: 1 },
          limit: { type: "integer", example: 20 },
          total: { type: "integer", example: 42 },
          totalPages: { type: "integer", example: 3 },
          hasNext: { type: "boolean" },
          hasPrev: { type: "boolean" },
        },
        required: [
          "page",
          "limit",
          "total",
          "totalPages",
          "hasNext",
          "hasPrev",
        ],
      },
    },
    required: ["categories", "pagination"],
  },
  CommunityListItem: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      handle: { type: "string" },
      type: { type: "string", enum: ["PUBLIC", "PRIVATE"] },
      memberCount: { type: "integer" },
      memberLimit: {
        type: "integer",
        example: 256,
        description:
          "Static platform-wide maximum members per community (currently a fixed cap, same for all communities).",
      },
      avatarUrl: { type: "string", format: "uri", nullable: true },
      avatarUrlExpiresIn: { type: "integer", nullable: true },
      avatar: { $ref: "#/components/schemas/MediaObject" },
      role: { type: "string", enum: ["ADMIN", "MODERATOR", "MEMBER"] },
      isJoined: {
        type: "boolean",
        description:
          "True when the caller is an active member of this community. Always true in joined mode.",
      },
      isMuted: {
        type: "boolean",
        description: "True if the caller has any mute row for this community.",
      },
      muteUntil: {
        type: "string",
        format: "date-time",
        nullable: true,
        description:
          "When the caller's mute expires; null = not muted OR muted indefinitely (use isMuted to disambiguate).",
      },
      streamEnabled: { type: "boolean" },
      chatEnabled: { type: "boolean" },
      announcementEnabled: { type: "boolean" },
      moderationStatus: {
        type: "string",
        enum: ["ACTIVE", "SUSPENDED"],
        description:
          "ACTIVE = open; SUSPENDED = closed by admin — clients should render the community as read-only.",
      },
      isLive: {
        type: "boolean",
        description:
          "True when the community has at least one active (LIVE) livestream right now. Alias of hasActiveLivestream.",
      },
      hasActiveLivestream: {
        type: "boolean",
        description:
          "Spec-aligned alias of isLive — true when ≥1 livestream is LIVE.",
      },
      activeLivestreamCount: {
        type: "integer",
        description: "Number of currently-LIVE streams (0–5, capped).",
      },
      lastActivityAt: {
        type: "integer",
        format: "int64",
        description:
          "Latest activity (latest community message, else createdAt) as epoch milliseconds. The sort key; feed into before_ts/after_ts to page.",
      },
      unreadMessageCount: {
        type: "integer",
        default: 0,
        description:
          "Unread community-chat messages for the caller based on their last-read state. 0 when fully read or chat-service is unavailable.",
      },
      isMemberMuted: {
        type: "boolean",
        description:
          "True when the CALLER is currently under a moderation mute in this community. Distinct from isMuted which is the caller's notification mute (push silence).",
      },
      memberMutedUntil: {
        type: "string",
        format: "date-time",
        nullable: true,
        description:
          "ISO-8601 expiry of the caller's moderation mute; null = indefinite mute (when isMemberMuted) or not muted.",
      },
      lastActivity: {
        allOf: [{ $ref: "#/components/schemas/CommunityLastActivity" }],
        description:
          "Typed summary of the latest community activity (message, reaction, join, etc.). " +
          "Always present; type='created' when no chat activity has occurred.",
      },
    },
    required: [
      "id",
      "name",
      "handle",
      "type",
      "memberCount",
      "memberLimit",
      "avatarUrl",
      "avatarUrlExpiresIn",
      "role",
      "isJoined",
      "isMuted",
      "muteUntil",
      "isMemberMuted",
      "memberMutedUntil",
      "streamEnabled",
      "chatEnabled",
      "announcementEnabled",
      "moderationStatus",
      "isLive",
      "hasActiveLivestream",
      "activeLivestreamCount",
      "lastActivityAt",
      "lastActivity",
      "unreadMessageCount",
    ],
  },
  PaginationMeta: {
    type: "object",
    description:
      "Pagination metadata shared by offset/page and timestamp-cursor endpoints. " +
      "In offset mode (page param) `currentPage`/`totalPage`/`totalData` are " +
      "authoritative and `nextCursor` is null. In timestamp-cursor mode " +
      "(before_ts/after_ts) rely on `hasMore`/`nextCursor`; `currentPage` is " +
      "reported as 1 and `totalPage`/`totalData` are best-effort counts, not page anchors.",
    properties: {
      totalData: {
        type: "integer",
        description: "Total matching records.",
        example: 142,
      },
      totalPage: {
        type: "integer",
        description: "Total number of pages.",
        example: 5,
      },
      currentPage: {
        type: "integer",
        description:
          "The requested page (1-based) in offset mode; always 1 in cursor mode.",
        example: 1,
      },
      limit: {
        type: "integer",
        description: "Page size used for this response.",
        example: 30,
      },
      nextCursor: {
        type: "string",
        nullable: true,
        description:
          "Cursor for the next page. For offset/page pagination this is null (use page param). " +
          'For chat timeline (before_ts) endpoints this is a compound `"<epochMs>_<messageId>"` ' +
          "string — echo it **verbatim** as before_ts; do NOT parse to a number (the `_<id>` " +
          "tiebreaker prevents skipping messages that share the same millisecond at a page boundary). " +
          "For incremental-sync (after_ts) endpoints this is a plain epoch-ms string. " +
          "Null when hasMore is false.",
        example: "1782133107521_668f1a2b3c4d5e6f7a8b9c02",
      },
      hasMore: {
        type: "boolean",
        description:
          "True when more pages exist. In cursor mode this is computed as (returned == limit). " +
          "Use this field (not currentPage/totalPage) to decide whether to keep paginating.",
        example: true,
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
    example: {
      totalData: 142,
      totalPage: 5,
      currentPage: 1,
      limit: 30,
      nextCursor: "1782133107521_668f1a2b3c4d5e6f7a8b9c02",
      hasMore: true,
    },
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
      memberLimit: {
        type: "integer",
        example: 256,
        description:
          "Static platform-wide maximum members per community (currently a fixed cap, same for all communities).",
      },
      avatarUrl: { type: "string", format: "uri", nullable: true },
      avatarUrlExpiresIn: { type: "integer", nullable: true },
      avatar: { $ref: "#/components/schemas/MediaObject" },
      createdAt: {
        type: "integer",
        format: "int64",
        description: "Creation time as epoch milliseconds.",
      },
      unreadMessageCount: {
        type: "integer",
        default: 0,
        description:
          "Unread community-chat messages for the caller. Only present via GET /communities/mine search mode (member-only); absent on the public /communities/discover alias.",
      },
      lastActivity: {
        nullable: true,
        allOf: [{ $ref: "#/components/schemas/CommunityLastActivity" }],
        description:
          "Typed summary of the latest community activity. Only present via GET /communities/mine search mode (member-only); absent on the public /communities/discover alias.",
      },
      isJoined: {
        type: "boolean",
        description:
          "True when the caller is an active member of this community. Varies in /communities/mine search mode; always false on the deprecated public /communities/discover alias.",
      },
      hasRequested: {
        type: "boolean",
        description:
          "True when the caller has a PENDING join request for this community. Always false for communities the caller has already joined.",
      },
      isMuted: {
        type: "boolean",
        description:
          "True if the caller has any mute row for this community. Discovered communities are ones the caller is not an active member of, so this is normally false (present for parity with the other community DTOs).",
      },
      muteUntil: {
        type: "string",
        format: "date-time",
        nullable: true,
        description:
          "When the caller's mute expires; null = not muted OR muted indefinitely.",
      },
      streamEnabled: { type: "boolean" },
      chatEnabled: { type: "boolean" },
      announcementEnabled: { type: "boolean" },
      moderationStatus: {
        type: "string",
        description:
          "ACTIVE = open; SUSPENDED = closed by admin — clients should render the community as read-only.",
      },
      isLive: {
        type: "boolean",
        description:
          "True when the community has at least one active (LIVE) livestream right now. Alias of hasActiveLivestream.",
      },
      hasActiveLivestream: {
        type: "boolean",
        description:
          "Spec-aligned alias of isLive — true when ≥1 livestream is LIVE.",
      },
      activeLivestreamCount: {
        type: "integer",
        description: "Number of currently-LIVE streams (0–5, capped).",
      },
    },
    required: [
      "id",
      "name",
      "handle",
      "description",
      "type",
      "category",
      "memberCount",
      "memberLimit",
      "avatarUrl",
      "avatarUrlExpiresIn",
      "isJoined",
      "hasRequested",
      "isMuted",
      "muteUntil",
      "streamEnabled",
      "chatEnabled",
      "announcementEnabled",
      "moderationStatus",
      "isLive",
      "hasActiveLivestream",
      "activeLivestreamCount",
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
  // GET /communities/mine search-mode item: a discover item that ALWAYS carries
  // the chat-activity fields (unlike the public /discover alias, which omits
  // them). Same shape as CommunityDiscoverItem but both fields are required.
  MyCommunitiesSearchItem: {
    allOf: [{ $ref: "#/components/schemas/CommunityDiscoverItem" }],
    required: ["unreadMessageCount", "lastActivity"],
  },
  MyCommunitiesSearchResponseData: {
    type: "object",
    properties: {
      pagination: { $ref: "#/components/schemas/PaginationMeta" },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/MyCommunitiesSearchItem" },
      },
    },
    required: ["pagination", "data"],
  },
  CommunityFavoriteData: {
    type: "object",
    properties: {
      favoriteId: {
        type: "string",
        description: "MongoDB ObjectId of the favorite row.",
      },
      communityId: {
        type: "string",
        description: "MongoDB ObjectId of the community.",
      },
      createdAt: {
        type: "string",
        format: "date-time",
        description: "When the community was liked (ISO 8601).",
      },
    },
    required: ["favoriteId", "communityId", "createdAt"],
  },
  LikedCommunityItem: {
    allOf: [{ $ref: "#/components/schemas/CommunityDiscoverItem" }],
    properties: {
      likedAt: {
        type: "string",
        format: "date-time",
        description: "When the caller liked this community (ISO 8601).",
      },
    },
    required: ["likedAt"],
  },
  LikedCommunitiesResponseData: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: { $ref: "#/components/schemas/LikedCommunityItem" },
      },
      hasMore: { type: "boolean" },
      nextCursor: {
        type: "string",
        nullable: true,
        description:
          "ObjectId cursor for the next page; null when no more results.",
      },
    },
    required: ["items", "hasMore", "nextCursor"],
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
      snapshotAvatar: { $ref: "#/components/schemas/MediaObject" },
      profileUnavailable: {
        type: "boolean",
        description:
          'True only when the member\'s user profile genuinely could not be resolved (deleted user with no usable stored snapshot). When false/absent (the default), snapshotUsername/snapshotDisplayName carry the live profile when user-service resolves it, otherwise the last-known-good stored snapshot — never a synthetic "Unknown" placeholder for a valid user.',
      },
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
      isMuted: {
        type: "boolean",
        description:
          "True while a moderation mute is currently effective for this member (admin/moderator silenced them — they can still read but cannot post). Distinct from the per-user notification mute on CommunityData.isMuted.",
      },
      mutedAt: {
        type: "string",
        format: "date-time",
        nullable: true,
        description: "When the active mute was applied; null when not muted.",
      },
      mutedBy: {
        type: "string",
        format: "uuid",
        nullable: true,
        description:
          "User ID of the moderator/admin who muted the member; null when not muted.",
      },
      mutedUntil: {
        type: "string",
        format: "date-time",
        nullable: true,
        description:
          "When the mute expires; null = indefinite mute OR not muted (use isMuted to disambiguate).",
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
      "isMuted",
      "mutedAt",
      "mutedBy",
      "mutedUntil",
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
          "MEMBER_MUTED",
          "MEMBER_UNMUTED",
          "MEMBER_WARNED",
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
          "COMMUNITY_REPORT_DELETED",
          "MEMBER_LEFT",
          "INVITE_LINK_CREATED",
          "INVITE_LINK_REVOKED",
          "INVITE_LINK_REDEEMED",
          "ADMIN_SUSPEND_COMMUNITY",
          "ADMIN_REOPEN_COMMUNITY",
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
  // --- Join endpoint discriminated response shapes -------------------------
  CommunityJoinedResponse: {
    type: "object",
    description:
      "Returned with HTTP 201 when a user self-joins a PUBLIC community (or reactivates a LEFT membership).",
    required: ["status", "membershipStatus", "member"],
    properties: {
      status: {
        type: "string",
        enum: ["JOINED"],
        description: "Discriminator — always JOINED for this shape.",
      },
      membershipStatus: {
        type: "string",
        enum: ["ACTIVE"],
      },
      member: { $ref: "#/components/schemas/CommunityMemberData" },
    },
  },
  CommunityAlreadyMemberResponse: {
    type: "object",
    description:
      "Returned with HTTP 200 when the caller is already an ACTIVE member (idempotent re-join).",
    required: ["status", "membershipStatus", "member"],
    properties: {
      status: {
        type: "string",
        enum: ["ALREADY_MEMBER"],
        description: "Discriminator — always ALREADY_MEMBER for this shape.",
      },
      membershipStatus: {
        type: "string",
        enum: ["ACTIVE"],
      },
      member: { $ref: "#/components/schemas/CommunityMemberData" },
    },
  },
  CommunityJoinRequestCreatedResponse: {
    type: "object",
    description:
      "Returned with HTTP 201 when a user requests to join a PRIVATE community. Admins/mods are notified.",
    required: ["status", "membershipStatus", "request"],
    properties: {
      status: {
        type: "string",
        enum: ["REQUEST_CREATED"],
        description: "Discriminator — always REQUEST_CREATED for this shape.",
      },
      membershipStatus: {
        type: "string",
        enum: ["PENDING"],
      },
      request: { $ref: "#/components/schemas/JoinRequestData" },
    },
  },
  JoinRequestUserSummary: {
    type: "object",
    properties: {
      userId: { type: "string", format: "uuid" },
      username: { type: "string" },
      displayName: { type: "string" },
      avatarUrl: { type: "string", nullable: true },
      avatarUrlExpiresIn: { type: "integer", nullable: true },
      avatar: { $ref: "#/components/schemas/MediaObject" },
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
      memberLimit: {
        type: "integer",
        example: 256,
        description:
          "Static platform-wide maximum members per community (currently a fixed cap, same for all communities).",
      },
      avatarUrl: { type: "string", nullable: true },
      avatarUrlExpiresIn: { type: "integer", nullable: true },
      avatar: { $ref: "#/components/schemas/MediaObject" },
    },
    required: [
      "id",
      "name",
      "handle",
      "type",
      "memberCount",
      "memberLimit",
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
  BulkApproveJoinRequestsResult: {
    type: "object",
    description:
      "Result of a bulk-approve. `approved` = request IDs that were PENDING and successfully approved; `skipped` = IDs that were not found, belong to a different community, are not PENDING, or whose requester is banned.",
    properties: {
      approved: {
        type: "array",
        items: { type: "string" },
        description: "Request IDs that were approved.",
      },
      skipped: {
        type: "array",
        items: { type: "string" },
        description:
          "Request IDs that were skipped (non-pending, not found, or banned requester).",
      },
    },
    required: ["approved", "skipped"],
  },
  BulkRejectJoinRequestsResult: {
    type: "object",
    description:
      "Result of a bulk-reject. `rejected` = request IDs that were PENDING and rejected; `skipped` = IDs that were not found, belong to a different community, or are not PENDING.",
    properties: {
      rejected: {
        type: "array",
        items: { type: "string" },
        description: "Request IDs that were rejected.",
      },
      skipped: {
        type: "array",
        items: { type: "string" },
        description:
          "Request IDs that were skipped (non-pending or not found).",
      },
    },
    required: ["rejected", "skipped"],
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
    description:
      "Bulk invite request. Supply 1–50 unique user UUIDs. Duplicates are deduplicated server-side. Invalid users (banned, self, already member, already pending) are reported in the result instead of failing the entire request.",
    properties: {
      userIds: {
        type: "array",
        items: { type: "string", format: "uuid" },
        minItems: 1,
        maxItems: 50,
        description: "User IDs to invite (1–50 items).",
      },
    },
    required: ["userIds"],
    example: {
      userIds: [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ],
    },
  },
  BulkInviteUserResult: {
    type: "object",
    properties: {
      userId: { type: "string", format: "uuid" },
      outcome: {
        type: "string",
        enum: ["INVITED", "ALREADY_INVITED", "ALREADY_MEMBER", "FAILED"],
        description:
          "INVITED = new or recycled invite created; ALREADY_INVITED = existing PENDING invite (no new notification); ALREADY_MEMBER = user is already an ACTIVE member; FAILED = banned, self-invite, or other error.",
      },
      inviteId: {
        type: "string",
        description: "Present when outcome is INVITED or ALREADY_INVITED.",
      },
      reason: {
        type: "string",
        description:
          "Present when outcome is FAILED (e.g. SELF_INVITE, USER_BANNED).",
      },
    },
    required: ["userId", "outcome"],
  },
  BulkInviteResult: {
    type: "object",
    properties: {
      totalRequested: {
        type: "integer",
        description: "Number of distinct user IDs received (after dedup).",
      },
      invited: {
        type: "integer",
        description: "Users successfully invited (new invite or recycled).",
      },
      alreadyInvited: {
        type: "integer",
        description:
          "Users who already had a PENDING invite — no action taken.",
      },
      alreadyMembers: {
        type: "integer",
        description: "Users who are already ACTIVE members — skipped.",
      },
      failed: {
        type: "integer",
        description: "Users that could not be invited (banned, self, etc.).",
      },
      results: {
        type: "array",
        items: { $ref: "#/components/schemas/BulkInviteUserResult" },
      },
    },
    required: [
      "totalRequested",
      "invited",
      "alreadyInvited",
      "alreadyMembers",
      "failed",
      "results",
    ],
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
      avatar: { $ref: "#/components/schemas/MediaObject" },
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
      otherReason: {
        type: "string",
        minLength: 1,
        maxLength: 1000,
        description:
          'Mandatory custom description when `reason` is "OTHER" (rejects empty/whitespace-only values, 400). Ignored for every predefined reason.',
      },
      reportedMessageId: {
        type: "string",
        minLength: 1,
        maxLength: 100,
        description:
          "Id of the reported community message (message-level report). When set, the server resolves the message's text, media (raw object keys), and posted-at from chat-service and snapshots them onto the report — this populates the moderator card's \"Reported Content\". Best-effort: a missing / deleted-for-all / cross-room message stores the id with null content. Omit for a plain user-level report.",
      },
      reportedContentType: {
        type: "string",
        minLength: 1,
        maxLength: 40,
        description:
          "Legacy fallback (used only when reportedMessageId is absent/unresolved). CONTENT_TYPES (UPPER): TEXT | IMAGE | VIDEO | …",
      },
      reportedContentText: {
        type: "string",
        maxLength: 4000,
        description:
          "Legacy fallback — text/caption snapshot of the reported content.",
      },
      reportedContentPostedAt: {
        type: "string",
        format: "date-time",
        description:
          "Legacy fallback — ISO-8601 timestamp of when the reported content was posted.",
      },
      reportedContentMedia: {
        type: "array",
        maxItems: 10,
        description:
          "Legacy fallback — RAW object keys only; the server resolves them to presigned URLs on read. Never send presigned URLs.",
        items: {
          type: "object",
          properties: {
            objectKey: { type: "string", minLength: 1, maxLength: 512 },
            contentType: { type: "string", maxLength: 100, nullable: true },
            fileName: { type: "string", maxLength: 255, nullable: true },
            size: { type: "integer", minimum: 0, nullable: true },
          },
          required: ["objectKey"],
        },
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
      displayId: {
        type: "string",
        description:
          'Short, deterministic, display-only id derived from reportId — render as "#<displayId>" (e.g. "#99421").',
      },
      communityId: { type: "string" },
      reporterId: { type: "string", format: "uuid" },
      targetUserId: { type: "string", format: "uuid", nullable: true },
      reason: { type: "string" },
      otherReason: {
        type: "string",
        nullable: true,
        description:
          'Custom description when `reason` is "OTHER"; null for every predefined reason.',
      },
      status: {
        type: "string",
        enum: ["OPEN", "REVIEWED", "ACTIONED", "DISMISSED", "WITHDRAWN"],
      },
      reviewedBy: { type: "string", format: "uuid", nullable: true },
      reviewedAt: { type: "string", format: "date-time", nullable: true },
      resolution: { type: "string", nullable: true },
      reportedMessageId: {
        type: "string",
        nullable: true,
        description:
          "The reported community message id (null for a user-level report).",
      },
      reportedContentType: {
        type: "string",
        nullable: true,
        description:
          "CONTENT_TYPES (UPPER) of the reported content; null when none.",
      },
      reportedContentText: {
        type: "string",
        nullable: true,
        description:
          "Text/caption snapshot of the reported content; null when none.",
      },
      reportedContentPostedAt: {
        type: "string",
        format: "date-time",
        nullable: true,
        description:
          "When the reported content was originally posted; null when none.",
      },
      reportedContentMedia: {
        type: "array",
        items: { $ref: "#/components/schemas/MediaObject" },
        description:
          "Reported attachments, resolved to presigned media on read ([] when none).",
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: [
      "reportId",
      "displayId",
      "communityId",
      "reporterId",
      "targetUserId",
      "reason",
      "status",
      "reviewedBy",
      "reviewedAt",
      "resolution",
      "reportedMessageId",
      "reportedContentType",
      "reportedContentText",
      "reportedContentPostedAt",
      "reportedContentMedia",
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
      avatar: { $ref: "#/components/schemas/MediaObject" },
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
          "TOO_MANY_NOTIFICATIONS",
          "NOT_RELEVANT",
          "COMMUNITY_INACTIVE",
          "TOO_MANY_MESSAGES",
          "PRIVACY_CONCERN",
          "JOINED_BY_MISTAKE",
          "TAKING_A_BREAK",
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
      streamEnabled: { type: "boolean" },
      chatEnabled: { type: "boolean" },
      announcementEnabled: { type: "boolean" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
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
  BulkLeaveRequest: {
    type: "object",
    required: ["communityIds"],
    properties: {
      communityIds: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 50,
        description:
          "List of community ObjectIds to leave (1–50, duplicates deduplicated).",
      },
    },
  },
  BulkLeaveResultItem: {
    type: "object",
    required: ["communityId", "status"],
    properties: {
      communityId: { type: "string" },
      status: {
        type: "string",
        enum: ["LEFT", "DELETED", "FAILED"],
        description:
          "`LEFT` — caller left successfully; `DELETED` — caller was the sole member and the community was auto-deleted; `FAILED` — see `errorCode`.",
      },
      errorCode: {
        type: "string",
        enum: ["ADMIN_CANNOT_LEAVE", "NOT_MEMBER", "NOT_FOUND"],
        description:
          "Present only when `status` is `FAILED`. `ADMIN_CANNOT_LEAVE` — caller is admin and other members exist (transfer ownership first); `NOT_MEMBER` — caller is not an active member; `NOT_FOUND` — community does not exist.",
      },
    },
  },
  BulkLeaveResult: {
    type: "object",
    required: ["results", "summary"],
    properties: {
      results: {
        type: "array",
        items: { $ref: "#/components/schemas/BulkLeaveResultItem" },
        description: "Per-community outcome in the same order as the request.",
      },
      summary: {
        type: "object",
        required: ["requested", "left", "failed"],
        properties: {
          requested: {
            type: "integer",
            description: "Total communities requested.",
          },
          left: {
            type: "integer",
            description:
              "Communities successfully left (includes auto-deleted).",
          },
          failed: {
            type: "integer",
            description: "Communities that could not be left.",
          },
        },
      },
    },
  },
  BulkDeleteCommunityRequest: {
    type: "object",
    required: ["communityIds"],
    properties: {
      communityIds: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 50,
        description:
          "List of community ObjectIds to remove from the caller's community list (1–50, duplicates deduplicated).",
      },
    },
  },
  BulkDeleteCommunityResultItem: {
    type: "object",
    required: ["communityId", "status"],
    properties: {
      communityId: { type: "string" },
      status: {
        type: "string",
        enum: ["REMOVED", "SKIPPED", "FAILED"],
        description:
          "`REMOVED` — the community was removed from the caller's list (active member leave, or an already-hidden banned membership); `SKIPPED` — nothing to do (caller not a member / already left / pending); `FAILED` — see `errorCode`.",
      },
      errorCode: {
        type: "string",
        enum: ["OWNER_CANNOT_DELETE", "NOT_FOUND"],
        description:
          "Present only when `status` is `FAILED`. `OWNER_CANNOT_DELETE` — caller owns this community and must transfer ownership or delete it from the admin panel; `NOT_FOUND` — community does not exist.",
      },
    },
  },
  BulkDeleteCommunityResult: {
    type: "object",
    required: ["results", "summary"],
    properties: {
      results: {
        type: "array",
        items: { $ref: "#/components/schemas/BulkDeleteCommunityResultItem" },
        description: "Per-community outcome in the same order as the request.",
      },
      summary: {
        type: "object",
        required: ["requested", "removed", "failed"],
        properties: {
          requested: {
            type: "integer",
            description: "Total communities requested.",
          },
          removed: {
            type: "integer",
            description: "Communities removed from the caller's list.",
          },
          failed: {
            type: "integer",
            description: "Communities that could not be removed.",
          },
        },
      },
    },
  },
  BulkMuteRequest: {
    type: "object",
    required: ["action", "communityIds"],
    properties: {
      action: {
        type: "string",
        enum: ["mute", "unmute"],
        description: "Whether to mute or unmute the given communities.",
      },
      communityIds: {
        type: "array",
        items: { type: "string", pattern: "^[a-f0-9]{24}$" },
        minItems: 1,
        maxItems: 50,
        description:
          "List of community ObjectIds (duplicates are deduplicated).",
      },
      durationMinutes: {
        type: "integer",
        minimum: 1,
        maximum: 525600,
        nullable: true,
        description:
          'Only used when action is "mute". null or omitted → indefinite mute; positive integer → mute for N minutes.',
      },
    },
  },
  BulkMuteResult: {
    type: "object",
    description:
      'When action is "mute": `muted` is present. When action is "unmute": `unmuted` is present. `skipped` is always present.',
    properties: {
      muted: {
        type: "array",
        items: { type: "string" },
        description:
          'Community IDs that were successfully muted (present when action is "mute").',
      },
      unmuted: {
        type: "array",
        items: { type: "string" },
        description:
          'Community IDs that were successfully unmuted (present when action is "unmute").',
      },
      skipped: {
        type: "array",
        items: { type: "string" },
        description:
          "Community IDs skipped — already in target state or caller is not an active member.",
      },
    },
    required: ["skipped"],
  },

  BulkMarkReadRequest: {
    type: "object",
    required: ["communityIds"],
    properties: {
      communityIds: {
        type: "array",
        items: { type: "string", pattern: "^[a-f0-9]{24}$" },
        minItems: 1,
        maxItems: 50,
        description:
          "List of community ObjectIds to mark as read (duplicates are deduplicated).",
      },
    },
  },
  BulkMarkReadResult: {
    type: "object",
    properties: {
      updatedCount: {
        type: "integer",
        description:
          "Number of room-member rows whose lastReadAt was advanced.",
      },
    },
    required: ["updatedCount"],
  },

  // --- Member moderation: mute / warn -------------------------------------
  CommunityMutedMemberData: {
    type: "object",
    description: "A single moderation-muted member row.",
    properties: {
      userId: { type: "string", format: "uuid" },
      snapshotUsername: { type: "string" },
      snapshotDisplayName: { type: "string" },
      snapshotAvatarUrl: { type: "string", nullable: true },
      snapshotAvatarUrlExpiresIn: { type: "integer", nullable: true },
      snapshotAvatar: { $ref: "#/components/schemas/MediaObject" },
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
      "snapshotUsername",
      "snapshotDisplayName",
      "snapshotAvatarUrl",
      "snapshotAvatarUrlExpiresIn",
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
  CommunityBannedMemberData: {
    type: "object",
    description:
      "A single currently-banned member row (status === BANNED). Lifted bans never appear here — see the moderation audit log for history.",
    properties: {
      userId: { type: "string", format: "uuid" },
      username: { type: "string" },
      displayName: { type: "string" },
      avatarUrl: { type: "string", nullable: true },
      avatarUrlExpiresIn: { type: "integer", nullable: true },
      avatar: { $ref: "#/components/schemas/MediaObject" },
      bannedAt: {
        type: "integer",
        format: "int64",
        nullable: true,
        description: "Epoch milliseconds when the ban was applied.",
      },
      bannedBy: {
        type: "object",
        nullable: true,
        description:
          "The moderator/admin who applied the ban; displayName is null if they have left the community.",
        properties: {
          userId: { type: "string", format: "uuid" },
          displayName: { type: "string", nullable: true },
        },
        required: ["userId", "displayName"],
      },
      banReason: { type: "string", nullable: true },
      banType: {
        type: "string",
        enum: ["PERMANENT"],
        description:
          "Ban duration class. All community bans are indefinite today.",
      },
    },
    required: [
      "userId",
      "username",
      "displayName",
      "avatarUrl",
      "avatarUrlExpiresIn",
      "bannedAt",
      "bannedBy",
      "banReason",
      "banType",
    ],
  },
  CommunityBannedMembersResponseData: {
    type: "object",
    properties: {
      pagination: { $ref: "#/components/schemas/PaginationMeta" },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/CommunityBannedMemberData" },
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
      isMuted: {
        type: "boolean",
        description:
          "Derived: true when stream, chat AND announcement are all disabled (false when no mute row exists).",
      },
      createdAt: { type: "string", format: "date-time", nullable: true },
      updatedAt: { type: "string", format: "date-time", nullable: true },
    },
    required: [
      "communityId",
      "mutedUntil",
      "streamEnabled",
      "chatEnabled",
      "announcementEnabled",
      "isMuted",
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
      linkId: {
        type: "string",
        description:
          "Identifier for this link. For regular (temporary) links this is the MongoDB ObjectId of the CommunityInviteLink row. " +
          "For permanent links (`isPermanent: true`) this equals `communityId` — there is no separate DB row.",
        example: "6843e1a2b5c3d4e5f6a7b8c9",
      },
      code: {
        type: "string",
        description:
          "Alphanumeric invite code embedded in PRIVATE_INVITE URLs.",
        example: "Zk9Qw2Lp7",
      },
      url: {
        type: "string",
        description:
          "Primary shareable HTTPS link, generated from the community's privacy. " +
          "PUBLIC → handle-based & deterministic (`<base>/<handle>`, e.g. https://aimess.me/tech_community), " +
          "independent of code/expiry/usage. " +
          "PRIVATE → invite-code-based & revocable (`<base>/+<code>`, e.g. https://aimess.me/+AbCdEf123). " +
          "Falls back to the bare handle/code when INVITE_LINK_BASE_URL is unset.",
        example: "https://aimess.me/+Zk9Qw2Lp7",
      },
      appDeepLink: {
        type: "string",
        description:
          "App deep-link matching `url`. PUBLIC → aimess://resolve?handle=<handle>; " +
          "PRIVATE → aimess://join?code=<code>.",
        example: "aimess://join?code=Zk9Qw2Lp7",
      },
      linkType: {
        type: "string",
        enum: ["PUBLIC_HANDLE", "PRIVATE_INVITE"],
        description:
          "Which mechanism produced `url`/`appDeepLink`: PUBLIC_HANDLE (handle-based, PUBLIC community) " +
          "or PRIVATE_INVITE (invite-code-based, PRIVATE community). Lets clients branch without parsing the URL.",
        example: "PRIVATE_INVITE",
      },
      communityId: {
        type: "string",
        description: "MongoDB ObjectId of the community this link belongs to.",
        example: "6843d0f1a4b2c3d4e5f60719",
      },
      createdBy: {
        type: "string",
        format: "uuid",
        description: "AuthUser UUID of the member who created this link.",
        example: "22222222-2222-4222-8222-222222222222",
      },
      maxUses: {
        type: "integer",
        nullable: true,
        description: "Maximum number of redemptions; null = unlimited.",
        example: 100,
      },
      usedCount: {
        type: "integer",
        description: "Total redemptions so far.",
        example: 7,
      },
      autoApprove: {
        type: "boolean",
        description:
          "When true, redeeming this link adds the member directly (no join-request flow).",
        example: false,
      },
      expiresAt: {
        type: "string",
        format: "date-time",
        nullable: true,
        description: "ISO-8601 expiry timestamp; null = never expires.",
        example: "2026-07-24T10:00:00.000Z",
      },
      revokedAt: {
        type: "string",
        format: "date-time",
        nullable: true,
        description: "ISO-8601 revocation timestamp; null = not revoked.",
        example: null,
      },
      createdAt: {
        type: "string",
        format: "date-time",
        description: "ISO-8601 creation timestamp.",
        example: "2026-06-24T10:00:00.000Z",
      },
      isActive: {
        type: "boolean",
        description: "Computed: not revoked, not expired, not exhausted.",
        example: true,
      },
      isPermanent: {
        type: "boolean",
        description:
          "True when this is the community's permanent invitation link (stored on the Community row, not a CommunityInviteLink row). " +
          "Permanent links have no expiry, no usage cap, and `linkId` equals `communityId`. " +
          "Returned when POST /communities/:id/invite-links is called with an empty body on a PRIVATE community. " +
          "Clients should check this flag rather than parsing `linkId`.",
        example: false,
      },
    },
    required: [
      "linkId",
      "code",
      "url",
      "appDeepLink",
      "linkType",
      "communityId",
      "createdBy",
      "maxUses",
      "usedCount",
      "autoApprove",
      "expiresAt",
      "revokedAt",
      "createdAt",
      "isActive",
      "isPermanent",
    ],
    example: {
      linkId: "6843e1a2b5c3d4e5f6a7b8c9",
      code: "Zk9Qw2Lp7",
      url: "https://aimess.me/+Zk9Qw2Lp7",
      appDeepLink: "aimess://join?code=Zk9Qw2Lp7",
      linkType: "PRIVATE_INVITE",
      communityId: "6843d0f1a4b2c3d4e5f60719",
      createdBy: "22222222-2222-4222-8222-222222222222",
      maxUses: 100,
      usedCount: 7,
      autoApprove: false,
      expiresAt: "2026-07-24T10:00:00.000Z",
      revokedAt: null,
      createdAt: "2026-06-24T10:00:00.000Z",
      isActive: true,
      isPermanent: false,
    },
  },
  InviteLinkPreviewData: {
    type: "object",
    description:
      "Community preview returned when a user scans/taps an invite link before deciding to join. " +
      "Renders the community card UI (name, avatar, member count, join/request CTA) without requiring membership.",
    properties: {
      communityId: {
        type: "string",
        description: "MongoDB ObjectId of the community.",
        example: "6843d0f1a4b2c3d4e5f60719",
      },
      communityName: {
        type: "string",
        example: "Tech Enthusiasts",
      },
      description: {
        type: "string",
        nullable: true,
        example: "A place for tech lovers to share and discuss.",
      },
      avatarUrl: {
        type: "string",
        nullable: true,
        description:
          "Presigned download URL for the community avatar; null if no avatar set.",
        example:
          "https://storage.example.com/community/avatars/abc.webp?X-Amz-Expires=3600&...",
      },
      bannerUrl: {
        type: "string",
        nullable: true,
        description:
          "Presigned download URL for the community banner; null if no banner set.",
        example: null,
      },
      memberCount: {
        type: "integer",
        example: 42,
      },
      communityType: {
        type: "string",
        enum: ["PUBLIC", "PRIVATE"],
        description:
          "PUBLIC = anyone can join instantly; PRIVATE = join request or invite required.",
        example: "PRIVATE",
      },
      isJoined: {
        type: "boolean",
        description:
          "True when the caller is already an ACTIVE member of this community.",
        example: false,
      },
      joinRequestId: {
        type: "string",
        nullable: true,
        description:
          "Caller's PENDING join-request ObjectId, or null. Non-null → render a 'Cancel request' CTA instead of 'Request to join'.",
        example: null,
      },
      joinRequestStatus: {
        type: "string",
        enum: ["PENDING"],
        nullable: true,
        description:
          "Status of the caller's pending join request; null when no pending request exists.",
        example: null,
      },
      invitationCode: {
        type: "string",
        description: "The alphanumeric invite code from the link URL.",
        example: "Zk9Qw2Lp7",
      },
      inviteUrl: {
        type: "string",
        description: "Shareable HTTPS link: https://aimess.me/+<code>",
        example: "https://aimess.me/+Zk9Qw2Lp7",
      },
      appDeepLink: {
        type: "string",
        description: "App deep link: aimess://join?code=<code>",
        example: "aimess://join?code=Zk9Qw2Lp7",
      },
      expiresAt: {
        type: "integer",
        format: "int64",
        nullable: true,
        description:
          "Invite-link expiry as epoch milliseconds; null = no expiry.",
        example: 1785000000000,
      },
      creatorId: {
        type: "string",
        format: "uuid",
        description:
          "AuthUser UUID of the member who created this invite link.",
        example: "22222222-2222-4222-8222-222222222222",
      },
    },
    required: [
      "communityId",
      "communityName",
      "description",
      "avatarUrl",
      "bannerUrl",
      "memberCount",
      "communityType",
      "isJoined",
      "joinRequestId",
      "joinRequestStatus",
      "invitationCode",
      "inviteUrl",
      "appDeepLink",
      "expiresAt",
      "creatorId",
    ],
    example: {
      communityId: "6843d0f1a4b2c3d4e5f60719",
      communityName: "Tech Enthusiasts",
      description: "A place for tech lovers to share and discuss.",
      avatarUrl:
        "https://storage.example.com/community/avatars/abc.webp?X-Amz-Expires=3600",
      bannerUrl: null,
      memberCount: 42,
      communityType: "PRIVATE",
      isJoined: false,
      joinRequestId: null,
      joinRequestStatus: null,
      invitationCode: "Zk9Qw2Lp7",
      inviteUrl: "https://aimess.me/+Zk9Qw2Lp7",
      appDeepLink: "aimess://join?code=Zk9Qw2Lp7",
      expiresAt: 1785000000000,
      creatorId: "22222222-2222-4222-8222-222222222222",
    },
  },
  PublicCommunityResponse: {
    type: "object",
    description:
      "Public deep-link resolver result (GET /communities/by-handle/:handle). PUBLIC only.",
    properties: {
      communityId: { type: "string" },
      handle: { type: "string" },
      name: { type: "string" },
      description: { type: "string", nullable: true },
      avatarUrl: { type: "string", nullable: true },
      bannerUrl: { type: "string", nullable: true },
      memberCount: { type: "integer" },
      type: { type: "string", enum: ["PUBLIC"] },
      shareUrl: {
        type: "string",
        description:
          "Canonical HTTPS share URL (https://aimess.me/<handle>). Server-owned — use verbatim, do not reconstruct.",
        example: "https://aimess.me/photography_club",
      },
      appDeepLink: {
        type: "string",
        description: "App deep link (aimess://resolve?handle=<handle>).",
        example: "aimess://resolve?handle=photography_club",
      },
      isJoined: { type: "boolean" },
      role: {
        type: "string",
        enum: ["ADMIN", "MODERATOR", "MEMBER"],
        nullable: true,
      },
      isBanned: { type: "boolean" },
    },
    required: [
      "communityId",
      "handle",
      "name",
      "description",
      "avatarUrl",
      "bannerUrl",
      "memberCount",
      "type",
      "shareUrl",
      "appDeepLink",
      "isJoined",
      "role",
      "isBanned",
    ],
  },
  CreateInviteLinkRequest: {
    type: "object",
    description:
      "All fields are optional. Omit a field to use its default: unlimited uses, never expires, requires moderator approval (autoApprove: false).",
    properties: {
      maxUses: {
        type: "integer",
        minimum: 1,
        maximum: 1000,
        description:
          "Maximum number of times this link can be redeemed. Omit for unlimited.",
        example: 50,
      },
      expiresInMinutes: {
        type: "integer",
        minimum: 1,
        maximum: 525600,
        description:
          "Minutes from now until the link expires. 525600 = 1 year. Omit for no expiry.",
        example: 10080,
      },
      autoApprove: {
        type: "boolean",
        default: false,
        description:
          "When true, anyone redeeming this link is added as an ACTIVE member directly (no join-request flow). Default false: a PENDING join request is created for moderator review.",
        example: false,
      },
    },
    example: {
      maxUses: 50,
      expiresInMinutes: 10080,
      autoApprove: false,
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
      "`link` is always present. `member` is set when `autoApprove: true` (caller added directly as ACTIVE); " +
      "`request` is set when `autoApprove: false` (a PENDING join request was created for moderator review). " +
      "Exactly one of `member` / `request` is non-null on success; both are null for an already-joined caller (idempotent).",
    properties: {
      link: {
        allOf: [{ $ref: "#/components/schemas/CommunityInviteLinkData" }],
        description: "The invite-link that was redeemed (always present).",
      },
      member: {
        allOf: [{ $ref: "#/components/schemas/CommunityMemberData" }],
        nullable: true,
        description:
          "Populated when the caller was added directly as an ACTIVE member (`autoApprove: true` or already-joined idempotent case).",
      },
      request: {
        allOf: [{ $ref: "#/components/schemas/JoinRequestData" }],
        nullable: true,
        description:
          "Populated when a PENDING join request was created (`autoApprove: false`). The caller must wait for moderator approval.",
      },
    },
    required: ["link"],
  },

  // ===========================================================================
  // chat-service
  // ===========================================================================

  // --- Private rooms & messages ---
  ChatPrivateRoomPeerAvatar: {
    allOf: [{ $ref: "#/components/schemas/MediaObject" }],
    description:
      "Nested media object for the peer's avatar — same shape as a community's `avatar` (additive; mirrors `avatarUrl`).",
  },
  ChatPrivateRoomPeer: {
    type: "object",
    properties: {
      id: { type: "string" },
      displayName: { type: "string" },
      memberId: { type: "string" },
      avatar: { $ref: "#/components/schemas/ChatPrivateRoomPeerAvatar" },
      avatarUrl: {
        type: "string",
        nullable: true,
        description:
          "Flattened presigned download URL (mirrors community's `avatarUrl`).",
      },
      avatarUrlExpiresIn: { type: "integer", nullable: true },
      isDeletedUser: { type: "boolean" },
      isOnline: { type: "boolean" },
    },
    required: [
      "id",
      "displayName",
      "memberId",
      "avatar",
      "isDeletedUser",
      "isOnline",
    ],
  },
  ChatPrivateConversationLastActivity: {
    type: "object",
    description:
      "Normalized last-activity DTO — same {type,userId,username,preview,dateTime} shape as CommunityLastActivity's USER-MESSAGE case.",
    properties: {
      type: { type: "string", enum: ["message"] },
      userId: { type: "string", nullable: true },
      username: { type: "string" },
      preview: { type: "string" },
      dateTime: { type: "integer", format: "int64", description: "Epoch ms." },
    },
    required: ["type", "userId", "username", "preview", "dateTime"],
  },
  ChatPrivateRoom: {
    type: "object",
    properties: {
      id: { type: "string" },
      roomId: { type: "string" },
      participants: {
        type: "array",
        items: { type: "string" },
      },
      lastMessageAt: {
        type: "integer",
        format: "int64",
        nullable: true,
        description: "Epoch ms.",
      },
      lastMessage: { type: "object", nullable: true },
      unreadCountByUser: {
        type: "object",
        additionalProperties: { type: "integer" },
        description: "Raw per-participant unread map (internal/back-compat).",
      },
      unreadMessageCount: {
        type: "integer",
        description:
          "Caller's own unread count, resolved from unreadCountByUser (community-style single int).",
      },
      lastActivityAt: {
        type: "integer",
        format: "int64",
        description:
          "Epoch ms mirror of lastMessageAt (community-style: always a number).",
      },
      lastActivity: {
        $ref: "#/components/schemas/ChatPrivateConversationLastActivity",
      },
      peer: { $ref: "#/components/schemas/ChatPrivateRoomPeer" },
      isMuted: { type: "boolean" },
      pinnedCount: { type: "integer" },
      createdAt: { type: "integer", format: "int64", description: "Epoch ms." },
      updatedAt: { type: "integer", format: "int64", description: "Epoch ms." },
    },
    required: [
      "id",
      "roomId",
      "participants",
      "peer",
      "createdAt",
      "updatedAt",
    ],
  },
  ChatPrivateRoomDetails: {
    type: "object",
    description:
      "GET /chat/private/rooms/{peerId} — mirrors CommunityData field names wherever applicable " +
      "(`id`, `avatar`, `isMuted`, `muteUntil`, `createdAt`, `updatedAt`), with private-chat-specific " +
      "`user`/presence fields nested/added. Timestamps are epoch ms, unlike CommunityData's ISO strings.",
    properties: {
      id: {
        type: "string",
        description: "roomId — mirrors CommunityData.id.",
      },
      roomId: { type: "string" },
      participants: { type: "array", items: { type: "string" } },
      peerId: { type: "string" },
      user: {
        type: "object",
        description: "Existing private-chat peer information.",
        properties: {
          id: { type: "string" },
          displayName: { type: "string" },
          memberId: { type: "string" },
          isDeletedUser: { type: "boolean" },
        },
        required: ["id", "displayName", "memberId", "isDeletedUser"],
      },
      avatar: {
        $ref: "#/components/schemas/MediaObject",
        description: "Mirrors CommunityData.avatar — the peer's avatar object.",
      },
      avatarUrl: {
        type: "string",
        nullable: true,
        description:
          "Flattened presigned URL (mirrors CommunityData.avatarUrl).",
      },
      avatarUrlExpiresIn: { type: "integer", nullable: true },
      isOnline: {
        type: "boolean",
        description: "Existing presence field.",
      },
      isOffline: {
        type: "boolean",
        description:
          "Negation of isOnline, from the existing presence pipeline.",
      },
      isMuted: {
        type: "boolean",
        description: "Mirrors CommunityData.isMuted.",
      },
      muteUntil: {
        type: "integer",
        format: "int64",
        nullable: true,
        description:
          "Epoch ms when the caller's mute expires; null = not muted OR muted indefinitely. Mirrors CommunityData.muteUntil.",
      },
      unreadMessageCount: { type: "integer" },
      lastActivityAt: { type: "integer", format: "int64" },
      lastActivity: {
        $ref: "#/components/schemas/ChatPrivateConversationLastActivity",
      },
      createdAt: {
        type: "integer",
        format: "int64",
        description: "Epoch ms. Mirrors CommunityData.createdAt.",
      },
      updatedAt: {
        type: "integer",
        format: "int64",
        description: "Epoch ms. Mirrors CommunityData.updatedAt.",
      },
    },
    required: [
      "id",
      "roomId",
      "participants",
      "peerId",
      "user",
      "avatar",
      "avatarUrl",
      "avatarUrlExpiresIn",
      "isOnline",
      "isOffline",
      "isMuted",
      "muteUntil",
      "unreadMessageCount",
      "lastActivityAt",
      "lastActivity",
      "createdAt",
      "updatedAt",
    ],
  },
  ChatPrivateConversationListItem: {
    type: "object",
    description:
      "GET /chat/private/conversations list item — lean, community-list-style shape. The peer's fields " +
      "are flattened directly onto the item (no nested `peer` object). Internal per-user maps and " +
      "redundant raw fields (lastMessage, lastMessageAt, id, createdAt/updatedAt, pinnedCount) are not " +
      "included.",
    properties: {
      roomId: { type: "string" },
      participants: {
        type: "array",
        items: { type: "string" },
      },
      peerId: { type: "string" },
      displayName: { type: "string" },
      memberId: { type: "string" },
      avatar: { $ref: "#/components/schemas/ChatPrivateRoomPeerAvatar" },
      avatarUrl: {
        type: "string",
        nullable: true,
        description:
          "Flattened presigned download URL (mirrors community's `avatarUrl`).",
      },
      avatarUrlExpiresIn: { type: "integer", nullable: true },
      isDeletedUser: { type: "boolean" },
      isOnline: { type: "boolean" },
      isOffline: {
        type: "boolean",
        description:
          "Negation of isOnline, from the same real-time presence pipeline as conv:updated's isOffline.",
      },
      unreadMessageCount: {
        type: "integer",
        description:
          "Caller's own unread count, resolved from unreadCountByUser (community-style single int).",
      },
      lastActivityAt: {
        type: "integer",
        format: "int64",
        description: "Epoch ms — never an ISO string.",
      },
      lastActivity: {
        $ref: "#/components/schemas/ChatPrivateConversationLastActivity",
      },
      isMuted: { type: "boolean" },
    },
    required: [
      "roomId",
      "participants",
      "peerId",
      "displayName",
      "memberId",
      "avatar",
      "isDeletedUser",
      "isOnline",
      "isOffline",
      "unreadMessageCount",
      "lastActivityAt",
      "lastActivity",
      "isMuted",
    ],
  },
  ChatPrivateConversationListData: {
    type: "object",
    description:
      "Response envelope for GET /chat/private/conversations — same {pagination,data} shape as " +
      "MyCommunitiesResponseData (no top-level hasMore/nextCursor duplicates — only nested under `pagination`).",
    properties: {
      pagination: { $ref: "#/components/schemas/PaginationMeta" },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/ChatPrivateConversationListItem" },
      },
    },
    required: ["pagination", "data"],
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
      lastMessageAt: {
        type: "integer",
        format: "int64",
        nullable: true,
        description: "Epoch ms.",
      },
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
      isJoined: {
        type: "boolean",
        nullable: true,
        description:
          "GROUP only — true when the caller is an active member of this group (always true for inbox rows); null for PRIVATE rows.",
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
  /**
   * Actual runtime shape of GET /chat/inbox — the timestamp-paginated wrapper
   * (`pagination` + `data[]` + top-level `hasMore`/`nextCursor`), NOT a bare array.
   */
  ChatInboxPage: {
    type: "object",
    description:
      "Timestamp-paginated unified inbox (before_ts/after_ts over lastMessageAt). " +
      "Boundaries inclusive — de-dupe by roomId. Use hasMore/nextCursor to page.",
    properties: {
      pagination: { $ref: "#/components/schemas/PaginationMeta" },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/ChatInboxItem" },
      },
      hasMore: {
        type: "boolean",
        description: "Top-level shortcut — same value as pagination.hasMore.",
      },
      nextCursor: {
        type: "string",
        nullable: true,
        description:
          "Top-level shortcut — epoch-ms string; parse to integer and feed back as the same before_ts/after_ts.",
      },
    },
    required: ["pagination", "data", "hasMore", "nextCursor"],
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
                objectKey: { type: "string" },
                url: { type: "string", format: "uri" },
                name: { type: "string" },
                size: { type: "number" },
                mime: { type: "string" },
                width: {
                  type: "number",
                  description: "Pixel width (image/video).",
                },
                height: {
                  type: "number",
                  description: "Pixel height (image/video).",
                },
                durationMs: {
                  type: "number",
                  description:
                    "Playback duration in milliseconds (video/voice).",
                },
                blurhash: {
                  type: "string",
                  description:
                    "§3.5: blur preview for image/video (instant aspect-ratio render before download).",
                },
                waveform: {
                  type: "array",
                  items: { type: "number" },
                  description:
                    "§3.5: voice-note amplitude samples (render bars before download).",
                },
              },
            },
          },
          location: { $ref: "#/components/schemas/ChatLocationAttachment" },
          contact: { $ref: "#/components/schemas/ChatContactAttachment" },
          sticker: { $ref: "#/components/schemas/ChatSticker" },
        },
      },
      contentType: {
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
      createdAt: { type: "integer", format: "int64", description: "Epoch ms." },
    },
    required: ["id", "roomId", "contentType", "createdAt"],
  },
  ChatMessageList: {
    type: "array",
    items: { $ref: "#/components/schemas/ChatMessage" },
  },
  /**
   * Actual runtime shape of GET /chat/private/.../messages and
   * GET /chat/groups/.../messages — the timestamp-paginated wrapper
   * (`pagination` + `data[]` + top-level `hasMore`/`nextCursor`), NOT a bare array.
   */
  ChatMessagePage: {
    type: "object",
    description:
      "Timestamp-paginated private/group messages (before_ts/after_ts over createdAt). " +
      "Boundaries inclusive — de-dupe by message id. Use hasMore/nextCursor to page.",
    properties: {
      pagination: { $ref: "#/components/schemas/PaginationMeta" },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/ChatMessage" },
      },
      hasMore: {
        type: "boolean",
        description: "Top-level shortcut — same value as pagination.hasMore.",
      },
      nextCursor: {
        type: "string",
        nullable: true,
        description:
          "Top-level shortcut — epoch-ms string; parse to integer and feed back as the same before_ts/after_ts.",
      },
    },
    required: ["pagination", "data", "hasMore", "nextCursor"],
  },
  /**
   * Canonical wire message returned by the REST private/group SEND endpoints
   * (and broadcast byte-identically as the Socket.IO `message:new`). This is the
   * `buildChatMessageEvent` output — NOT the `ChatMessage` read shape: it carries
   * server-authoritative `serverTs`/`sentAt` epoch-ms (there is **no** `createdAt`
   * here), the resolved `senderAvatar` URL, and `reactions` as an empty array on a
   * fresh send. The send handler wraps this in `allOf:[ChatWireMessage, {idempotent}]`.
   */
  ChatWireMessage: {
    type: "object",
    properties: {
      id: { type: "string" },
      clientMessageId: {
        type: "string",
        description: "Echo of the idempotency key (empty string if none).",
      },
      roomId: { type: "string" },
      conversationType: { type: "string", enum: ["PRIVATE", "GROUP"] },
      senderId: { type: "string" },
      senderName: { type: "string" },
      senderAvatar: {
        type: "string",
        description:
          "Fully-qualified presigned GET URL (resolved on read), or empty string.",
      },
      senderRole: {
        type: "string",
        description:
          "Group role (OWNER/ADMIN/MEMBER) for GROUP; empty otherwise.",
      },
      receiverId: {
        type: "string",
        description: "Peer user ID for PRIVATE; empty string for GROUP.",
      },
      content: {
        type: "object",
        description:
          "Message body. `content.files[].url` is a resolved presigned download URL (raw object keys are never returned).",
        properties: {
          text: { type: "string", maxLength: 4000 },
          urls: { type: "array", items: { type: "string" } },
          files: { type: "array", items: { type: "object" } },
          location: { $ref: "#/components/schemas/ChatLocationAttachment" },
          contact: { $ref: "#/components/schemas/ChatContactAttachment" },
          sticker: { $ref: "#/components/schemas/ChatSticker" },
        },
        nullable: true,
      },
      contentType: {
        type: "string",
        enum: [
          "TEXT",
          "IMAGE",
          "VIDEO",
          "AUDIO",
          "VOICE",
          "DOCUMENT",
          "GIF",
          "STICKER",
          "LOCATION",
          "CONTACT",
          "SYSTEM",
        ],
        description: "Canonical UPPER-CASE message kind.",
      },
      parentMessageId: {
        type: "string",
        description: "Replied-to message id, or empty string.",
      },
      quoteData: {
        type: "object",
        nullable: true,
        description:
          "Canonical reply snapshot { messageId, senderId, senderName, messageType, preview, isDeleted }, or null.",
      },
      reactions: {
        type: "array",
        description: "Always [] on a fresh send.",
        items: { type: "object" },
      },
      isForwarded: {
        type: "boolean",
        description: "True when this message was forwarded from another room.",
      },
      clientTs: {
        type: "integer",
        format: "int64",
        description: "Client compose time (epoch ms); 0 if unknown.",
      },
      serverTs: {
        type: "integer",
        format: "int64",
        description: "Server-authoritative send time (epoch ms).",
      },
      sentAt: {
        type: "integer",
        format: "int64",
        description: "Alias of serverTs (epoch ms).",
      },
      sequenceNumber: {
        type: "integer",
        description: "Per-room monotonic sequence number.",
      },
    },
    required: [
      "id",
      "roomId",
      "conversationType",
      "senderId",
      "contentType",
      "serverTs",
      "sequenceNumber",
    ],
  },
  /**
   * REST body for private/group DELETE — matches the socket `message:delete` payload byte-for-byte.
   */
  ChatDeleteTombstone: {
    type: "object",
    properties: {
      messageId: { type: "string" },
      conversationId: {
        type: "string",
        description: "Alias of roomId; kept for V1 clients.",
      },
      type: {
        type: "string",
        enum: ["forMe", "forEveryone"],
        description: "Delete scope.",
      },
      deletedBy: { type: "string", description: "userId of the deleter." },
      sequenceNumber: {
        type: "integer",
        description: "Per-room sequence number of the deleted message.",
      },
      deletedType: {
        type: "string",
        description: "GROUP only — SELF_DELETE | ADMIN_DELETE.",
      },
    },
    required: [
      "messageId",
      "conversationId",
      "type",
      "deletedBy",
      "sequenceNumber",
    ],
  },
  /**
   * REST body for community DELETE — matches the socket `community:message:deleted` payload.
   */
  ChatCommunityDeleteTombstone: {
    type: "object",
    description:
      "Returned by `DELETE /chat/community/messages/{messageId}` on success. " +
      "Byte-identical to the `community:message:deleted` Socket.IO event. " +
      "Community message deletes are always `forEveryone` — no per-user soft-delete option. " +
      "When the client receives this (via REST response or socket event), remove the message from the local list " +
      "or replace it with a 'Message deleted' placeholder.",
    properties: {
      messageId: { type: "string", example: "668f1a2b3c4d5e6f7a8b9c02" },
      communityId: { type: "string", example: "comm_01j9x8vb2f3g4h5k6m7n8p9q" },
      roomId: { type: "string", example: "668f1a2b3c4d5e6f7a8b9c0d" },
      deleteType: {
        type: "string",
        enum: ["forMe", "forEveryone"],
        description:
          "Delete scope. Always `forEveryone` for community messages. " +
          "`forMe` is reserved and not currently used in community chat.",
        example: "forEveryone",
      },
      deletedBy: {
        type: "string",
        description:
          "UserId of the member or moderator who deleted the message.",
        example: "usr_01j8r5t2q3w4e5r6t7y8u9i0",
      },
    },
    required: ["messageId", "communityId", "roomId", "deleteType", "deletedBy"],
    example: {
      messageId: "668f1a2b3c4d5e6f7a8b9c02",
      communityId: "comm_01j9x8vb2f3g4h5k6m7n8p9q",
      roomId: "668f1a2b3c4d5e6f7a8b9c0d",
      deleteType: "forEveryone",
      deletedBy: "usr_01j8r5t2q3w4e5r6t7y8u9i0",
    },
  },
  /**
   * REST body for community message EDIT — matches the socket `community:message:edited` payload.
   */
  ChatCommunityEditResponse: {
    type: "object",
    description:
      "Returned by `PATCH /chat/community/messages/{messageId}` on success. " +
      "Byte-identical to the `community:message:edited` Socket.IO event payload. " +
      "Only TEXT messages can be edited. The edit window is 15 minutes from `serverTs`. " +
      "A 410 response (`CHAT_EDIT_WINDOW_EXPIRED`) is returned after the window closes.",
    properties: {
      messageId: { type: "string", example: "668f1a2b3c4d5e6f7a8b9c02" },
      communityId: { type: "string", example: "comm_01j9x8vb2f3g4h5k6m7n8p9q" },
      roomId: { type: "string", example: "668f1a2b3c4d5e6f7a8b9c0d" },
      content: {
        type: "object",
        nullable: true,
        description:
          "Updated message body. For TEXT messages contains `{ text }`. " +
          "Replace the stored `message` / `content.text` with this value when reconciling client state.",
        properties: {
          text: {
            type: "string",
            description: "Edited plain-text content (max 4000 chars).",
            example: "Updated: Hey everyone! 👋 Thanks for joining.",
          },
        },
        example: { text: "Updated: Hey everyone! 👋 Thanks for joining." },
      },
      contentType: {
        type: "string",
        description:
          "UPPER-CASE message kind (always TEXT for editable messages).",
        example: "TEXT",
      },
      isEdited: {
        type: "boolean",
        description: "Always `true` on an edit response.",
        example: true,
      },
      editedAt: {
        type: "integer",
        format: "int64",
        description: "Epoch ms when the message was last edited.",
        example: 1782133215000,
      },
      sequenceNumber: {
        type: "integer",
        description:
          "Per-room sequence number (unchanged from the original send).",
        example: 142,
      },
    },
    required: ["messageId", "communityId", "roomId", "isEdited", "editedAt"],
    example: {
      messageId: "668f1a2b3c4d5e6f7a8b9c02",
      communityId: "comm_01j9x8vb2f3g4h5k6m7n8p9q",
      roomId: "668f1a2b3c4d5e6f7a8b9c0d",
      content: { text: "Updated: Hey everyone! 👋 Thanks for joining." },
      contentType: "TEXT",
      isEdited: true,
      editedAt: 1782133215000,
      sequenceNumber: 142,
    },
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
      pinnedAt: { type: "integer", format: "int64", description: "Epoch ms." },
      senderId: { type: "string" },
      senderDisplayName: { type: "string" },
      contentPinned: { type: "object" },
      messageCreatedAt: {
        type: "integer",
        format: "int64",
        description: "Epoch ms.",
      },
      isAvailable: {
        type: "boolean",
        description:
          "Whether the pinned message still exists (not deleted-for-everyone). " +
          "Present on the private- and group-room pins lists — lets the banner " +
          "render a 'pinned-but-deleted' state (tap does not navigate) using the " +
          "frozen `contentPinned` snapshot. Mirrors community's embedded " +
          "`pinnedMessage.isAvailable`. Additive — omitted by older responses.",
      },
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
      lastMessageAt: {
        type: "integer",
        format: "int64",
        nullable: true,
        description: "Epoch ms.",
      },
      pinnedCount: { type: "integer" },
      isJoined: {
        type: "boolean",
        description:
          "True when the logged-in caller is an active member of this group. Present on the read surfaces — GET /groups/my-groups (always true) and GET /groups/{roomId} (varies: false for a non-member). Omitted on mutation responses (create/update/disband).",
      },
      createdAt: { type: "integer", format: "int64", description: "Epoch ms." },
      updatedAt: { type: "integer", format: "int64", description: "Epoch ms." },
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
      joinedAt: { type: "integer", format: "int64", description: "Epoch ms." },
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
      expiresAt: {
        type: "integer",
        format: "int64",
        nullable: true,
        description: "Epoch ms.",
      },
      maxUses: { type: "integer", nullable: true },
      usedCount: { type: "integer" },
      shareName: { type: "string" },
      createdAt: { type: "integer", format: "int64", description: "Epoch ms." },
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
  NotificationNavigation: {
    type: "object",
    description:
      "Deep-link routing object on community join-request notifications. Tells the client which screen to navigate to.",
    properties: {
      screen: {
        type: "string",
        enum: ["COMMUNITY_REQUESTS", "COMMUNITY_DETAILS", "COMMUNITY_CHAT"],
        description:
          "COMMUNITY_REQUESTS: admin/mod join-requests list. COMMUNITY_DETAILS: community info page. COMMUNITY_CHAT: community general chat.",
      },
      communityId: { type: "string" },
      communityName: { type: "string" },
      communityAvatarUrl: {
        type: "string",
        nullable: true,
        description:
          "Resolved presigned URL. Null if the community has no avatar.",
      },
      communityHandle: {
        type: "string",
        nullable: true,
        description: "The community @handle unique slug.",
      },
      requestId: {
        type: "string",
        description: "Present only for join-request notification types.",
      },
    },
    required: ["screen", "communityId", "communityName"],
  },
  ChatNotification: {
    type: "object",
    properties: {
      id: { type: "string" },
      userId: { type: "string" },
      actorId: { type: "string" },
      type: {
        type: "string",
        description:
          "Notification type. Known community values: community.join_requested, " +
          "community.join_request_approved, community.join_request_rejected, " +
          "community.member_added, community.invite_accepted.",
      },
      entity: { type: "object" },
      actorSnapshot: {
        type: "object",
        nullable: true,
        description:
          "Actor details for notification UI. " +
          "community.join_requested: { userId, displayName, avatarUrl }. " +
          "approved/rejected: { userId, displayName }. Absent on other types.",
        properties: {
          userId: { type: "string" },
          displayName: { type: "string" },
          avatarUrl: { type: "string", nullable: true },
        },
      },
      payload: {
        type: "object",
        description:
          "Structured notification data. payload.data contains type-specific string fields. " +
          "For community join-request types, payload.data.navigation is a JSON string — " +
          "parse it to get a NotificationNavigation object.",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          data: {
            type: "object",
            additionalProperties: { type: "string" },
            description:
              "String map of type-specific fields. Community join-request keys: " +
              "communityId, communityName, communityHandle, communityAvatarUrl, " +
              "requestId, requesterDisplayName, requesterAvatarUrl, " +
              "decidedByDisplayName, status (APPROVED|REJECTED), " +
              "navigation (JSON-stringified NotificationNavigation), actorSnapshot (JSON string).",
          },
        },
      },
      navigation: {
        $ref: "#/components/schemas/NotificationNavigation",
        description:
          "Parsed navigation object. Present in notifications:fetch socket ack and " +
          "notification:new socket event. On REST GET /chat/notifications, parse from payload.data.navigation instead.",
      },
      isRead: { type: "boolean" },
      readAt: {
        type: "integer",
        format: "int64",
        nullable: true,
        description: "Epoch ms.",
      },
      createdAt: { type: "integer", format: "int64", description: "Epoch ms." },
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
      isLive: {
        type: "boolean",
        description:
          "True when ≥1 livestream is LIVE (alias of hasActiveLivestream).",
      },
      hasActiveLivestream: {
        type: "boolean",
        description:
          "True when the community has at least one LIVE stream right now.",
      },
      activeLivestreamCount: {
        type: "integer",
        description: "Number of currently-LIVE streams (0–5, capped).",
      },
      tags: { type: "array", items: { type: "string" } },
      status: { type: "string" },
      lastMessageAt: {
        type: "integer",
        format: "int64",
        nullable: true,
        description: "Epoch ms.",
      },
      createdAt: { type: "integer", format: "int64", description: "Epoch ms." },
    },
    required: ["id", "name", "status", "createdAt"],
  },
  ChatCommunityRoomList: {
    type: "array",
    items: { $ref: "#/components/schemas/ChatCommunityRoom" },
  },
  ChatCommunityMessage: {
    type: "object",
    description:
      "Community message as returned by the history endpoint (`GET /chat/community/rooms/{roomId}/messages`). " +
      "Shape differs from the send-response (`ChatCommunityWireMessage`): uses `sentBy` (not `senderId`), " +
      "flat `attachments[]` (not structured `content`), and `createdAt` epoch-ms (not `serverTs`). " +
      "SYSTEM messages have `contentType: SYSTEM` and a null `sentBy`/`senderName`/`senderAvatar`; " +
      "the actor is in `systemMetadata` only.",
    properties: {
      id: { type: "string", example: "668f1a2b3c4d5e6f7a8b9c02" },
      roomId: { type: "string", example: "668f1a2b3c4d5e6f7a8b9c0d" },
      sentBy: {
        type: "string",
        description: "UserId of the sender. Null/empty for SYSTEM messages.",
        example: "usr_01j8r5t2q3w4e5r6t7y8u9i0",
      },
      senderName: {
        type: "string",
        nullable: true,
        description: "Display name at send time. Null for SYSTEM messages.",
        example: "Rajesh Sharma",
      },
      senderAvatar: {
        type: "string",
        nullable: true,
        description:
          "Fully-qualified, ready-to-use presigned GET URL (time-limited, ~1h). " +
          "Render it directly — do not build it from a key or call a separate download endpoint. " +
          "Null for SYSTEM messages.",
        example:
          "https://cdn.aimess.me/avatars/usr_01j8r5t2q3w4e5r6t7y8u9i0.jpg?X-Amz-Expires=3600",
      },
      message: {
        type: "string",
        nullable: true,
        description:
          "Plain text body. For SYSTEM messages this is the canonical English fallback string " +
          "(e.g. 'Rajesh Sharma is now a moderator'). Null for media-only messages.",
        example: "Hey everyone! 👋 Welcome to the community.",
      },
      reactions: {
        type: "object",
        description:
          'Emoji reactions dictionary: `{ "<emoji>": [{ userId, displayName, avatar }] }`. ' +
          "Each key is a Unicode emoji; each value is an array of users who used that emoji. " +
          "An empty object `{}` means no reactions. " +
          "To add/toggle a reaction use `POST /chat/community/messages/{messageId}/react`.",
        additionalProperties: {
          type: "array",
          items: {
            type: "object",
            properties: {
              userId: { type: "string" },
              displayName: { type: "string" },
              avatar: { type: "string", nullable: true },
            },
            required: ["userId", "displayName"],
          },
        },
        example: {
          "👍": [
            {
              userId: "usr_01j8r5t2q3w4e5r6t7y8u9i1",
              displayName: "Priya Nair",
              avatar:
                "https://cdn.aimess.me/avatars/usr_priya.jpg?X-Amz-Expires=3600",
            },
          ],
          "❤️": [
            {
              userId: "usr_01j8r5t2q3w4e5r6t7y8u9i2",
              displayName: "Arjun Mehta",
              avatar: null,
            },
          ],
        },
      },
      parentMessageId: {
        type: "string",
        nullable: true,
        description:
          "ObjectId of the message being replied to. Null for top-level messages. " +
          "When non-null render the quoteData snapshot above the message bubble.",
        example: "668f1a2b3c4d5e6f7a8b9c01",
      },
      contentType: {
        type: "string",
        description:
          "Community message kind (UPPER-CASE on the wire): TEXT, IMAGE, VOICE, CUSTOM, LOCATION, CONTACT, STICKER, SYSTEM.",
      },
      systemMessageType: {
        type: "string",
        nullable: true,
        enum: [
          // Community lifecycle
          "COMMUNITY_CREATED",
          "COMMUNITY_NAME_UPDATED",
          "COMMUNITY_DESCRIPTION_UPDATED",
          "COMMUNITY_AVATAR_UPDATED",
          "COMMUNITY_BANNER_UPDATED",
          "COMMUNITY_UPDATED",
          // Live streaming
          "LIVE_STREAM_STARTED",
          "LIVE_STREAM_ENDED",
          // Membership / moderation (COMMUNITY-visible)
          "ROLE_CHANGED",
          "MEMBER_JOINED",
          "MEMBER_LEFT",
          "MEMBER_REMOVED",
          "MEMBER_BANNED",
          "MEMBER_UNBANNED",
          "MEMBER_MUTED",
          "MEMBER_UNMUTED",
          // Message actions
          "PINNED_MESSAGE",
          "UNPINNED_MESSAGE",
          "COMMUNITY_INVITE_CREATED",
          // Personal (visible only to the affected user)
          "COMMUNITY_JOINED",
          "JOIN_REQUEST_APPROVED",
          "JOIN_REQUEST_REJECTED",
          "ROLE_CHANGED_SELF",
          // Legacy alias — old persisted rows only
          "MEMBER_ROLE_CHANGED",
        ],
        description:
          "Present when contentType is SYSTEM. SYSTEM messages are SENDER-LESS " +
          "(sentBy/senderName/senderAvatar empty) — the actor is in systemMetadata only. " +
          "The `message` field carries the canonical English fallback text; render it directly " +
          "or localize from systemMessageType + systemMetadata. " +
          "Canonical fallback texts by type: " +
          "COMMUNITY_CREATED → 'Community created'; " +
          "COMMUNITY_NAME_UPDATED → 'Community renamed to \"{{newName}}\"' (metadata.newName); " +
          "COMMUNITY_AVATAR_UPDATED → 'Community photo updated'; " +
          "COMMUNITY_DESCRIPTION_UPDATED → 'Community description updated'; " +
          "LIVE_STREAM_STARTED → 'Live stream started'; " +
          "LIVE_STREAM_ENDED → 'Live stream ended ({{duration}})' or 'Live stream ended' when duration absent; " +
          "ROLE_CHANGED (bystander) → '{{targetName}} is now a moderator/admin/member'; " +
          "ROLE_CHANGED (viewer=target) → 'You are now a moderator/admin/member'; " +
          "MEMBER_UNBANNED → '{{targetName}} was unbanned'; " +
          "MEMBER_BANNED (target only) → 'You were banned from this community.'; " +
          "MEMBER_MUTED (target only) → 'You are muted until {{date}}' or 'You are muted indefinitely' when no expiry; " +
          "MEMBER_UNMUTED (target only) → 'You were unmuted'. " +
          "PERSONAL types (isPersonal=true, only ever returned to the target user): " +
          "COMMUNITY_JOINED / JOIN_REQUEST_APPROVED / JOIN_REQUEST_REJECTED / ROLE_CHANGED_SELF / " +
          "MEMBER_BANNED / MEMBER_MUTED / MEMBER_UNMUTED. " +
          "Hidden in chat timeline (never returned to anyone): MEMBER_LEFT, MEMBER_JOINED, MEMBER_REMOVED — " +
          "the removed/left member learns via the `community:membership:removed` socket event instead. " +
          "MEMBER_UNBANNED is COMMUNITY-visible (all members see it); MEMBER_BANNED, MEMBER_MUTED and " +
          "MEMBER_UNMUTED are PERSONAL — silent for everyone else, visible only to the affected member's " +
          "own history/sync/catch-up on reload or reconnect. " +
          "MEMBER_ROLE_CHANGED is the legacy alias for ROLE_CHANGED (old rows only).",
      },
      systemMetadata: {
        type: "object",
        nullable: true,
        additionalProperties: true,
        description:
          "Structured payload for SYSTEM message rendering. All types share " +
          "`actorUserId` (userId who triggered the event) and `actorName` (their display name). " +
          "Render 'You' when actorUserId === currentUserId, otherwise use actorName. " +
          "Per-type extra fields: " +
          "COMMUNITY_CREATED: { communityName }. " +
          "COMMUNITY_NAME_UPDATED: { newName } — the rename target. " +
          "LIVE_STREAM_ENDED: { duration? } — human-readable runtime, e.g. '2 hours 15 minutes'. " +
          "ROLE_CHANGED / MEMBER_ROLE_CHANGED: { targetUserId, targetName, oldRole, newRole }. " +
          "MEMBER_BANNED / MEMBER_UNBANNED / MEMBER_UNMUTED: { targetUserId, targetName }. " +
          "MEMBER_MUTED: { targetUserId, targetName, mutedUntil, durationMinutes } — mutedUntil is an " +
          "epoch-ms timestamp (or null for an indefinite mute), durationMinutes is the mute length as " +
          "originally requested (or null for indefinite). " +
          "PINNED_MESSAGE / UNPINNED_MESSAGE: { messageId, messagePreview }. " +
          "COMMUNITY_JOINED / JOIN_REQUEST_APPROVED / JOIN_REQUEST_REJECTED: personal — same shape, no targetUserId. " +
          "Null for normal messages.",
      },
      isPersonal: {
        type: "boolean",
        description:
          "True for user-scoped SYSTEM messages (COMMUNITY_JOINED 'You joined the community', " +
          "JOIN_REQUEST_APPROVED, JOIN_REQUEST_REJECTED, ROLE_CHANGED_SELF, MEMBER_BANNED, MEMBER_MUTED, " +
          "MEMBER_UNMUTED). " +
          "PERSONAL messages are only ever returned to the target user — other members never see them in history. " +
          "Absent/false for normal and community-wide system messages.",
      },
      quoteData: {
        type: "object",
        nullable: true,
        description:
          "Reply snapshot of the parent message (present when `parentMessageId` is non-null). " +
          "Frozen at send time — never mutated even if the parent is later edited or deleted. " +
          "Render this as the quoted-message preview above the bubble.",
        properties: {
          id: { type: "string", example: "668f1a2b3c4d5e6f7a8b9c01" },
          senderId: { type: "string", example: "usr_01j8r5t2q3w4e5r6t7y8u9i1" },
          senderName: { type: "string", example: "Priya Nair" },
          contentType: { type: "string", example: "TEXT" },
          message: {
            type: "string",
            description: "Truncated preview text (≤200 chars).",
            example: "Can everyone share their availability for next week?",
          },
          attachments: {
            type: "array",
            description:
              "Parent attachments when the parent was a media message.",
            items: {
              type: "object",
              properties: {
                mediaId: { type: "string", nullable: true },
                url: { type: "string" },
                mime: { type: "string" },
                name: { type: "string" },
              },
            },
          },
        },
        example: {
          id: "668f1a2b3c4d5e6f7a8b9c01",
          senderId: "usr_01j8r5t2q3w4e5r6t7y8u9i1",
          senderName: "Priya Nair",
          contentType: "TEXT",
          message: "Can everyone share their availability for next week?",
          attachments: [],
        },
      },
      attachments: {
        type: "array",
        description:
          "Media / sticker / location / contact attachments. " +
          "Each attachment carries a resolved `url` (presigned, time-limited, ~1h) — render directly. " +
          "Send-time caps: text ≤4000 chars; ≤10 images; video ≤100 MB / 180 000 ms; voice ≤300 000 ms; other files ≤50 MB.",
        items: {
          type: "object",
          description:
            "One attachment. The `contentType` field (UPPER-CASE, e.g. IMAGE, VIDEO, VOICE, GIF, DOCUMENT, STICKER, LOCATION, CONTACT) " +
            "tells the client how to render it. All media types share `url`, `mime`, `size`, `name`. " +
            "Images/videos add `width`/`height`/`blurhash`. Audio/voice add `durationMs`/`waveform`. " +
            "Stickers follow the ChatSticker shape. Location follows ChatLocationAttachment. Contact follows ChatContactAttachment.",
          properties: {
            mediaId: {
              type: "string",
              nullable: true,
              description:
                "Stable, immutable media identity — independent of objectKey/url. Null for legacy attachments sent before this field existed.",
              example: "668f1a2b3c4d5e6f7a8b9c99",
            },
            url: {
              type: "string",
              description:
                "Presigned GET URL (time-limited, ~1h). Render directly; do NOT persist.",
              example:
                "https://cdn.aimess.me/media/images/comm_01j9x8vb/668f1a2b.jpg?X-Amz-Expires=3600",
            },
            objectKey: {
              type: "string",
              nullable: true,
              description:
                "Raw storage key (stored in DB; use `url` for display).",
              example: "media/images/comm_01j9x8vb/668f1a2b.jpg",
            },
            mime: { type: "string", example: "image/jpeg" },
            size: { type: "integer", description: "Bytes.", example: 204800 },
            name: { type: "string", example: "photo.jpg" },
            contentType: {
              type: "string",
              description:
                "UPPER-CASE media kind of this attachment (IMAGE, VIDEO, AUDIO, GIF, VOICE, DOCUMENT, STICKER, LOCATION, CONTACT).",
              example: "IMAGE",
            },
            width: { type: "integer", nullable: true, example: 1920 },
            height: { type: "integer", nullable: true, example: 1080 },
            durationMs: {
              type: "integer",
              nullable: true,
              description: "Duration ms (AUDIO / VIDEO / VOICE).",
              example: 34500,
            },
            blurhash: {
              type: "string",
              nullable: true,
              description: "BlurHash placeholder for images.",
              example: "LqKk3+%NIXxu~qxt%MWBt7WBNGjY",
            },
            waveform: {
              type: "array",
              nullable: true,
              items: { type: "number", minimum: 0, maximum: 1 },
              description:
                "Amplitude samples [0,1] × 100. Present on VOICE messages.",
            },
            // Sticker fields
            packId: {
              type: "string",
              nullable: true,
              description: "Sticker pack id (STICKER attachments).",
              example: "sticker_pack_celebrations_v1",
            },
            stickerId: {
              type: "string",
              nullable: true,
              description: "Sticker id within the pack (STICKER attachments).",
              example: "sticker_party_01",
            },
            // Location fields
            lat: {
              type: "number",
              nullable: true,
              description: "Latitude (LOCATION).",
              example: 28.6139,
            },
            lng: {
              type: "number",
              nullable: true,
              description: "Longitude (LOCATION).",
              example: 77.209,
            },
            placeName: {
              type: "string",
              nullable: true,
              description: "Human-readable place name (LOCATION).",
              example: "India Gate",
            },
            placeAddress: {
              type: "string",
              nullable: true,
              description: "Full address (LOCATION).",
              example: "Rajpath, New Delhi, India",
            },
            // Contact fields
            phone: {
              type: "string",
              nullable: true,
              description: "Phone number (CONTACT).",
              example: "+91 98765 43210",
            },
            userId: {
              type: "string",
              nullable: true,
              description:
                "App userId (CONTACT — if the contact is an aimess user).",
            },
          },
        },
        example: [
          {
            url: "https://cdn.aimess.me/media/images/comm_01j9x8vb/668f1a2b.jpg?X-Amz-Expires=3600",
            objectKey: "media/images/comm_01j9x8vb/668f1a2b.jpg",
            mime: "image/jpeg",
            size: 204800,
            name: "photo.jpg",
            contentType: "IMAGE",
            width: 1920,
            height: 1080,
            blurhash: "LqKk3+%NIXxu~qxt%MWBt7WBNGjY",
          },
        ],
      },
      deletedForAll: {
        type: "boolean",
        description:
          "True when the message was deleted for all members. " +
          "In incremental-sync mode (`after_ts`) deleted messages are included as tombstones so clients can purge them locally.",
        example: false,
      },
      isEdited: {
        type: "boolean",
        description: "true when the message has been edited at least once.",
        example: false,
      },
      editedAt: {
        type: "integer",
        format: "int64",
        nullable: true,
        description:
          "Epoch ms of the last edit. Non-null (may be 0) when the message has been edited.",
        example: null,
      },
      createdAt: {
        type: "integer",
        format: "int64",
        description: "Epoch ms when the message was first sent.",
        example: 1782133107521,
      },
      updatedAt: {
        type: "integer",
        description:
          "Epoch-ms of the last mutation (edit, reaction, delete). Present in incremental-sync (`after_ts`) responses only.",
        nullable: true,
        example: 1782133108000,
      },
      syncEventType: {
        type: "string",
        enum: ["new", "edited", "deleted", "reacted"],
        nullable: true,
        description:
          "Only present in `after_ts` (incremental-sync) responses. " +
          "Client reconciliation: `new` → insert; `edited` → update text; `deleted` → remove (tombstone); `reacted` → refresh reactions.",
        example: null,
      },
      readBy: {
        type: "array",
        description:
          "Users who have read this message (lastReadAt >= message.createdAt). Excludes the sender.",
        items: {
          type: "object",
          properties: {
            userId: { type: "string", example: "usr_01j8r5t2q3w4e5r6t7y8u9i1" },
            readAt: {
              type: "integer",
              description: "Epoch ms when the user read up to this message.",
              example: 1782133110000,
            },
          },
          required: ["userId", "readAt"],
        },
      },
      deliveredTo: {
        type: "array",
        description:
          "Users who were active members of this room when the message was sent (joinedAt <= message.createdAt). Excludes the sender.",
        items: {
          type: "object",
          properties: {
            userId: { type: "string", example: "usr_01j8r5t2q3w4e5r6t7y8u9i2" },
            deliveredAt: {
              type: "integer",
              description:
                "Epoch ms — equals the message `createdAt` timestamp.",
              example: 1782133107521,
            },
          },
          required: ["userId", "deliveredAt"],
        },
      },
    },
    required: ["id", "roomId", "sentBy", "createdAt", "isEdited"],
    example: {
      id: "668f1a2b3c4d5e6f7a8b9c02",
      roomId: "668f1a2b3c4d5e6f7a8b9c0d",
      sentBy: "usr_01j8r5t2q3w4e5r6t7y8u9i0",
      senderName: "Rajesh Sharma",
      senderAvatar:
        "https://cdn.aimess.me/avatars/usr_01j8r5t2q3w4e5r6t7y8u9i0.jpg?X-Amz-Expires=3600",
      message: "Hey everyone! 👋 Welcome to the community.",
      reactions: {
        "👍": [
          {
            userId: "usr_01j8r5t2q3w4e5r6t7y8u9i1",
            displayName: "Priya Nair",
            avatar:
              "https://cdn.aimess.me/avatars/usr_priya.jpg?X-Amz-Expires=3600",
          },
        ],
      },
      parentMessageId: null,
      quoteData: null,
      contentType: "TEXT",
      systemMessageType: null,
      systemMetadata: null,
      isPersonal: false,
      attachments: [],
      deletedForAll: false,
      isEdited: false,
      editedAt: null,
      createdAt: 1782133107521,
      updatedAt: null,
      syncEventType: null,
      readBy: [],
      deliveredTo: [],
    },
  },
  ChatCommunityMessageList: {
    type: "array",
    items: { $ref: "#/components/schemas/ChatCommunityMessage" },
  },
  /**
   * Canonical wire message returned by the REST community SEND endpoint (and
   * broadcast byte-identically as the Socket.IO `community:message:new`). This is
   * the orchestrator `sendCommunity` payload — NOT the `ChatCommunityMessage` read
   * shape: it uses `senderId` (not `sentBy`), structured `content` (not flat
   * `attachments[]`), `serverTs`/`sentAt` epoch-ms (no `createdAt`), and carries
   * `reactions` as an empty array on a fresh send. The send handler wraps this in
   * `allOf:[ChatCommunityWireMessage, {idempotent}]`.
   */
  ChatCommunityWireMessage: {
    type: "object",
    description:
      "Canonical wire message returned by the REST community SEND endpoint. " +
      "Byte-identical to the Socket.IO `community:message:new` payload. " +
      "Shape differs from the history `ChatCommunityMessage`: uses `senderId` (not `sentBy`), " +
      "structured `content` (not flat `attachments[]`), epoch-ms timestamps `serverTs`/`sentAt` (not `createdAt`), " +
      "and `reactions` is always `[]` on a fresh send.",
    properties: {
      id: { type: "string", example: "668f1a2b3c4d5e6f7a8b9c02" },
      messageId: {
        type: "string",
        description: "Alias of `id`.",
        example: "668f1a2b3c4d5e6f7a8b9c02",
      },
      communityId: {
        type: "string",
        description: "community-service Community.id (broadcast channel key).",
        example: "comm_01j9x8vb2f3g4h5k6m7n8p9q",
      },
      roomId: {
        type: "string",
        description: "chat-service GeneralRoom.id (equals communityId).",
        example: "668f1a2b3c4d5e6f7a8b9c0d",
      },
      senderId: {
        type: "string",
        example: "usr_01j8r5t2q3w4e5r6t7y8u9i0",
      },
      senderName: { type: "string", example: "Rajesh Sharma" },
      senderAvatar: {
        type: "string",
        description:
          "Fully-qualified, time-limited presigned GET URL (resolved on read). " +
          "Render directly — do NOT persist this URL; it expires in ~1 hour.",
        example:
          "https://cdn.aimess.me/avatars/usr_01j8r5t2q3w4e5r6t7y8u9i0.jpg?X-Amz-Expires=3600",
      },
      parentMessageId: {
        type: "string",
        description:
          'ObjectId of the message being replied to, or empty string `""` for top-level messages. ' +
          "When non-empty, `quoteData` carries a snapshot of the parent message.",
        example: "668f1a2b3c4d5e6f7a8b9c01",
      },
      quoteData: {
        type: "object",
        nullable: true,
        description:
          "Canonical snapshot of the parent message (populated when `parentMessageId` is set). " +
          "Frozen at send time — never mutated even if the parent is later edited or deleted.",
        properties: {
          id: {
            type: "string",
            description: "Replied-to message ObjectId.",
            example: "668f1a2b3c4d5e6f7a8b9c01",
          },
          senderId: { type: "string", example: "usr_01j8r5t2q3w4e5r6t7y8u9i1" },
          senderName: { type: "string", example: "Priya Nair" },
          contentType: {
            type: "string",
            description: "UPPER-CASE message kind of the parent.",
            example: "TEXT",
          },
          message: {
            type: "string",
            description:
              "Truncated preview of the parent message text (≤200 chars).",
            example: "Can everyone share their availability for next week?",
          },
          attachments: {
            type: "array",
            description:
              "Parent attachments (images, files, etc.) when the parent was a media message.",
            items: {
              type: "object",
              properties: {
                mediaId: { type: "string", nullable: true },
                url: { type: "string" },
                mime: { type: "string" },
                name: { type: "string" },
              },
            },
          },
        },
        example: {
          id: "668f1a2b3c4d5e6f7a8b9c01",
          senderId: "usr_01j8r5t2q3w4e5r6t7y8u9i1",
          senderName: "Priya Nair",
          contentType: "TEXT",
          message: "Can everyone share their availability for next week?",
          attachments: [],
        },
      },
      content: {
        type: "object",
        description:
          "Structured message body. `content.files[]` carry fully-resolved presigned download URLs. " +
          "For non-media messages `files` is `[]`. Location/contact/sticker appear in their dedicated fields.",
        properties: {
          text: {
            type: "string",
            description:
              "Plain-text body (empty string for non-TEXT messages).",
            example: "Hey everyone! 👋 Welcome to the community.",
          },
          files: {
            type: "array",
            description:
              "Resolved media attachments. Each file has a ready-to-use presigned `url`.",
            items: {
              type: "object",
              properties: {
                mediaId: {
                  type: "string",
                  nullable: true,
                  description:
                    "Stable, immutable media identity — independent of objectKey/url. Null for legacy attachments sent before this field existed.",
                  example: "668f1a2b3c4d5e6f7a8b9c99",
                },
                url: {
                  type: "string",
                  description:
                    "Presigned GET URL (time-limited, ~1 h). Render directly.",
                  example:
                    "https://cdn.aimess.me/media/images/comm_01j9x8vb/668f1a2b.jpg?X-Amz-Expires=3600",
                },
                objectKey: {
                  type: "string",
                  description:
                    "Raw storage key (stored in DB; use url for display).",
                  example: "media/images/comm_01j9x8vb/668f1a2b.jpg",
                },
                mime: { type: "string", example: "image/jpeg" },
                size: {
                  type: "integer",
                  description: "Bytes.",
                  example: 204800,
                },
                name: { type: "string", example: "photo.jpg" },
                width: { type: "integer", nullable: true, example: 1920 },
                height: { type: "integer", nullable: true, example: 1080 },
                durationMs: {
                  type: "integer",
                  nullable: true,
                  description: "Duration in ms (audio/video/voice).",
                  example: 34500,
                },
                blurhash: {
                  type: "string",
                  nullable: true,
                  description: "BlurHash placeholder for images.",
                  example: "LqKk3+%NIXxu~qxt%MWBt7WBNGjY",
                },
                waveform: {
                  type: "array",
                  nullable: true,
                  items: { type: "number" },
                  description:
                    "Amplitude samples [0,1] × 100. Present on VOICE messages.",
                },
              },
            },
          },
          location: { $ref: "#/components/schemas/ChatLocationAttachment" },
          contact: { $ref: "#/components/schemas/ChatContactAttachment" },
          sticker: { $ref: "#/components/schemas/ChatSticker" },
        },
        required: ["text", "files"],
      },
      reactions: {
        type: "array",
        description:
          "Always `[]` on a fresh send. Populated after users react; see `ChatCommunityReactResponse` for the full grouped shape.",
        items: { $ref: "#/components/schemas/ChatCommunityReactionGroup" },
      },
      message: {
        type: "string",
        description: "Plain-text body (mirrors `content.text`).",
        example: "Hey everyone! 👋 Welcome to the community.",
      },
      contentType: {
        type: "string",
        enum: [
          "TEXT",
          "IMAGE",
          "VIDEO",
          "AUDIO",
          "GIF",
          "VOICE",
          "DOCUMENT",
          "STICKER",
          "LOCATION",
          "CONTACT",
          "SYSTEM",
        ],
        description: "Canonical UPPER-CASE message kind.",
        example: "TEXT",
      },
      clientMessageId: {
        type: "string",
        description:
          "Echo of the idempotency key (empty string if none was provided).",
        example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      },
      serverTs: {
        type: "integer",
        format: "int64",
        description: "Server-authoritative send time (epoch ms).",
        example: 1782133107521,
      },
      sentAt: {
        type: "integer",
        format: "int64",
        description: "Alias of `serverTs` (epoch ms).",
        example: 1782133107521,
      },
      sequenceNumber: {
        type: "integer",
        description:
          "Per-room monotonic sequence number. Use for detecting gaps and ordering messages without relying on timestamps.",
        example: 142,
      },
    },
    required: [
      "id",
      "messageId",
      "communityId",
      "roomId",
      "senderId",
      "content",
      "contentType",
      "serverTs",
      "sequenceNumber",
    ],
    example: {
      id: "668f1a2b3c4d5e6f7a8b9c02",
      messageId: "668f1a2b3c4d5e6f7a8b9c02",
      communityId: "comm_01j9x8vb2f3g4h5k6m7n8p9q",
      roomId: "668f1a2b3c4d5e6f7a8b9c0d",
      senderId: "usr_01j8r5t2q3w4e5r6t7y8u9i0",
      senderName: "Rajesh Sharma",
      senderAvatar:
        "https://cdn.aimess.me/avatars/usr_01j8r5t2q3w4e5r6t7y8u9i0.jpg?X-Amz-Expires=3600",
      parentMessageId: "",
      quoteData: null,
      content: {
        text: "Hey everyone! 👋 Welcome to the community.",
        files: [],
      },
      reactions: [],
      message: "Hey everyone! 👋 Welcome to the community.",
      contentType: "TEXT",
      clientMessageId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      serverTs: 1782133107521,
      sentAt: 1782133107521,
      sequenceNumber: 142,
      idempotent: false,
    },
  },
  /** Scroll / history mode — before_ts (default). Includes top-level hasMore + nextCursor shortcuts. */
  ChatCommunityMessagePage: {
    type: "object",
    description:
      "Timestamp-paginated community messages (scroll/history mode). " +
      "Use `before_ts` to scroll backwards; omit for the newest page. " +
      "Feed `nextCursor` verbatim back as the next `before_ts` — do NOT parse it to a number.",
    properties: {
      pagination: { $ref: "#/components/schemas/PaginationMeta" },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/ChatCommunityMessage" },
      },
      hasMore: {
        type: "boolean",
        description:
          "Top-level shortcut — same value as `pagination.hasMore`. " +
          "Use this to decide whether to fetch more pages.",
        example: true,
      },
      nextCursor: {
        type: "string",
        nullable: true,
        description:
          'Compound `"<epochMs>_<messageObjectId>"` string. Echo **verbatim** as the next ' +
          "`before_ts` — do NOT parse to a number. The `_<id>` tiebreaker is required to " +
          "avoid skipping messages that share the same millisecond at a page boundary. " +
          "Null when `hasMore` is false (last page reached).",
        example: "1782133100000_668f1a2b3c4d5e6f7a8b9c00",
      },
      pinnedMessage: {
        allOf: [{ $ref: "#/components/schemas/CommunityPinnedMessageSummary" }],
        nullable: true,
        description:
          "The room's currently active pinned message, or null if none. See CommunityPinnedMessageSummary.",
      },
    },
    required: ["pagination", "data", "hasMore", "nextCursor", "pinnedMessage"],
    example: {
      pagination: {
        totalData: 142,
        totalPage: 5,
        currentPage: 1,
        limit: 30,
        nextCursor: "1782133100000_668f1a2b3c4d5e6f7a8b9c00",
        hasMore: true,
      },
      hasMore: true,
      nextCursor: "1782133100000_668f1a2b3c4d5e6f7a8b9c00",
      pinnedMessage: {
        messageId: "683abc000000000000000001",
        roomId: "668f1a2b3c4d5e6f7a8b9c0d",
        communityId: "668f1a2b3c4d5e6f7a8b9c0d",
        senderId: "usr_01j8r5t2q3w4e5r6t7y8u9i0",
        senderName: "Rajesh Sharma",
        senderHandle: "rajesh_s",
        senderAvatar:
          "https://cdn.aimess.me/avatars/usr_rajesh.jpg?X-Amz-Expires=3600",
        messageType: "TEXT",
        text: "Meeting at 3pm tomorrow",
        media: [],
        createdAt: 1782133100000,
        pinnedAt: 1782133200000,
        pinnedBy: "usr_01j8r5t2q3w4e5r6t7y8u9i1",
        isAvailable: true,
      },
      data: [
        // ── Scenario 1: plain TEXT message ──────────────────────────────────
        {
          id: "668f1a2b3c4d5e6f7a8b9c06",
          roomId: "668f1a2b3c4d5e6f7a8b9c0d",
          sentBy: "usr_01j8r5t2q3w4e5r6t7y8u9i0",
          senderName: "Rajesh Sharma",
          senderAvatar:
            "https://cdn.aimess.me/avatars/usr_rajesh.jpg?X-Amz-Expires=3600",
          message: "Hey everyone! 👋 Welcome to the community.",
          reactions: {
            "👍": [
              {
                userId: "usr_01j8r5t2q3w4e5r6t7y8u9i1",
                displayName: "Priya Nair",
                avatar:
                  "https://cdn.aimess.me/avatars/usr_priya.jpg?X-Amz-Expires=3600",
              },
            ],
            "❤️": [
              {
                userId: "usr_01j8r5t2q3w4e5r6t7y8u9i2",
                displayName: "Arjun Mehta",
                avatar: null,
              },
            ],
          },
          parentMessageId: null,
          quoteData: null,
          contentType: "TEXT",
          systemMessageType: null,
          systemMetadata: null,
          isPersonal: false,
          attachments: [],
          deletedForAll: false,
          isEdited: false,
          editedAt: null,
          createdAt: 1782133107521,
          updatedAt: null,
          syncEventType: null,
          readBy: [
            { userId: "usr_01j8r5t2q3w4e5r6t7y8u9i1", readAt: 1782133110000 },
          ],
          deliveredTo: [
            {
              userId: "usr_01j8r5t2q3w4e5r6t7y8u9i1",
              deliveredAt: 1782133107521,
            },
            {
              userId: "usr_01j8r5t2q3w4e5r6t7y8u9i2",
              deliveredAt: 1782133107521,
            },
          ],
        },
        // ── Scenario 2: TEXT reply (parentMessageId + quoteData) ────────────
        {
          id: "668f1a2b3c4d5e6f7a8b9c07",
          roomId: "668f1a2b3c4d5e6f7a8b9c0d",
          sentBy: "usr_01j8r5t2q3w4e5r6t7y8u9i1",
          senderName: "Priya Nair",
          senderAvatar:
            "https://cdn.aimess.me/avatars/usr_priya.jpg?X-Amz-Expires=3600",
          message: "Totally agree! 🙌",
          reactions: {},
          parentMessageId: "668f1a2b3c4d5e6f7a8b9c06",
          quoteData: {
            id: "668f1a2b3c4d5e6f7a8b9c06",
            senderId: "usr_01j8r5t2q3w4e5r6t7y8u9i0",
            senderName: "Rajesh Sharma",
            contentType: "TEXT",
            message: "Hey everyone! 👋 Welcome to the community.",
            attachments: [],
          },
          contentType: "TEXT",
          systemMessageType: null,
          systemMetadata: null,
          isPersonal: false,
          attachments: [],
          deletedForAll: false,
          isEdited: true,
          editedAt: 1782133215000,
          createdAt: 1782133200000,
          updatedAt: 1782133215000,
          syncEventType: null,
          readBy: [],
          deliveredTo: [
            {
              userId: "usr_01j8r5t2q3w4e5r6t7y8u9i0",
              deliveredAt: 1782133200000,
            },
          ],
        },
        // ── Scenario 3: IMAGE message with attachment ────────────────────────
        {
          id: "668f1a2b3c4d5e6f7a8b9c08",
          roomId: "668f1a2b3c4d5e6f7a8b9c0d",
          sentBy: "usr_01j8r5t2q3w4e5r6t7y8u9i2",
          senderName: "Arjun Mehta",
          senderAvatar: null,
          message: "Check out this view 🌅",
          reactions: {},
          parentMessageId: null,
          quoteData: null,
          contentType: "IMAGE",
          systemMessageType: null,
          systemMetadata: null,
          isPersonal: false,
          attachments: [
            {
              url: "https://cdn.aimess.me/media/images/comm_01j9x8vb/668f8a.jpg?X-Amz-Expires=3600",
              objectKey: "media/images/comm_01j9x8vb/668f8a.jpg",
              mime: "image/jpeg",
              size: 512000,
              name: "sunset.jpg",
              contentType: "IMAGE",
              width: 1920,
              height: 1080,
              blurhash: "LqKk3+%NIXxu~qxt%MWBt7WBNGjY",
              durationMs: null,
              waveform: null,
            },
          ],
          deletedForAll: false,
          isEdited: false,
          editedAt: null,
          createdAt: 1782133300000,
          updatedAt: null,
          syncEventType: null,
          readBy: [],
          deliveredTo: [],
        },
        // ── Scenario 4: VOICE note with waveform ─────────────────────────────
        {
          id: "668f1a2b3c4d5e6f7a8b9c09",
          roomId: "668f1a2b3c4d5e6f7a8b9c0d",
          sentBy: "usr_01j8r5t2q3w4e5r6t7y8u9i3",
          senderName: "Sneha Kulkarni",
          senderAvatar:
            "https://cdn.aimess.me/avatars/usr_sneha.jpg?X-Amz-Expires=3600",
          message: null,
          reactions: {},
          parentMessageId: null,
          quoteData: null,
          contentType: "VOICE",
          systemMessageType: null,
          systemMetadata: null,
          isPersonal: false,
          attachments: [
            {
              url: "https://cdn.aimess.me/media/voice/comm_01j9x8vb/668f9b.ogg?X-Amz-Expires=3600",
              objectKey: "media/voice/comm_01j9x8vb/668f9b.ogg",
              mime: "audio/ogg",
              size: 98304,
              name: "voice_note.ogg",
              contentType: "VOICE",
              width: null,
              height: null,
              durationMs: 34500,
              blurhash: null,
              waveform: [
                0.1, 0.3, 0.6, 0.9, 0.7, 0.4, 0.2, 0.5, 0.8, 0.6, 0.3, 0.2, 0.4,
                0.7, 0.9, 0.8, 0.5, 0.3, 0.1, 0.2, 0.4, 0.6, 0.8, 0.7, 0.5, 0.3,
                0.1, 0.4, 0.6, 0.9, 0.8, 0.7, 0.5, 0.3, 0.2, 0.4, 0.6, 0.8, 0.7,
                0.5, 0.3, 0.2, 0.4, 0.7, 0.9, 0.8, 0.6, 0.4, 0.2, 0.3, 0.5, 0.7,
                0.9, 0.8, 0.6, 0.4, 0.2, 0.1, 0.3, 0.5, 0.7, 0.6, 0.4, 0.2, 0.1,
                0.3, 0.5, 0.7, 0.8, 0.9, 0.7, 0.5, 0.3, 0.1, 0.2, 0.4, 0.6, 0.8,
                0.9, 0.7, 0.5, 0.3, 0.2, 0.4, 0.6, 0.7, 0.8, 0.6, 0.4, 0.2, 0.1,
                0.3, 0.5, 0.6, 0.7, 0.5, 0.3, 0.2, 0.1, 0.2,
              ],
            },
          ],
          deletedForAll: false,
          isEdited: false,
          editedAt: null,
          createdAt: 1782133400000,
          updatedAt: null,
          syncEventType: null,
          readBy: [],
          deliveredTo: [],
        },
        // ── Scenario 5: LOCATION share ───────────────────────────────────────
        {
          id: "668f1a2b3c4d5e6f7a8b9c0a",
          roomId: "668f1a2b3c4d5e6f7a8b9c0d",
          sentBy: "usr_01j8r5t2q3w4e5r6t7y8u9i0",
          senderName: "Rajesh Sharma",
          senderAvatar:
            "https://cdn.aimess.me/avatars/usr_rajesh.jpg?X-Amz-Expires=3600",
          message: "Meeting point 📍",
          reactions: {},
          parentMessageId: null,
          quoteData: null,
          contentType: "LOCATION",
          systemMessageType: null,
          systemMetadata: null,
          isPersonal: false,
          attachments: [
            {
              contentType: "LOCATION",
              lat: 28.6139,
              lng: 77.209,
              placeName: "India Gate",
              placeAddress: "Rajpath, New Delhi, India 110001",
            },
          ],
          deletedForAll: false,
          isEdited: false,
          editedAt: null,
          createdAt: 1782133500000,
          updatedAt: null,
          syncEventType: null,
          readBy: [],
          deliveredTo: [],
        },
        // ── Scenario 6: deleted message (tombstone) ──────────────────────────
        {
          id: "668f1a2b3c4d5e6f7a8b9c0b",
          roomId: "668f1a2b3c4d5e6f7a8b9c0d",
          sentBy: "usr_01j8r5t2q3w4e5r6t7y8u9i2",
          senderName: "Arjun Mehta",
          senderAvatar: null,
          message: null,
          reactions: {},
          parentMessageId: null,
          quoteData: null,
          contentType: "TEXT",
          systemMessageType: null,
          systemMetadata: null,
          isPersonal: false,
          attachments: [],
          deletedForAll: true,
          isEdited: false,
          editedAt: null,
          createdAt: 1782133600000,
          updatedAt: 1782133650000,
          syncEventType: null,
          readBy: [],
          deliveredTo: [],
        },
        // ── Scenario 7: SYSTEM message — role change (visible to all) ────────
        {
          id: "668f1a2b3c4d5e6f7a8b9c0c",
          roomId: "668f1a2b3c4d5e6f7a8b9c0d",
          sentBy: null,
          senderName: null,
          senderAvatar: null,
          message: "Priya Nair is now a moderator",
          reactions: {},
          parentMessageId: null,
          quoteData: null,
          contentType: "SYSTEM",
          systemMessageType: "ROLE_CHANGED",
          systemMetadata: {
            actorUserId: "usr_01j8r5t2q3w4e5r6t7y8u9i0",
            actorName: "Rajesh Sharma",
            targetUserId: "usr_01j8r5t2q3w4e5r6t7y8u9i1",
            targetName: "Priya Nair",
            oldRole: "MEMBER",
            newRole: "MODERATOR",
          },
          isPersonal: false,
          attachments: [],
          deletedForAll: false,
          isEdited: false,
          editedAt: null,
          createdAt: 1782133700000,
          updatedAt: null,
          syncEventType: null,
          readBy: [],
          deliveredTo: [],
        },
        // ── Scenario 8: SYSTEM message — personal join (only viewer sees this)
        {
          id: "668f1a2b3c4d5e6f7a8b9c0e",
          roomId: "668f1a2b3c4d5e6f7a8b9c0d",
          sentBy: null,
          senderName: null,
          senderAvatar: null,
          message: "You joined this community",
          reactions: {},
          parentMessageId: null,
          quoteData: null,
          contentType: "SYSTEM",
          systemMessageType: "COMMUNITY_JOINED",
          systemMetadata: {
            actorUserId: "usr_01j8r5t2q3w4e5r6t7y8u9i4",
            actorName: "New Member",
          },
          isPersonal: true,
          attachments: [],
          deletedForAll: false,
          isEdited: false,
          editedAt: null,
          createdAt: 1782133800000,
          updatedAt: null,
          syncEventType: null,
          readBy: [],
          deliveredTo: [],
        },
      ],
    },
  },
  /** Incremental-sync mode — after_ts. No pagination wrapper. */
  ChatCommunityIncrementalSync: {
    type: "object",
    description:
      "Incremental-sync envelope returned when `after_ts` is provided. " +
      "Contains every community message whose `updatedAt >= after_ts`, sorted updatedAt ASC. " +
      "Includes new messages, edits, reaction changes, and deletions (tombstones with `deletedForAll: true`). " +
      "Store `nextCursor` as the next `after_ts` to page forward or re-sync.",
    properties: {
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/ChatCommunityMessage" },
        description:
          "Each item has a non-null `syncEventType` indicating what reconciliation action to take: " +
          "`new` → insert; `edited` → update text; `deleted` → remove/tombstone; `reacted` → refresh reactions.",
      },
      hasMore: {
        type: "boolean",
        description: "True when more sync events exist beyond this page.",
        example: false,
      },
      nextCursor: {
        type: "string",
        nullable: true,
        description:
          "Epoch-ms string of the last item's `updatedAt`. Feed back as the next `after_ts`. " +
          "Null when no items were returned.",
        example: "1782133650000",
      },
      pinnedMessage: {
        allOf: [{ $ref: "#/components/schemas/CommunityPinnedMessageSummary" }],
        nullable: true,
        description:
          "The room's currently active pinned message, or null if none. See CommunityPinnedMessageSummary.",
      },
    },
    required: ["data", "hasMore", "nextCursor", "pinnedMessage"],
    example: {
      hasMore: false,
      nextCursor: "1782133650000",
      pinnedMessage: null,
      data: [
        // ── new message received while offline ──────────────────────────────
        {
          id: "668f1a2b3c4d5e6f7a8b9c06",
          roomId: "668f1a2b3c4d5e6f7a8b9c0d",
          sentBy: "usr_01j8r5t2q3w4e5r6t7y8u9i0",
          senderName: "Rajesh Sharma",
          senderAvatar:
            "https://cdn.aimess.me/avatars/usr_rajesh.jpg?X-Amz-Expires=3600",
          message: "Don't miss the event tonight!",
          reactions: {},
          parentMessageId: null,
          quoteData: null,
          contentType: "TEXT",
          systemMessageType: null,
          systemMetadata: null,
          isPersonal: false,
          attachments: [],
          deletedForAll: false,
          isEdited: false,
          editedAt: null,
          createdAt: 1782133500000,
          updatedAt: 1782133500000,
          syncEventType: "new",
          readBy: [],
          deliveredTo: [],
        },
        // ── edited message ───────────────────────────────────────────────────
        {
          id: "668f1a2b3c4d5e6f7a8b9c07",
          roomId: "668f1a2b3c4d5e6f7a8b9c0d",
          sentBy: "usr_01j8r5t2q3w4e5r6t7y8u9i1",
          senderName: "Priya Nair",
          senderAvatar:
            "https://cdn.aimess.me/avatars/usr_priya.jpg?X-Amz-Expires=3600",
          message: "Updated: see you all at 7pm! (edited)",
          reactions: {},
          parentMessageId: null,
          quoteData: null,
          contentType: "TEXT",
          systemMessageType: null,
          systemMetadata: null,
          isPersonal: false,
          attachments: [],
          deletedForAll: false,
          isEdited: true,
          editedAt: 1782133600000,
          createdAt: 1782133400000,
          updatedAt: 1782133600000,
          syncEventType: "edited",
          readBy: [],
          deliveredTo: [],
        },
        // ── deleted message (tombstone) ──────────────────────────────────────
        {
          id: "668f1a2b3c4d5e6f7a8b9c08",
          roomId: "668f1a2b3c4d5e6f7a8b9c0d",
          sentBy: "usr_01j8r5t2q3w4e5r6t7y8u9i2",
          senderName: "Arjun Mehta",
          senderAvatar: null,
          message: null,
          reactions: {},
          parentMessageId: null,
          quoteData: null,
          contentType: "TEXT",
          systemMessageType: null,
          systemMetadata: null,
          isPersonal: false,
          attachments: [],
          deletedForAll: true,
          isEdited: false,
          editedAt: null,
          createdAt: 1782133300000,
          updatedAt: 1782133650000,
          syncEventType: "deleted",
          readBy: [],
          deliveredTo: [],
        },
        // ── reaction update ──────────────────────────────────────────────────
        {
          id: "668f1a2b3c4d5e6f7a8b9c05",
          roomId: "668f1a2b3c4d5e6f7a8b9c0d",
          sentBy: "usr_01j8r5t2q3w4e5r6t7y8u9i0",
          senderName: "Rajesh Sharma",
          senderAvatar:
            "https://cdn.aimess.me/avatars/usr_rajesh.jpg?X-Amz-Expires=3600",
          message: "Welcome everyone!",
          reactions: {
            "🔥": [
              {
                userId: "usr_01j8r5t2q3w4e5r6t7y8u9i3",
                displayName: "Sneha Kulkarni",
                avatar:
                  "https://cdn.aimess.me/avatars/usr_sneha.jpg?X-Amz-Expires=3600",
              },
            ],
          },
          parentMessageId: null,
          quoteData: null,
          contentType: "TEXT",
          systemMessageType: null,
          systemMetadata: null,
          isPersonal: false,
          attachments: [],
          deletedForAll: false,
          isEdited: false,
          editedAt: null,
          createdAt: 1782133200000,
          updatedAt: 1782133640000,
          syncEventType: "reacted",
          readBy: [],
          deliveredTo: [],
        },
      ],
    },
  },
  /** Per-user entry inside a community reaction group. */
  ChatCommunityReactionUser: {
    type: "object",
    properties: {
      userId: { type: "string", example: "usr_01j8r5t2q3w4e5r6t7y8u9i1" },
      displayName: { type: "string", example: "Priya Nair" },
      avatar: {
        type: "string",
        nullable: true,
        description: "Presigned avatar URL, or null if the user has no avatar.",
        example:
          "https://cdn.aimess.me/avatars/usr_priya.jpg?X-Amz-Expires=3600",
      },
    },
    required: ["userId", "displayName"],
    example: {
      userId: "usr_01j8r5t2q3w4e5r6t7y8u9i1",
      displayName: "Priya Nair",
      avatar: "https://cdn.aimess.me/avatars/usr_priya.jpg?X-Amz-Expires=3600",
    },
  },
  /** Grouped emoji reaction (used in ChatCommunityReactResponse and community:message:reaction socket event). */
  ChatCommunityReactionGroup: {
    type: "object",
    description:
      "All reactions for one emoji, grouped. " +
      "Used in the REST react response and the `community:message:reaction` socket event. " +
      "Not the same as the `reactions` dictionary in `ChatCommunityMessage` (history format).",
    properties: {
      emoji: {
        type: "string",
        description: "Unicode emoji.",
        example: "👍",
      },
      count: {
        type: "integer",
        description: "Total number of users who reacted with this emoji.",
        example: 3,
      },
      users: {
        type: "array",
        items: { $ref: "#/components/schemas/ChatCommunityReactionUser" },
        description:
          "List of users who used this emoji (may be capped server-side).",
      },
    },
    required: ["emoji", "count", "users"],
    example: {
      emoji: "👍",
      count: 3,
      users: [
        {
          userId: "usr_01j8r5t2q3w4e5r6t7y8u9i1",
          displayName: "Priya Nair",
          avatar:
            "https://cdn.aimess.me/avatars/usr_priya.jpg?X-Amz-Expires=3600",
        },
        {
          userId: "usr_01j8r5t2q3w4e5r6t7y8u9i2",
          displayName: "Arjun Mehta",
          avatar: null,
        },
        {
          userId: "usr_01j8r5t2q3w4e5r6t7y8u9i3",
          displayName: "Sneha Kulkarni",
          avatar:
            "https://cdn.aimess.me/avatars/usr_sneha.jpg?X-Amz-Expires=3600",
        },
      ],
    },
  },
  /** Body for POST /chat/community/messages/{messageId}/react */
  ChatCommunityReactRequest: {
    type: "object",
    required: ["communityId", "emoji"],
    properties: {
      communityId: {
        type: "string",
        description: "Community the message belongs to.",
        example: "comm_01j9x8vb2f3g4h5k6m7n8p9q",
      },
      emoji: {
        type: "string",
        minLength: 1,
        maxLength: 10,
        description:
          'Unicode emoji (e.g. `"👍"`, `"❤️"`, `"😂"`). ' +
          "Sending the same emoji a second time removes the reaction (toggle — no separate un-react endpoint needed).",
        example: "👍",
      },
    },
    example: {
      communityId: "comm_01j9x8vb2f3g4h5k6m7n8p9q",
      emoji: "👍",
    },
  },
  /** Response for POST /chat/community/messages/{messageId}/react */
  ChatCommunityReactResponse: {
    type: "object",
    description:
      "Current reaction state after the toggle. " +
      "The `community:message:reaction` Socket.IO event carries the same shape. " +
      "Sending the same emoji again removes it (toggle semantics). " +
      "Note: the history endpoint (`ChatCommunityMessage.reactions`) uses a dictionary format " +
      '`{ "👍": [users] }`; this endpoint uses the grouped-array format below.',
    properties: {
      messageId: { type: "string", example: "668f1a2b3c4d5e6f7a8b9c02" },
      communityId: { type: "string", example: "comm_01j9x8vb2f3g4h5k6m7n8p9q" },
      reactions: {
        type: "array",
        items: { $ref: "#/components/schemas/ChatCommunityReactionGroup" },
        description:
          "Full grouped reaction state for the message, ordered by first reaction time. " +
          "An empty array means all reactions were toggled off.",
      },
    },
    required: ["messageId", "communityId", "reactions"],
    example: {
      messageId: "668f1a2b3c4d5e6f7a8b9c02",
      communityId: "comm_01j9x8vb2f3g4h5k6m7n8p9q",
      reactions: [
        {
          emoji: "👍",
          count: 2,
          users: [
            {
              userId: "usr_01j8r5t2q3w4e5r6t7y8u9i1",
              displayName: "Priya Nair",
              avatar:
                "https://cdn.aimess.me/avatars/usr_priya.jpg?X-Amz-Expires=3600",
            },
            {
              userId: "usr_01j8r5t2q3w4e5r6t7y8u9i2",
              displayName: "Arjun Mehta",
              avatar: null,
            },
          ],
        },
        {
          emoji: "❤️",
          count: 1,
          users: [
            {
              userId: "usr_01j8r5t2q3w4e5r6t7y8u9i3",
              displayName: "Sneha Kulkarni",
              avatar:
                "https://cdn.aimess.me/avatars/usr_sneha.jpg?X-Amz-Expires=3600",
            },
          ],
        },
      ],
    },
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
      mediaId: {
        type: "string",
        nullable: true,
        description:
          "Stable, immutable media identity — independent of objectKey/url. Null for legacy stickers sent before this field existed.",
      },
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
      initiatedAt: {
        type: "integer",
        format: "int64",
        description: "Epoch ms.",
      },
      answeredAt: {
        type: "integer",
        format: "int64",
        nullable: true,
        description: "Epoch ms.",
      },
      endedAt: {
        type: "integer",
        format: "int64",
        nullable: true,
        description: "Epoch ms.",
      },
      durationSec: { type: "integer", nullable: true },
      endedBy: { type: "string", format: "uuid", nullable: true },
      createdAt: { type: "integer", format: "int64", description: "Epoch ms." },
      updatedAt: { type: "integer", format: "int64", description: "Epoch ms." },
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
    description:
      "Reactions on a single message, keyed by emoji. Returned by GET .../messages/{messageId}/reactions for private and group messages. The emoji is the object key; there is no top-level `messageId` and no array form.",
    properties: {
      reactions: {
        type: "object",
        description: "Map of emoji → reaction summary (emoji is the key).",
        additionalProperties: {
          type: "object",
          properties: {
            count: { type: "integer" },
            selfReacted: {
              type: "boolean",
              description:
                "True if the requesting user reacted with this emoji.",
            },
            users: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  userId: { type: "string" },
                  displayName: { type: "string" },
                  avatar: { type: "string" },
                },
                required: ["userId", "displayName", "avatar"],
              },
            },
          },
          required: ["count", "selfReacted", "users"],
        },
      },
    },
    required: ["reactions"],
  },
  /** Body for POST .../messages/{messageId}/reactions (add a reaction). */
  ChatReactRequest: {
    type: "object",
    required: ["emoji"],
    properties: {
      emoji: {
        type: "string",
        minLength: 1,
        maxLength: 32,
        example: "👍",
        description: "Unicode emoji to add as the caller's reaction.",
      },
    },
  },
  /**
   * Grouped emoji reaction in the POST/DELETE reaction response. Unlike
   * ChatReactionGroup (used by the GET reactions read), this omits `selfReacted`
   * — the add/remove response mirrors the `message:reaction` broadcast, which is
   * per-conversation (not per-viewer); a client derives selfReacted from
   * users[].userId === myUserId.
   */
  ChatReactGroup: {
    type: "object",
    properties: {
      emoji: { type: "string", example: "👍" },
      count: { type: "integer", description: "Number of users who reacted." },
      users: {
        type: "array",
        items: { $ref: "#/components/schemas/ChatReactionUser" },
      },
    },
    required: ["emoji", "count", "users"],
  },
  /**
   * Response for POST/DELETE .../messages/{messageId}/reactions[/{emoji}].
   * Carries the full grouped reaction state after the op — the same `reactions`
   * array the server broadcasts on the `message:reaction` Socket.IO event.
   */
  ChatReactResponse: {
    type: "object",
    properties: {
      reactions: {
        type: "array",
        items: { $ref: "#/components/schemas/ChatReactGroup" },
        description:
          "Full grouped reaction state for the message after the op.",
      },
    },
    required: ["reactions"],
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
    description:
      "Body for `PATCH /chat/community/messages/{messageId}`. " +
      "Only TEXT messages can be edited. The edit window is 15 minutes from original send time. " +
      "After the window closes the server returns 410 `CHAT_EDIT_WINDOW_EXPIRED`.",
    properties: {
      communityId: {
        type: "string",
        minLength: 1,
        description:
          "Community the message belongs to — required so the edit broadcast reaches the right community room.",
        example: "comm_01j9x8vb2f3g4h5k6m7n8p9q",
      },
      content: {
        type: "object",
        required: ["text"],
        properties: {
          text: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
            description:
              "New plain-text body (replaces the original text in-place).",
            example: "Updated: Hey everyone! 👋 Thanks for joining.",
          },
        },
      },
    },
    example: {
      communityId: "comm_01j9x8vb2f3g4h5k6m7n8p9q",
      content: { text: "Updated: Hey everyone! 👋 Thanks for joining." },
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
  CommunityPinResponse: {
    type: "object",
    description: "Result of pinning or unpinning a community message.",
    properties: {
      pinnedIds: {
        type: "array",
        items: { type: "string" },
        description: "All currently pinned message IDs in this room.",
      },
      pinnedCount: {
        type: "integer",
        description: "Total number of pinned messages.",
      },
      pinnedAt: {
        type: "integer",
        format: "int64",
        description: "Epoch ms when pinned. Present on pin only.",
      },
    },
    required: ["pinnedIds", "pinnedCount"],
  },

  // ===========================================================================
  // chat-service · community-chat pins (raw persisted rows → epoch-ms dates)
  // ===========================================================================
  CommunityPinnedMessageSummary: {
    type: "object",
    nullable: true,
    description:
      "FE-header-ready snapshot of the room's currently pinned message, embedded as a top-level `pinnedMessage` field on the Community Messages API response (both scroll/history and incremental-sync modes) — reusing the same `CommunityMessagePin` persistence as pin/unpin, no separate endpoint. " +
      "`null` when the room has no active pin. Computed fresh on every call (never cached) — updates immediately after pin, unpin, or pinning a different message. " +
      "Solves the problem where the `PINNED_MESSAGE` system message scrolls out of view as newer messages arrive, leaving the FE with no reliable way to know the currently pinned message from history alone.",
    properties: {
      messageId: { type: "string", description: "Pinned message ObjectId." },
      roomId: { type: "string" },
      communityId: { type: "string" },
      senderId: { type: "string", format: "uuid" },
      senderName: {
        type: "string",
        description:
          "Sourced from the LIVE message row when available, so a display-name change after pinning is reflected.",
      },
      senderHandle: {
        type: "string",
        description:
          "Resolved from the user snapshot cache; empty string if not resolvable.",
      },
      senderAvatar: {
        type: "string",
        description:
          "Fully-qualified, ready-to-use presigned GET URL (time-limited, ~1h), or empty string.",
      },
      messageType: {
        type: "string",
        description:
          "Canonical UPPER-CASE content type (e.g. TEXT, IMAGE, VIDEO) of the live message.",
      },
      text: {
        type: "string",
        description: "Live message text/preview.",
      },
      media: {
        type: "array",
        items: { type: "object" },
        description:
          "Resolved attachment array (presigned URLs) from the live message. Empty array if none, or if the original message was hard-deleted.",
      },
      createdAt: {
        type: "integer",
        format: "int64",
        description: "Epoch ms — the live message's own createdAt.",
      },
      pinnedAt: {
        type: "integer",
        format: "int64",
        description: "Epoch ms when this pin was created.",
      },
      pinnedBy: {
        type: "string",
        format: "uuid",
        description: "User ID who pinned the message.",
      },
      isAvailable: {
        type: "boolean",
        description:
          "False only if the pinned message was hard-deleted (deletedForAll). " +
          "When false, `senderName`/`text` fall back to the pin's own frozen snapshot and `media` is `[]` — mirrors the existing pin-banner \"Message doesn't exist\" state.",
      },
    },
    required: [
      "messageId",
      "roomId",
      "communityId",
      "senderId",
      "senderName",
      "senderHandle",
      "senderAvatar",
      "messageType",
      "text",
      "media",
      "createdAt",
      "pinnedAt",
      "pinnedBy",
      "isAvailable",
    ],
    example: {
      messageId: "683abc000000000000000001",
      roomId: "668f1a2b3c4d5e6f7a8b9c0d",
      communityId: "668f1a2b3c4d5e6f7a8b9c0d",
      senderId: "usr_01j8r5t2q3w4e5r6t7y8u9i0",
      senderName: "Rajesh Sharma",
      senderHandle: "rajesh_s",
      senderAvatar:
        "https://cdn.aimess.me/avatars/usr_rajesh.jpg?X-Amz-Expires=3600",
      messageType: "TEXT",
      text: "Meeting at 3pm tomorrow",
      media: [],
      createdAt: 1782133100000,
      pinnedAt: 1782133200000,
      pinnedBy: "usr_01j8r5t2q3w4e5r6t7y8u9i1",
      isAvailable: true,
    },
  },
  CommunityMessagePin: {
    type: "object",
    description:
      "A pinned community-chat message (raw persisted row). Date fields are epoch milliseconds (Date→number via the ApiResponse serializer).",
    properties: {
      id: { type: "string", description: "Pin id (Mongo ObjectId, 24-hex)." },
      roomId: { type: "string" },
      messageId: { type: "string", description: "Pinned message ObjectId." },
      pinnedBy: {
        type: "string",
        format: "uuid",
        description: "User ID who pinned the message.",
      },
      pinnedAt: {
        type: "integer",
        format: "int64",
        description: "Epoch ms when the message was pinned.",
      },
      messageCreatedAt: {
        type: "integer",
        format: "int64",
        description: "Epoch ms when the original message was created.",
      },
      senderId: { type: "string", format: "uuid" },
      senderDisplayName: { type: "string" },
      senderAvatar: {
        type: "string",
        nullable: true,
        description:
          "Fully-qualified, ready-to-use presigned GET URL (time-limited, ~1h). Render it directly — do not build it from a key or call a separate download endpoint.",
      },
      contentPinned: {
        type: "object",
        description: "Snapshot of the pinned message content.",
        properties: {
          text: { type: "string" },
          urls: { type: "array", items: { type: "string" } },
          files: { type: "array", items: { type: "object" } },
        },
      },
    },
    required: [
      "id",
      "roomId",
      "messageId",
      "pinnedBy",
      "pinnedAt",
      "messageCreatedAt",
      "senderId",
      "senderDisplayName",
      "contentPinned",
    ],
  },
  CommunityMessagePinWithCount: {
    type: "object",
    description:
      "Result of pinning a community-chat message: the created pin plus the room's new pinned count.",
    properties: {
      pin: { $ref: "#/components/schemas/CommunityMessagePin" },
      pinnedCount: {
        type: "integer",
        description: "Total pinned messages in the room after this pin.",
      },
    },
    required: ["pin", "pinnedCount"],
  },
  CommunityMessageUnpinResult: {
    type: "object",
    description: "Result of unpinning a community-chat message.",
    properties: {
      pin: {
        allOf: [{ $ref: "#/components/schemas/CommunityMessagePin" }],
        nullable: true,
        description: "The soft-deleted pin record (null if not found).",
      },
      pinnedCount: {
        type: "integer",
        description:
          "Total active pinned messages in the room after the unpin.",
      },
    },
    required: ["pin", "pinnedCount"],
  },
  CommunityMessagePinList: {
    type: "object",
    description:
      'Cursor-paginated pinned messages for a community room. `data[].pinnedAt` is epoch ms (number). `nextCursor` is a compound `"<ms>_<id>"` string — pass it verbatim as `?cursor=` for the next page.',
    properties: {
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/CommunityMessagePin" },
      },
      nextCursor: {
        type: "string",
        nullable: true,
        description:
          'Compound `"<pinnedAt_ms>_<pinId>"` cursor for the next page; null when no more pages.',
      },
      hasMore: { type: "boolean" },
    },
    required: ["data", "nextCursor", "hasMore"],
  },

  // ===========================================================================
  // backoffice-service · moderation (related reports)
  // ===========================================================================
  AdminModerationRelatedReport: {
    type: "object",
    description:
      "A report related to another (same reported user or target). Item shape for GET /admin/v1/reports/{reportId}/related (Phase 1 — mock data behind the real contract).",
    properties: {
      reportId: { type: "string" },
      reportType: {
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
      },
      status: {
        type: "string",
        enum: ["PENDING", "UNDER_REVIEW", "RESOLVED", "DISMISSED", "ESCALATED"],
      },
      createdAt: { type: "string", format: "date-time" },
    },
    required: ["reportId", "reportType", "status", "createdAt"],
  },
} as const;
