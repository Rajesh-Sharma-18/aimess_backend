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
      avatarUrl: {
        type: "string",
        format: "uri",
        description:
          "Always present. Custom avatar URL if set, otherwise a system-generated default avatar derived from the admin's name/id.",
        example: "https://api.dicebear.com/9.x/initials/svg?seed=Ops%20Admin",
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
    required: ["id", "email", "avatarUrl", "role", "permissions"],
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
        enum: ["ACTIVE", "BANNED", "DELETED"],
        example: "ACTIVE",
      },
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
      avatarUrl: { type: "string", nullable: true },
      avatar: { $ref: "#/components/schemas/MediaObject" },
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
      avatarUrl: { type: "string", nullable: true },
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
      avatarUrl: { type: "string", nullable: true },
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
      "One row of the 'Reported Details' panel — a report filed against the user, with the reporter resolved.",
    properties: {
      reportId: { type: "string", example: "r_12" },
      reason: { type: "string", example: "HARASSMENT" },
      details: {
        type: "string",
        nullable: true,
        description: "Reporter free-text ('Other Reason').",
      },
      status: {
        type: "string",
        enum: ["open", "reviewing", "resolved", "dismissed"],
        example: "open",
      },
      createdAt: { type: "string", format: "date-time" },
      reporter: {
        type: "object",
        properties: {
          userId: { type: "string", example: "u_aa" },
          username: { type: "string", nullable: true },
          avatarUrl: { type: "string", nullable: true },
          avatarUrlExpiresIn: { type: "integer", nullable: true },
          avatar: { $ref: "#/components/schemas/MediaObject" },
        },
        required: ["userId"],
      },
    },
    required: ["reportId", "reason", "status", "createdAt", "reporter"],
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
        enum: ["ACTIVE", "BANNED", "DELETED"],
      },
      profile: {
        type: "object",
        description: "Profile/stats projected from user-service.",
      },
      moderationHistory: {
        type: "array",
        items: { $ref: "#/components/schemas/AdminModerationAction" },
      },
      reportCategories: {
        type: "array",
        description:
          "Per-category report counts (all categories) for the 'Reported Details' chips.",
        items: {
          type: "object",
          properties: {
            reason: { type: "string", example: "SPAM" },
            count: { type: "integer", example: 3 },
          },
          required: ["reason", "count"],
        },
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
  AdminGroupAdmin: {
    type: "object",
    description:
      "Group owner identity, composed from the chat-service group (role=OWNER member, fallback createdBy) + user-service (username/avatar) + auth-service (email). email/avatarUrl are null when the upstream identity could not be resolved.",
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
      avatarUrl: {
        type: "string",
        nullable: true,
        description:
          "Fully-qualified, ready-to-use presigned GET URL (time-limited, ~1h). The client renders it directly — never construct it from a key or call a separate download endpoint.",
        example: "https://cdn.aimess.app/avatars/u_9f3a.webp",
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
      avatarUrl: {
        type: "string",
        nullable: true,
        description:
          "Fully-qualified, ready-to-use presigned GET URL (time-limited, ~1h). The client renders it directly — never construct it from a key or call a separate download endpoint.",
        example: "https://cdn.aimess.app/group-avatars/grp_9a.webp",
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
      avatarUrl: {
        type: "string",
        nullable: true,
        description:
          "Fully-qualified, ready-to-use presigned GET URL (time-limited, ~1h). The client renders it directly — never construct it from a key or call a separate download endpoint.",
        example: "https://cdn.aimess.app/avatars/u_9f3a.webp",
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
      status: { type: "string", enum: ["LIVE", "ENDED", "CANCELLED"] },
      community: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          slug: { type: "string" },
        },
      },
      creator: {
        type: "object",
        properties: {
          id: { type: "string" },
          username: { type: "string" },
          displayName: { type: "string" },
          avatarUrl: { type: "string", nullable: true },
        },
      },
      createdAt: { type: "string", format: "date-time" },
      startedAt: { type: "string", format: "date-time" },
      endedAt: { type: "string", format: "date-time", nullable: true },
      durationSeconds: { type: "integer", example: 3600 },
      viewerCount: { type: "integer", example: 134 },
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
          avatarUrl: { type: "string", nullable: true },
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
      isLive: {
        type: "boolean",
        description:
          "True when the community has an active livestream. Phase 1 stub — always false until stream-service ships.",
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
      "streamEnabled",
      "chatEnabled",
      "announcementEnabled",
      "isJoined",
      "moderationStatus",
      "isLive",
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
    },
    required: [
      "id",
      "name",
      "slug",
      "visible",
      "order",
      "createdAt",
      "updatedAt",
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
          "True when the community has an active livestream right now. Phase 1 stub — always false until stream-service ships.",
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
      "streamEnabled",
      "chatEnabled",
      "announcementEnabled",
      "moderationStatus",
      "isLive",
      "lastActivityAt",
      "lastActivity",
      "unreadMessageCount",
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
        description:
          "Cursor for the next page. For offset/page pagination this is null (use page param). " +
          "For timeline/cursor-paginated endpoints this is an epoch-ms string — feed it back as the same before_ts/after_ts you used.",
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
          "True when the community has an active livestream right now. Phase 1 stub — always false until stream-service ships.",
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
      request: { $ref: "#/components/schemas/JoinRequestData" },
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
      lastMessageAt: {
        type: "integer",
        format: "int64",
        nullable: true,
        description: "Epoch ms.",
      },
      lastMessage: { type: "object", nullable: true },
      pinnedCount: { type: "integer" },
      createdAt: { type: "integer", format: "int64", description: "Epoch ms." },
      updatedAt: { type: "integer", format: "int64", description: "Epoch ms." },
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
    properties: {
      messageId: { type: "string" },
      communityId: { type: "string" },
      roomId: { type: "string" },
      deleteType: {
        type: "string",
        enum: ["forMe", "forEveryone"],
        description: "Delete scope.",
      },
      deletedBy: { type: "string" },
    },
    required: ["messageId", "communityId", "roomId", "deleteType", "deletedBy"],
  },
  /**
   * REST body for community message EDIT — matches the socket `community:message:edited` payload.
   */
  ChatCommunityEditResponse: {
    type: "object",
    properties: {
      messageId: { type: "string" },
      communityId: { type: "string" },
      roomId: { type: "string" },
      content: {
        type: "object",
        nullable: true,
        description: "Updated message body.",
      },
      contentType: {
        type: "string",
        description: "UPPER-CASE message kind (TEXT, IMAGE, …).",
      },
      editedAt: {
        type: "integer",
        format: "int64",
        description: "Epoch ms when the message was last edited.",
      },
      sequenceNumber: {
        type: "integer",
        description: "Per-room sequence number.",
      },
    },
    required: ["messageId", "communityId", "roomId"],
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
      isLive: { type: "boolean" },
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
    properties: {
      id: { type: "string" },
      roomId: { type: "string" },
      sentBy: { type: "string" },
      senderName: { type: "string", nullable: true },
      senderAvatar: {
        type: "string",
        nullable: true,
        description:
          "Fully-qualified, ready-to-use presigned GET URL (time-limited, ~1h). Render it directly — do not build it from a key or call a separate download endpoint.",
      },
      message: { type: "string", nullable: true },
      reactions: { type: "object" },
      parentMessageId: { type: "string", nullable: true },
      contentType: {
        type: "string",
        description:
          "Community message kind (UPPER-CASE on the wire): TEXT, IMAGE, VOICE, CUSTOM, LOCATION, CONTACT, STICKER.",
      },
      attachments: {
        type: "array",
        description:
          "Media / sticker / location / contact attachments. Sticker entries follow ChatSticker. Send-time caps: text ≤4000 chars; ≤10 images; video ≤100MB/180000ms; voice ≤300000ms; other files ≤50MB.",
        items: { type: "object" },
      },
      deletedForAll: { type: "boolean" },
      editedAt: {
        type: "integer",
        format: "int64",
        nullable: true,
        description: "Epoch ms. Non-null when the message has been edited.",
      },
      createdAt: { type: "integer", format: "int64", description: "Epoch ms." },
      updatedAt: {
        type: "integer",
        description:
          "Epoch-ms of the last mutation (edit, reaction, delete). Present in incremental-sync (after_ts) responses only.",
        nullable: true,
      },
      syncEventType: {
        type: "string",
        enum: ["new", "edited", "deleted", "reacted"],
        nullable: true,
        description:
          "Only present in after_ts (incremental-sync) responses. Tells the client what reconciliation action to take: 'new'=insert, 'edited'=update text, 'deleted'=remove (tombstone), 'reacted'=refresh reaction counts.",
      },
      readBy: {
        type: "array",
        description:
          "Users who have read this message (lastReadAt >= message.createdAt). Excludes the sender. Each entry carries an epoch-ms timestamp.",
        items: {
          type: "object",
          properties: {
            userId: { type: "string" },
            readAt: {
              type: "integer",
              description:
                "Epoch milliseconds when the user read up to this message.",
            },
          },
          required: ["userId", "readAt"],
        },
      },
      deliveredTo: {
        type: "array",
        description:
          "Users who were active members of this room at the time the message was sent (joinedAt <= message.createdAt). Excludes the sender.",
        items: {
          type: "object",
          properties: {
            userId: { type: "string" },
            deliveredAt: {
              type: "integer",
              description:
                "Epoch milliseconds — equals the message createdAt timestamp.",
            },
          },
          required: ["userId", "deliveredAt"],
        },
      },
    },
    required: ["id", "roomId", "sentBy", "createdAt"],
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
    properties: {
      id: { type: "string" },
      messageId: { type: "string", description: "Alias of id." },
      communityId: {
        type: "string",
        description: "community-service Community.id (broadcast channel key).",
      },
      roomId: { type: "string", description: "chat-service GeneralRoom.id." },
      senderId: { type: "string" },
      senderName: { type: "string" },
      senderAvatar: {
        type: "string",
        description:
          "Fully-qualified presigned GET URL (resolved on read), or empty string.",
      },
      parentMessageId: {
        type: "string",
        description: "Replied-to message id, or empty string.",
      },
      quoteData: {
        type: "object",
        nullable: true,
        description: "Canonical reply snapshot, or null.",
      },
      content: {
        type: "object",
        description:
          "Structured body. `content.files[]` carry resolved presigned download URLs.",
        properties: {
          text: { type: "string" },
          files: { type: "array", items: { type: "object" } },
          location: { $ref: "#/components/schemas/ChatLocationAttachment" },
          contact: { $ref: "#/components/schemas/ChatContactAttachment" },
          sticker: { $ref: "#/components/schemas/ChatSticker" },
        },
        required: ["text", "files"],
      },
      reactions: {
        type: "array",
        description: "Always [] on a fresh send.",
        items: { type: "object" },
      },
      message: {
        type: "string",
        description: "Plain-text body (mirrors content.text).",
      },
      contentType: {
        type: "string",
        description: "Canonical UPPER-CASE message kind.",
      },
      clientMessageId: {
        type: "string",
        description: "Echo of the idempotency key (empty string if none).",
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
      "messageId",
      "communityId",
      "roomId",
      "senderId",
      "content",
      "contentType",
      "serverTs",
      "sequenceNumber",
    ],
  },
  /** Scroll / history mode — before_ts (default). Includes top-level hasMore + nextCursor shortcuts. */
  ChatCommunityMessagePage: {
    type: "object",
    description:
      "Timestamp-paginated community messages (scroll/history mode). Use before_ts to scroll backwards; omit for the newest page.",
    properties: {
      pagination: { $ref: "#/components/schemas/PaginationMeta" },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/ChatCommunityMessage" },
      },
      hasMore: {
        type: "boolean",
        description: "Top-level shortcut — same value as pagination.hasMore.",
      },
      nextCursor: {
        type: "string",
        nullable: true,
        description:
          "Top-level shortcut — epoch-ms string; feed back as before_ts for the next page.",
      },
    },
    required: ["pagination", "data", "hasMore", "nextCursor"],
  },
  /** Incremental-sync mode — after_ts. No pagination wrapper. */
  ChatCommunityIncrementalSync: {
    type: "object",
    description:
      "Incremental-sync envelope returned when after_ts is provided. Contains every community message whose updatedAt >= after_ts, sorted updatedAt ASC. Includes edits, reaction updates, and deletions (tombstones with deletedForAll=true). Store nextCursor as the next after_ts to page forward or re-sync.",
    properties: {
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/ChatCommunityMessage" },
        description:
          "Each item has a non-null syncEventType indicating what reconciliation action to take.",
      },
      hasMore: { type: "boolean" },
      nextCursor: {
        type: "string",
        nullable: true,
        description:
          "Epoch-ms of the last item's updatedAt. Feed back as the next after_ts. Null when no items returned.",
      },
    },
    required: ["data", "hasMore", "nextCursor"],
  },
  /** Per-user entry inside a community reaction group. */
  ChatCommunityReactionUser: {
    type: "object",
    properties: {
      userId: { type: "string" },
      displayName: { type: "string" },
      avatar: { type: "string", nullable: true },
    },
    required: ["userId", "displayName"],
  },
  /** Grouped emoji reaction. */
  ChatCommunityReactionGroup: {
    type: "object",
    properties: {
      emoji: { type: "string", description: "Unicode emoji." },
      count: { type: "integer", description: "Number of users who reacted." },
      users: {
        type: "array",
        items: { $ref: "#/components/schemas/ChatCommunityReactionUser" },
        description: "Up to N users who used this emoji.",
      },
    },
    required: ["emoji", "count", "users"],
  },
  /** Body for POST /chat/community/messages/{messageId}/react */
  ChatCommunityReactRequest: {
    type: "object",
    required: ["communityId", "emoji"],
    properties: {
      communityId: {
        type: "string",
        description: "Community the message belongs to.",
      },
      emoji: {
        type: "string",
        minLength: 1,
        maxLength: 10,
        description:
          "Unicode emoji. Sending the same emoji again removes it (toggle).",
      },
    },
  },
  /** Response for POST /chat/community/messages/{messageId}/react */
  ChatCommunityReactResponse: {
    type: "object",
    description:
      "Current reaction state after the toggle. The community:message:reaction Socket.IO event carries the same shape.",
    properties: {
      messageId: { type: "string" },
      communityId: { type: "string" },
      reactions: {
        type: "array",
        items: { $ref: "#/components/schemas/ChatCommunityReactionGroup" },
        description: "Full grouped reaction state for the message.",
      },
    },
    required: ["messageId", "communityId", "reactions"],
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
      pinnedCount: {
        type: "integer",
        description: "Total pinned messages in the room after the unpin.",
      },
    },
    required: ["pinnedCount"],
  },
  CommunityMessagePinList: {
    type: "object",
    description:
      "Cursor-paginated pinned messages for a community room. `items[].pinnedAt` is epoch ms (number), but `nextCursor` is the ISO-8601 pinnedAt of the last item (string).",
    properties: {
      items: {
        type: "array",
        items: { $ref: "#/components/schemas/CommunityMessagePin" },
      },
      nextCursor: {
        type: "string",
        format: "date-time",
        nullable: true,
        description: "ISO-8601 pinnedAt cursor for the next page; null at end.",
      },
      hasMore: { type: "boolean" },
    },
    required: ["items", "nextCursor", "hasMore"],
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
