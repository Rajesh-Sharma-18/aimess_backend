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
