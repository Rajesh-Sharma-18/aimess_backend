export const openApiSchemas = {
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
      email: { type: "string", format: "email", example: "john@example.com" },
      createdAt: { type: "string", format: "date-time" },
    },
    required: ["userId", "account", "email"],
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
  RegisterRequest: {
    type: "object",
    properties: {
      account: {
        type: "string",
        minLength: 3,
        maxLength: 32,
        pattern: "^[a-zA-Z0-9_]+$",
        example: "johndoe",
      },
      email: {
        type: "string",
        format: "email",
        example: "john@example.com",
      },
      password: { type: "string", minLength: 8, maxLength: 128 },
    },
    required: ["account", "email", "password"],
  },
  ValidateAccountRequest: {
    type: "object",
    properties: {
      account: {
        type: "string",
        minLength: 3,
        maxLength: 32,
        pattern: "^[a-zA-Z0-9_]+$",
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
    },
    required: ["tokens"],
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
        description: "Google ID token from Sign-In SDK",
      },
    },
    required: ["idToken"],
  },
  AppleLoginRequest: {
    type: "object",
    properties: {
      identityToken: {
        type: "string",
        description: "Apple identity token (JWT) from Sign in with Apple",
      },
      email: {
        type: "string",
        format: "email",
        description: "Required on first Apple sign-in when not in the token",
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
      idToken: { type: "string" },
    },
    required: ["idToken"],
  },
  LinkAppleRequest: {
    type: "object",
    properties: {
      identityToken: { type: "string" },
      email: { type: "string", format: "email" },
      fullName: { type: "string" },
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
      tokens: { $ref: "#/components/schemas/AuthTokens" },
    },
    required: ["isNewUser", "user", "tokens"],
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
        example: "john_doe",
      },
    },
    required: ["username"],
  },
  ValidateUsernameResponseData: {
    type: "object",
    properties: {
      username: { type: "string" },
      available: { type: "boolean" },
    },
    required: ["username", "available"],
  },
  AvatarUploadUrlRequest: {
    type: "object",
    properties: {
      contentType: {
        type: "string",
        enum: ["image/jpeg", "image/png", "image/webp"],
      },
      contentLength: {
        type: "integer",
        minimum: 1,
        maximum: 5242880,
        description:
          "Exact file size in bytes (max 5 MB by default). Must match the PUT body.",
        example: 245678,
      },
    },
    required: ["contentType", "contentLength"],
  },
  AvatarUploadUrlResponseData: {
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
        description: "Server max avatar size in bytes",
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
    description: "Profile fields (PATCH /profiles/me response).",
    properties: {
      userId: { type: "string", format: "uuid" },
      username: { type: "string" },
      firstName: { type: "string" },
      lastName: { type: "string" },
      bio: { type: "string", nullable: true },
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
      "live = from auth-service; cached = auth down, stale Redis copy; unavailable = auth down, no cache (account is null).",
  },
  UserProfileResponse: {
    allOf: [
      { $ref: "#/components/schemas/UserProfileData" },
      {
        type: "object",
        description: "GET /profiles/me — includes connected sign-in providers.",
        properties: {
          account: {
            allOf: [{ $ref: "#/components/schemas/AuthAccountSummary" }],
            nullable: true,
          },
          accountStatus: { $ref: "#/components/schemas/AccountLoadStatus" },
        },
        required: ["account", "accountStatus"],
      },
    ],
  },
} as const;
