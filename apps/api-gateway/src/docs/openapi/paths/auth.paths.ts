/** Paths are relative to server URL `…/api/v1` (see openapi-document). */

// ---------------------------------------------------------------------------
// Shared error responses
// ---------------------------------------------------------------------------
const unauthorized = {
  description: "Missing or invalid access token",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
      example: {
        success: false,
        message: "Unauthorized: missing or invalid access token",
      },
    },
  },
};

const _badRequest = {
  description: "Validation failed",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
      example: {
        success: false,
        message: "Validation error",
        errors: {
          account:
            "Account must be 3–32 characters, lowercase letters, digits, underscores only",
        },
      },
    },
  },
};

const serviceUnavailable = {
  description:
    "Auth service unavailable (circuit breaker open or service down)",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
      example: {
        success: false,
        message: "Auth service is temporarily unavailable. Please try again.",
      },
    },
  },
};

const tooManyRequests = {
  description: "Rate limit exceeded — too many OTP requests",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
      example: {
        success: false,
        message:
          "Too many requests. Please wait before requesting another OTP.",
        code: "RATE_LIMIT_EXCEEDED",
      },
    },
  },
};

export const authPaths = {
  "/auth/challenge": {
    post: {
      tags: ["Auth"],
      summary: "Get a signup proof-of-work challenge",
      operationId: "getSignupChallenge",
      description:
        "Issues the proof of work that `POST /auth/register` and `POST /auth/accounts/validate` require. No authentication." +
        "\n\nBoth of those endpoints used to be free to call, which made bulk account creation and full enumeration of the handle namespace cost nothing but HTTP requests. Per-IP throttling bounds one address and does nothing about a proxy pool, so each attempt now costs the caller CPU instead." +
        "\n\n**Client flow:** call this, then find a `solution` string such that `sha256(challenge + \".\" + solution)` starts with at least `difficultyBits` leading zero bits — a short loop over an integer counter, roughly a few hundred milliseconds at the default difficulty. Send `{ challenge, solution }` as the `proof` field." +
        "\n\nA challenge expires after 10 minutes and is accepted exactly once, so fetch a fresh one per attempt.",
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      responses: {
        "200": {
          description: "Challenge issued",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/SignupChallengeResponseData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "429": tooManyRequests,
      },
    },
  },
  "/auth/accounts/validate": {
    post: {
      tags: ["Auth"],
      summary: "Check account name availability",
      operationId: "validateAccount",
      description:
        "Validates account format and returns whether the name is free (for registration). No authentication required.\n\n" +
        "**Validation rules:** 3–32 characters, only lowercase letters (`a-z`), digits (`0-9`), and underscores (`_`). Reserved words (admin, support, system, etc.) are rejected.\n\n" +
        "**Business scenarios:**\n" +
        "- `available: true` — the account handle is free and valid; safe to proceed with registration.\n" +
        "- `available: false` — already taken; prompt the user to choose a different one.\n" +
        "- `400` — the format itself is invalid (length, characters, or reserved word).",
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ValidateAccountRequest" },
            example: {
              account: "johndoe",
              proof: { challenge: "<from POST /auth/challenge>", solution: "1048576" },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Availability result",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/ValidateAccountResponseData",
                      },
                    },
                  },
                ],
              },
              examples: {
                available: {
                  summary: "Account is available",
                  value: {
                    success: true,
                    message: "Account available",
                    data: { account: "johndoe", available: true },
                  },
                },
                taken: {
                  summary: "Account already taken",
                  value: {
                    success: true,
                    message: "Account taken",
                    data: { account: "johndoe", available: false },
                  },
                },
              },
            },
          },
        },
        "400": {
          description:
            "Invalid account format (too short, invalid characters, or reserved word)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              examples: {
                tooShort: {
                  summary: "Account too short",
                  value: {
                    success: false,
                    message: "Account must be at least 3 characters",
                    errors: { account: "minLength" },
                  },
                },
                invalidChars: {
                  summary: "Invalid characters",
                  value: {
                    success: false,
                    message:
                      "Account may only contain lowercase letters, digits, and underscores",
                    errors: { account: "pattern" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  "/auth/register": {
    post: {
      tags: ["Auth"],
      summary: "Register a new account",
      operationId: "registerUser",
      description:
        "Creates an auth user, issues access/refresh tokens, and publishes a profile creation event.\n\n" +
        "**Side effects:** A `user.registered` event is published to RabbitMQ, which triggers user-service to create the user profile. The access token is immediately valid for all authenticated endpoints.\n\n" +
        "**Business scenarios:**\n" +
        "- Success (201) — user created; store both tokens; call `GET /users/profiles/me` to check `isProfileCompleted`.\n" +
        "- 400 Validation — `account` format invalid or `password` too short.\n" +
        "- 409 Conflict — the `account` handle is already taken.",
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/RegisterRequest" },
            example: {
              account: "johndoe",
              password: "Str0ng!Pass",
              fcmTokens: ["fcm_token_abc123"],
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Registration successful",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/RegisterResponseData",
                      },
                    },
                  },
                ],
              },
              example: {
                success: true,
                message: "Registration successful",
                data: {
                  user: {
                    userId: "550e8400-e29b-41d4-a716-446655440000",
                    account: "johndoe",
                    createdAt: "2026-06-25T10:00:00.000Z",
                  },
                  tokens: {
                    accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
                    refreshToken: "hOY0NnBT5NzlJuC9iWpXW16Eh1RLJY2pi...",
                    accessTokenExpiresIn: 3600,
                    refreshTokenExpiresIn: 604800,
                  },
                },
              },
            },
          },
        },
        "400": {
          description:
            "Validation failed — account format invalid or password too short",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Validation error",
                errors: { password: "Password must be at least 8 characters" },
              },
            },
          },
        },
        "409": {
          description: "Account already taken",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "This account name is already taken",
                code: "ACCOUNT_ALREADY_EXISTS",
              },
            },
          },
        },
        "502": {
          ...serviceUnavailable,
          description: "Auth service unavailable",
        },
      },
    },
  },
  "/auth/google": {
    post: {
      tags: ["Auth"],
      summary: "Sign in with Google",
      operationId: "googleSignIn",
      description:
        "Verify the Google ID token from the client's Google Sign-In flow (validated against the configured Google OAuth client id), then create or link the user and return AIMess tokens.\n\n" +
        "**Business scenarios:**\n" +
        "- `isNewUser: true` — first time; the user profile doesn't exist yet; prompt profile setup.\n" +
        "- `isNewUser: false, isProfileCompleted: false` — returning user who never finished setup.\n" +
        "- `isNewUser: false, isProfileCompleted: true` — normal returning login.\n" +
        "- 401 — the Google token is expired, revoked, or from a different client_id.\n" +
        "- 409 — the Google account email is already linked to another AIMess account.",
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/GoogleLoginRequest" },
            example: {
              idToken: "eyJhbGciOiJSUzI1NiIsImtpZCI6IjE3MTY5YzM0ZTNlMTg...",
              fcmTokens: ["fcm_token_abc123"],
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Signed in (or registered) successfully",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/SocialLoginResponseData",
                      },
                    },
                  },
                ],
              },
              examples: {
                newUser: {
                  summary: "First-time Google sign-in (new user)",
                  value: {
                    success: true,
                    message: "Signed in successfully",
                    data: {
                      isNewUser: true,
                      isProfileCompleted: false,
                      user: {
                        userId: "550e8400-e29b-41d4-a716-446655440000",
                        account: "johndoe_g",
                        email: "john@gmail.com",
                        provider: "GOOGLE",
                      },
                      tokens: {
                        accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
                        refreshToken: "hOY0NnBT5NzlJuC9iWpXW16Eh1RLJY2pi...",
                        accessTokenExpiresIn: 3600,
                        refreshTokenExpiresIn: 604800,
                      },
                    },
                  },
                },
                returningUser: {
                  summary: "Returning Google user (profile complete)",
                  value: {
                    success: true,
                    message: "Signed in successfully",
                    data: {
                      isNewUser: false,
                      isProfileCompleted: true,
                      user: {
                        userId: "550e8400-e29b-41d4-a716-446655440000",
                        account: "johndoe",
                        email: "john@gmail.com",
                        provider: "GOOGLE",
                      },
                      tokens: {
                        accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
                        refreshToken: "hOY0NnBT5NzlJuC9iWpXW16Eh1RLJY2pi...",
                        accessTokenExpiresIn: 3600,
                        refreshTokenExpiresIn: 604800,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "400": {
          description: "Validation failed — missing or malformed idToken",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: { success: false, message: "idToken is required" },
            },
          },
        },
        "401": {
          description:
            "Invalid Google token — expired, revoked, or wrong client_id",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Invalid Google ID token",
                code: "GOOGLE_TOKEN_INVALID",
              },
            },
          },
        },
        "409": {
          description: "Email already linked to a different AIMess account",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message:
                  "This Google account is already linked to another user",
                code: "SOCIAL_ACCOUNT_CONFLICT",
              },
            },
          },
        },
      },
    },
  },
  "/auth/apple": {
    post: {
      tags: ["Auth"],
      summary: "Sign in with Apple",
      operationId: "appleSignIn",
      description:
        "Verify the Apple identity token (from ASAuthorizationAppleIDCredential on iOS / Sign in with Apple JS on web) directly against Apple's JWKS, then create or link the user and return AIMess tokens.\n\n" +
        "**Apple specifics:** `email` and `fullName` are only returned by Apple on the FIRST sign-in. Subsequent sign-ins must rely on the stored email. Always pass them when available.\n\n" +
        "**Business scenarios:**\n" +
        "- Same flow as Google sign-in: `isNewUser` / `isProfileCompleted` flags guide the client's post-auth routing.\n" +
        "- 401 — identity token invalid, expired (Apple tokens expire in 10 min), or wrong app bundle ID.\n" +
        "- 409 — Apple sub already linked to another AIMess account.",
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/AppleLoginRequest" },
            example: {
              identityToken: "eyJraWQiOiJZdXlYb1kiLCJhbGciOiJSUzI1NiJ9...",
              email: "user@privaterelay.appleid.com",
              fullName: "John Doe",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Signed in (or registered) successfully",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/SocialLoginResponseData",
                      },
                    },
                  },
                ],
              },
              example: {
                success: true,
                message: "Signed in successfully",
                data: {
                  isNewUser: true,
                  isProfileCompleted: false,
                  user: {
                    userId: "660e8400-e29b-41d4-a716-446655440001",
                    account: "john_a",
                    email: "user@privaterelay.appleid.com",
                    provider: "APPLE",
                  },
                  tokens: {
                    accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
                    refreshToken: "dPQm2pTkRh3mLwX9jVpXX28Fi2SMNY4qjdsb...",
                    accessTokenExpiresIn: 3600,
                    refreshTokenExpiresIn: 604800,
                  },
                },
              },
            },
          },
        },
        "400": {
          description: "Validation failed — missing or malformed identityToken",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: { success: false, message: "identityToken is required" },
            },
          },
        },
        "401": {
          description:
            "Invalid Apple identity token — expired or wrong bundle ID",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Invalid Apple identity token",
                code: "APPLE_TOKEN_INVALID",
              },
            },
          },
        },
        "409": {
          description: "Apple account already linked to another AIMess account",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "This Apple account is already linked to another user",
                code: "SOCIAL_ACCOUNT_CONFLICT",
              },
            },
          },
        },
      },
    },
  },
  "/auth/login": {
    post: {
      tags: ["Auth"],
      summary: "Login with account or email and password",
      operationId: "loginUser",
      description:
        "Send username in `account`, or the user's verified linked email. Password is always required.\n\n" +
        "**Business scenarios:**\n" +
        "- `isProfileCompleted: false` — first login after registration; route to profile-setup screen.\n" +
        "- `isProfileCompleted: true` — normal login; route to home.\n" +
        "- 401 CREDENTIALS_INVALID — wrong password.\n" +
        "- 401 ACCOUNT_BANNED — the account has been platform-banned.\n" +
        "- 401 ACCOUNT_SUSPENDED — temporary suspension.\n" +
        "- 401 ACCOUNT_DELETED — soft-deleted (30-day grace period active)." +
        "\n\n**Refresh cookie:** the response also sets `aimess_rt`, an httpOnly, Secure, SameSite cookie scoped to `/api/v1/auth` carrying the same refresh token. Browsers should ignore `tokens.refreshToken` and let the cookie travel on its own (send the refresh request with credentials). With `rememberMe: true` the cookie is persistent (30 days); otherwise it is a session cookie that dies with the browser. Native clients have no cookie jar and keep using the body field.",
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        { $ref: "#/components/parameters/PlatformHeader" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/LoginRequest" },
            examples: {
              byUsername: {
                summary: "Login with username",
                value: {
                  account: "johndoe",
                  password: "Str0ng!Pass",
                  rememberMe: false,
                },
              },
              byEmail: {
                summary: "Login with linked email",
                value: {
                  account: "john@example.com",
                  password: "Str0ng!Pass",
                  rememberMe: true,
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Login successful",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/LoginResponseData" },
                    },
                  },
                ],
              },
              example: {
                success: true,
                message: "Login successful",
                data: {
                  tokens: {
                    accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
                    refreshToken: "hOY0NnBT5NzlJuC9iWpXW16Eh1RLJY2pi...",
                    accessTokenExpiresIn: 3600,
                    refreshTokenExpiresIn: 604800,
                  },
                  isProfileCompleted: true,
                },
              },
            },
          },
        },
        "400": {
          description: "Validation failed — missing account or password",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Validation error",
                errors: { account: "account is required" },
              },
            },
          },
        },
        "401": {
          description: "Invalid credentials or account not permitted to login",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              examples: {
                wrongPassword: {
                  summary: "Wrong password",
                  value: {
                    success: false,
                    message: "Invalid credentials",
                    code: "CREDENTIALS_INVALID",
                  },
                },
                banned: {
                  summary: "Account banned",
                  value: {
                    success: false,
                    message: "Your account has been banned",
                    code: "ACCOUNT_BANNED",
                  },
                },
                deleted: {
                  summary: "Account pending deletion",
                  value: {
                    success: false,
                    message: "This account has been deleted",
                    code: "ACCOUNT_DELETED",
                  },
                },
              },
            },
          },
        },
        "502": {
          ...serviceUnavailable,
          description: "Auth service unavailable",
        },
      },
    },
  },
  "/auth/refresh": {
    post: {
      tags: ["Auth"],
      summary: "Refresh access token",
      operationId: "refreshAccessToken",
      description:
        "Exchange a valid refresh token for a new access/refresh token pair. The old refresh token is invalidated (rotation). If a revoked refresh token is reused, all sessions for that user are revoked.\n\n" +
        "**Security note:** Reuse of a revoked refresh token triggers a full session revocation (security event). The client must detect this and re-authenticate." +
        "\n\n**Cookie callers:** send an empty body with credentials and the httpOnly `aimess_rt` cookie is used. The rotated token is written back as a new `aimess_rt`; on 401 the cookie is cleared, since an httpOnly cookie cannot be dropped by the browser itself.",
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/RefreshTokenRequest" },
            example: {
              refreshToken:
                "hOY0NnBT5NzlJuC9iWpXW16Eh1RLJY2piemrzYfPh7VeMeSJm9sr_IiNilQb7PI6",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "New token pair issued — old refresh token invalidated",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/LoginResponseData" },
                    },
                  },
                ],
              },
              example: {
                success: true,
                message: "Token refreshed",
                data: {
                  tokens: {
                    accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
                    refreshToken: "newRefreshToken_abc123...",
                    accessTokenExpiresIn: 3600,
                    refreshTokenExpiresIn: 604800,
                  },
                  isProfileCompleted: true,
                },
              },
            },
          },
        },
        "400": {
          description: "Validation failed — missing refreshToken field",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: { success: false, message: "refreshToken is required" },
            },
          },
        },
        "401": {
          description: "Invalid or expired refresh token",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              examples: {
                expired: {
                  summary: "Token expired",
                  value: {
                    success: false,
                    message: "Refresh token expired",
                    code: "TOKEN_EXPIRED",
                  },
                },
                revoked: {
                  summary: "Token reused (session revocation triggered)",
                  value: {
                    success: false,
                    message: "Refresh token has been revoked",
                    code: "TOKEN_REVOKED",
                  },
                },
              },
            },
          },
        },
        "502": {
          ...serviceUnavailable,
          description: "Auth service unavailable",
        },
      },
    },
  },
  "/auth/token": {
    post: {
      tags: ["Auth"],
      summary: "Get a new access token (silent renewal)",
      operationId: "getAccessToken",
      description:
        "Issues a fresh access token using a valid refresh token. The refresh token is **not** rotated — use this for silent access-token renewal without disturbing the refresh token. Use `POST /auth/refresh` when you also want to rotate the refresh token.",
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/RefreshTokenRequest" },
            example: {
              refreshToken: "hOY0NnBT5NzlJuC9iWpXW16Eh1RLJY2piemrzYfPh7Ve...",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "New access token issued (refresh token unchanged)",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/AccessTokenResponseData",
                      },
                    },
                  },
                ],
              },
              example: {
                success: true,
                message: "Access token issued",
                data: {
                  accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
                  accessTokenExpiresIn: 900,
                },
              },
            },
          },
        },
        "400": {
          description: "Validation failed",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: { success: false, message: "refreshToken is required" },
            },
          },
        },
        "401": {
          description: "Invalid or expired refresh token",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Refresh token expired",
                code: "TOKEN_EXPIRED",
              },
            },
          },
        },
        "502": {
          ...serviceUnavailable,
          description: "Auth service unavailable",
        },
      },
    },
  },
  "/auth/logout": {
    post: {
      tags: ["Auth"],
      summary: "Sign out",
      operationId: "logoutUser",
      description:
        "Revokes the current session and its refresh tokens. Requires a valid (non-expired) access token.\n\n" +
        "After logout, the access token is still technically valid until it naturally expires, but the session is marked ENDED on the server. The refresh token cannot be used to generate new access tokens.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      responses: {
        "200": {
          description: "Signed out successfully",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
              example: { success: true, message: "Signed out successfully" },
            },
          },
        },
        "401": {
          description: "Missing or invalid access token",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: { success: false, message: "Unauthorized" },
            },
          },
        },
        "502": {
          ...serviceUnavailable,
          description: "Auth service unavailable",
        },
      },
    },
  },
  "/auth/sessions": {
    get: {
      tags: ["Auth"],
      summary: "List active sessions (devices)",
      operationId: "listUserSessions",
      description:
        "Returns **all** active devices/sessions for the user. The current device is marked `isCurrent: true`. Revoke one device with DELETE /sessions/{sessionId}, or all other devices with POST /sessions/revoke-all.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      responses: {
        "200": {
          description: "Active sessions list",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/ListSessionsResponseData",
                      },
                    },
                  },
                ],
              },
              example: {
                success: true,
                message: "Sessions retrieved",
                data: {
                  sessions: [
                    {
                      sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
                      deviceId: "device-pixel8-001",
                      deviceName: "Pixel 8 — Hanoi",
                      deviceType: "ANDROID",
                      osVersion: "14",
                      appVersion: "1.2.3",
                      ipAddress: "203.0.113.1",
                      countryCode: "VN",
                      lastActiveAt: "2026-06-25T09:00:00.000Z",
                      createdAt: "2026-06-20T08:00:00.000Z",
                      isCurrent: true,
                    },
                    {
                      sessionId: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
                      deviceId: "device-iphone15-001",
                      deviceName: "iPhone 15 Pro",
                      deviceType: "IOS",
                      osVersion: "17",
                      appVersion: "1.2.3",
                      ipAddress: "198.51.100.5",
                      countryCode: "US",
                      lastActiveAt: "2026-06-24T20:00:00.000Z",
                      createdAt: "2026-06-01T10:00:00.000Z",
                      isCurrent: false,
                    },
                  ],
                },
              },
            },
          },
        },
        "401": unauthorized,
        "502": {
          ...serviceUnavailable,
          description: "Auth service unavailable",
        },
      },
    },
  },
  "/auth/sessions/revoke-all": {
    post: {
      tags: ["Auth"],
      summary: "Sign out from all other devices",
      operationId: "revokeAllSessions",
      description:
        "Revokes every active session EXCEPT the caller's current one (the device making this call stays signed in). `revokedCount` is the number of other devices signed out.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      responses: {
        "200": {
          description: "All other sessions revoked",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/RevokeSessionsResponseData",
                      },
                    },
                  },
                ],
              },
              example: {
                success: true,
                message: "Signed out from all other devices",
                data: { revokedCount: 2 },
              },
            },
          },
        },
        "401": unauthorized,
      },
    },
  },
  "/auth/sessions/{sessionId}": {
    delete: {
      tags: ["Auth"],
      summary: "Revoke one device",
      operationId: "revokeSession",
      description:
        "Revokes the given session and its refresh tokens. Pass any `sessionId` from GET /sessions (including the row with `isCurrent: true` to sign out only this device).",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "sessionId",
          in: "path",
          required: true,
          description: "Session ID (sessionId) from GET /auth/sessions.",
          schema: { type: "string", format: "uuid" },
          example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        },
      ],
      responses: {
        "200": {
          description: "Session revoked successfully",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
              example: { success: true, message: "Session revoked" },
            },
          },
        },
        "401": unauthorized,
        "404": {
          description: "Session not found or already ended",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Session not found or already ended",
                code: "SESSION_NOT_FOUND",
              },
            },
          },
        },
        "502": {
          ...serviceUnavailable,
          description: "Auth service unavailable",
        },
      },
    },
  },
  "/auth/sessions/{sessionId}/trust": {
    post: {
      tags: ["Auth"],
      summary: "Trust this login (It's Me)",
      operationId: "trustSession",
      description:
        'Confirms a new/suspicious login detection for the given session ("It\'s Me"). Marks the related login-detected notification as TRUSTED. The session stays active — this is not a revoke. Pass any `sessionId` from GET /auth/sessions that belongs to the caller.',
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "sessionId",
          in: "path",
          required: true,
          description: "Session ID (sessionId) from GET /auth/sessions.",
          schema: { type: "string", format: "uuid" },
          example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        },
      ],
      responses: {
        "200": {
          description: "Session trusted (`data` is null).",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
              example: {
                success: true,
                message: "Session trusted",
                data: null,
              },
            },
          },
        },
        "401": unauthorized,
        "404": {
          description: "Session not found or not owned by the caller",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Session not found",
                code: "SESSION_NOT_FOUND",
              },
            },
          },
        },
        "502": {
          ...serviceUnavailable,
          description: "Auth service unavailable",
        },
      },
    },
  },
  "/auth/forgot-password/request": {
    post: {
      tags: ["Auth"],
      summary: "Request password reset OTP",
      operationId: "requestPasswordReset",
      description:
        "Sends a 6-digit OTP to the email if an account exists. In development, OTP is logged to the auth-service console (fixed code via OTP_DEV_FIXED_CODE).\n\n" +
        "**Security:** The response is identical whether or not an account exists for the email. This prevents account enumeration attacks.\n\n" +
        "**Rate limiting:** Maximum 5 OTP requests per 15 minutes per email address.",
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ForgotPasswordRequest" },
            example: { email: "john@example.com" },
          },
        },
      },
      responses: {
        "200": {
          description:
            "Generic success response (identical whether or not account exists — prevents account enumeration)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
              example: {
                success: true,
                message:
                  "If an account exists for that email, a reset code has been sent.",
              },
            },
          },
        },
        "400": {
          description: "Invalid email format",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Validation error",
                errors: { email: "Must be a valid email address" },
              },
            },
          },
        },
        "429": tooManyRequests,
      },
    },
  },
  "/auth/forgot-password/verify": {
    post: {
      tags: ["Auth"],
      summary: "Verify password reset OTP",
      operationId: "verifyPasswordResetOtp",
      description:
        "Verifies the 6-digit OTP sent to the email. Returns a short-lived `resetToken` to use in the next step.\n\n" +
        "**Business rules:**\n" +
        "- OTP expires after 10 minutes.\n" +
        "- Maximum 5 failed attempts; the OTP is invalidated after the limit.",
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/ForgotPasswordVerifyRequest",
            },
            example: {
              email: "john@example.com",
              code: "482915",
            },
          },
        },
      },
      responses: {
        "200": {
          description:
            "OTP verified — use the returned `resetToken` in POST /auth/forgot-password/reset",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/ForgotPasswordVerifyResponseData",
                      },
                    },
                  },
                ],
              },
              example: {
                success: true,
                message: "OTP verified",
                data: {
                  resetToken: "rst_3f9c1a2b8d4e7f0a6b5c9d2e...",
                  resetTokenExpiresIn: 600,
                },
              },
            },
          },
        },
        "400": {
          description: "Validation failed or max OTP attempts exceeded",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              examples: {
                validation: {
                  summary: "Missing or malformed code",
                  value: {
                    success: false,
                    message: "code must be a 6-digit number",
                  },
                },
                maxAttempts: {
                  summary: "Too many wrong attempts",
                  value: {
                    success: false,
                    message:
                      "Maximum OTP attempts exceeded. Request a new code.",
                    code: "OTP_MAX_ATTEMPTS",
                  },
                },
              },
            },
          },
        },
        "401": {
          description: "Invalid or expired OTP",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Invalid or expired OTP",
                code: "OTP_INVALID",
              },
            },
          },
        },
        "429": tooManyRequests,
      },
    },
  },
  "/auth/forgot-password/reset": {
    post: {
      tags: ["Auth"],
      summary: "Set new password after OTP verification",
      operationId: "resetPassword",
      description:
        "Sets a new password using the `resetToken` obtained from POST /auth/forgot-password/verify. The reset token is single-use and expires after 10 minutes.\n\n" +
        "**Side effect:** All existing sessions for the account are revoked after a successful password reset.",
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/ForgotPasswordResetRequest",
            },
            example: {
              email: "john@example.com",
              resetToken: "rst_3f9c1a2b8d4e7f0a6b5c9d2e...",
              newPassword: "N3w$trongPass!",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Password updated — all existing sessions revoked",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
              example: {
                success: true,
                message:
                  "Password reset successful. Please log in with your new password.",
              },
            },
          },
        },
        "400": {
          description:
            "Validation failed or new password is the same as the current one",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              examples: {
                weakPassword: {
                  summary: "Password too weak",
                  value: {
                    success: false,
                    message: "Password must be at least 8 characters",
                  },
                },
                samePassword: {
                  summary: "Same as current",
                  value: {
                    success: false,
                    message:
                      "New password must be different from the current password",
                    code: "PASSWORD_SAME",
                  },
                },
              },
            },
          },
        },
        "401": {
          description: "Invalid or expired reset token",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Reset token is invalid or has expired",
                code: "RESET_TOKEN_INVALID",
              },
            },
          },
        },
      },
    },
  },
  "/auth/link-email/request": {
    post: {
      tags: ["Auth"],
      summary: "Request OTP to link email",
      operationId: "requestEmailLink",
      description:
        "Requires access token. Sends OTP to the given email (logged in dev console until email delivery is configured).\n\n" +
        "**Use case:** Social-only accounts (Google/Apple) that don't have an email address want to link one so they can also log in with password.\n\n" +
        "**Rate limiting:** Maximum 5 OTP requests per 15 minutes.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/LinkEmailRequest" },
            example: { email: "john@example.com" },
          },
        },
      },
      responses: {
        "200": {
          description: "OTP sent to the specified email",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
              example: { success: true, message: "Verification code sent" },
            },
          },
        },
        "400": {
          description:
            "Validation failed or email already linked to this account",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              examples: {
                alreadyLinked: {
                  summary: "Email already linked",
                  value: {
                    success: false,
                    message: "An email is already linked to this account",
                    code: "EMAIL_ALREADY_LINKED",
                  },
                },
                invalid: {
                  summary: "Invalid email",
                  value: {
                    success: false,
                    message: "Must be a valid email address",
                  },
                },
              },
            },
          },
        },
        "401": unauthorized,
        "409": {
          description: "Email address already used by another account",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message:
                  "This email is already associated with another account",
                code: "EMAIL_CONFLICT",
              },
            },
          },
        },
        "429": tooManyRequests,
      },
    },
  },
  "/auth/link-email/verify": {
    post: {
      tags: ["Auth"],
      summary: "Verify OTP and link email",
      operationId: "verifyEmailLink",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/LinkEmailVerifyRequest" },
            example: {
              email: "john@example.com",
              code: "391842",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Email linked and verified",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/LinkEmailResponseData",
                      },
                    },
                  },
                ],
              },
              example: {
                success: true,
                message: "Email linked successfully",
                data: {
                  userId: "550e8400-e29b-41d4-a716-446655440000",
                  emailVerified: true,
                  primaryAccount: "EMAIL",
                },
              },
            },
          },
        },
        "400": {
          description: "Validation failed or max OTP attempts exceeded",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Maximum verification attempts exceeded",
              },
            },
          },
        },
        "401": {
          description: "Invalid or expired OTP / missing access token",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Invalid or expired verification code",
                code: "OTP_INVALID",
              },
            },
          },
        },
        "409": {
          description: "Email already used by another account",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Email already used by another account",
                code: "EMAIL_CONFLICT",
              },
            },
          },
        },
      },
    },
  },
  "/auth/change-email/request": {
    post: {
      tags: ["Auth"],
      summary: "Request OTP to change email",
      operationId: "requestEmailChange",
      description:
        "Requires access token. Validates the current email, then sends an OTP to the new email address.\n\n" +
        "**Rate limiting:** Maximum 5 OTP requests per 15 minutes.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ChangeEmailRequest" },
            example: {
              oldEmail: "john@example.com",
              newEmail: "john.new@example.com",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "OTP sent to the new email address",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
              example: {
                success: true,
                message: "Verification code sent to new email",
              },
            },
          },
        },
        "400": {
          description:
            "Validation failed or `oldEmail` does not match the account",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Current email does not match the account",
                code: "EMAIL_MISMATCH",
              },
            },
          },
        },
        "401": unauthorized,
        "409": {
          description: "New email already in use by another account",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Email already in use",
                code: "EMAIL_CONFLICT",
              },
            },
          },
        },
        "429": tooManyRequests,
      },
    },
  },
  "/auth/change-email/verify": {
    post: {
      tags: ["Auth"],
      summary: "Verify OTP and change email",
      operationId: "verifyEmailChange",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ChangeEmailVerifyRequest" },
            example: {
              oldEmail: "john@example.com",
              newEmail: "john.new@example.com",
              code: "182734",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Email changed successfully",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/ChangeEmailResponseData",
                      },
                    },
                  },
                ],
              },
              example: {
                success: true,
                message: "Email changed successfully",
                data: {
                  userId: "550e8400-e29b-41d4-a716-446655440000",
                  emailVerified: true,
                },
              },
            },
          },
        },
        "400": {
          description: "Validation failed or max OTP attempts exceeded",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Maximum verification attempts exceeded",
              },
            },
          },
        },
        "401": {
          description: "Invalid or expired OTP",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Invalid or expired verification code",
                code: "OTP_INVALID",
              },
            },
          },
        },
        "409": {
          description: "New email already in use",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Email already in use",
                code: "EMAIL_CONFLICT",
              },
            },
          },
        },
      },
    },
  },
  "/auth/change-password": {
    post: {
      tags: ["Auth"],
      summary: "Change password",
      operationId: "changePassword",
      description:
        "Requires access token and current password. Revokes all other sessions (except current) after a successful change.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ChangePasswordRequest" },
            example: {
              currentPassword: "OldPass123!",
              newPassword: "N3wStr0ng!Pass",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Password changed — all other sessions revoked",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
              example: {
                success: true,
                message: "Password changed successfully",
              },
            },
          },
        },
        "400": {
          description:
            "Validation failed, wrong current password, or new password same as current",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              examples: {
                wrongPassword: {
                  summary: "Wrong current password",
                  value: {
                    success: false,
                    message: "Current password is incorrect.",
                    code: "PASSWORD_INCORRECT",
                  },
                },
                samePassword: {
                  summary: "Same password",
                  value: {
                    success: false,
                    message:
                      "New password must be different from the current password",
                    code: "PASSWORD_SAME",
                  },
                },
                tooShort: {
                  summary: "New password too short",
                  value: {
                    success: false,
                    message: "Password must be at least 8 characters",
                  },
                },
              },
            },
          },
        },
        "401": {
          description: "Missing/invalid/expired token, or account not active",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              examples: {
                noToken: {
                  summary: "Missing token",
                  value: { success: false, message: "Unauthorized" },
                },
              },
            },
          },
        },
      },
    },
  },
  "/auth/social/google/link": {
    post: {
      tags: ["Auth"],
      summary: "Link Google to account",
      operationId: "linkGoogleAccount",
      description:
        "Links a Google account to the authenticated user. The Google ID token is verified server-side. Once linked, the user can sign in with Google.\n\n" +
        "**Business rules:**\n" +
        "- Cannot link if Google is already linked to this account (400).\n" +
        "- Cannot link if the Google sub is already linked to a different AIMess account (409).",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/LinkGoogleRequest" },
            example: {
              idToken: "eyJhbGciOiJSUzI1NiIsImtpZCI6IjE3MTY5YzM0ZTNlMTg...",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Google account linked",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/SocialLinkResponseData",
                      },
                    },
                  },
                ],
              },
              example: {
                success: true,
                message: "Google account linked",
                data: { provider: "GOOGLE", primaryAccount: "GOOGLE" },
              },
            },
          },
        },
        "400": {
          description: "Google already linked to this account",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Google is already linked to your account",
                code: "SOCIAL_ALREADY_LINKED",
              },
            },
          },
        },
        "401": {
          description: "Unauthorized or invalid Google token",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Invalid Google ID token",
                code: "GOOGLE_TOKEN_INVALID",
              },
            },
          },
        },
        "409": {
          description: "Google account already linked to another AIMess user",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message:
                  "This Google account is already linked to another user",
                code: "SOCIAL_ACCOUNT_CONFLICT",
              },
            },
          },
        },
      },
    },
  },
  "/auth/social/apple/link": {
    post: {
      tags: ["Auth"],
      summary: "Link Apple to account",
      operationId: "linkAppleAccount",
      description:
        "Links an Apple account to the authenticated user. The Apple identity token is verified directly against Apple's JWKS.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/LinkAppleRequest" },
            example: {
              identityToken: "eyJraWQiOiJZdXlYb1kiLCJhbGciOiJSUzI1NiJ9...",
              email: "user@privaterelay.appleid.com",
              fullName: "John Doe",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Apple account linked",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/SocialLinkResponseData",
                      },
                    },
                  },
                ],
              },
              example: {
                success: true,
                message: "Apple account linked",
                data: { provider: "APPLE", primaryAccount: "EMAIL" },
              },
            },
          },
        },
        "400": {
          description: "Apple already linked to this account",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Apple is already linked to your account",
                code: "SOCIAL_ALREADY_LINKED",
              },
            },
          },
        },
        "401": {
          description: "Unauthorized or invalid Apple identity token",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Invalid Apple identity token",
                code: "APPLE_TOKEN_INVALID",
              },
            },
          },
        },
        "409": {
          description: "Apple account already linked to another AIMess user",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "This Apple account is already linked to another user",
                code: "SOCIAL_ACCOUNT_CONFLICT",
              },
            },
          },
        },
      },
    },
  },
  "/auth/social/unlink": {
    post: {
      tags: ["Auth"],
      summary: "Unlink Google or Apple",
      operationId: "unlinkSocialAccount",
      description:
        "Cannot unlink if it would leave the account with no sign-in method (password or another provider).\n\n" +
        "**Business rule:** If the account has only one sign-in method (e.g., Google only, no password), unlinking it would lock the user out permanently. The backend rejects this with 400 `LAST_SIGNIN_METHOD`.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/UnlinkSocialRequest" },
            example: { provider: "GOOGLE" },
          },
        },
      },
      responses: {
        "200": {
          description: "Provider unlinked",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/SocialUnlinkResponseData",
                      },
                    },
                  },
                ],
              },
              example: {
                success: true,
                message: "Google account unlinked",
                data: { provider: "GOOGLE" },
              },
            },
          },
        },
        "400": {
          description:
            "Provider not linked, or unlinking would remove last sign-in method",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              examples: {
                notLinked: {
                  summary: "Provider not linked",
                  value: {
                    success: false,
                    message: "Google is not linked to your account",
                    code: "SOCIAL_NOT_LINKED",
                  },
                },
                lastMethod: {
                  summary: "Last sign-in method",
                  value: {
                    success: false,
                    message:
                      "Cannot unlink your only sign-in method. Add a password or link another provider first.",
                    code: "LAST_SIGNIN_METHOD",
                  },
                },
              },
            },
          },
        },
        "401": unauthorized,
      },
    },
  },
  "/auth/devices/link/initiate": {
    post: {
      tags: ["Auth"],
      summary: "Start a QR device-link session",
      operationId: "initiateDeviceLink",
      description:
        "Called by a new, unauthenticated device (web/desktop). Returns a `linkToken`; the session expires in 60s.\n\n" +
        "**Client responsibilities (QR is entirely client-side — the backend never generates or scans it):**\n" +
        "- Encode **only the `linkToken`** into the QR (e.g. as `aimess://login?token=<linkToken>`).\n" +
        "- Connect to Socket.IO namespace `/auth` and emit `auth:qr:subscribe` with `{ token: linkToken }` to receive `auth:qr:success` / `auth:qr:expired` / `auth:qr:cancelled` / `auth:qr:failed` in real time. There is no polling endpoint.\n" +
        '- **Session replacement (WhatsApp-like):** Generating a new QR from the same browser/device automatically supersedes any prior pending session. The old tab receives an `auth:qr:cancelled` event (with `{ reason: "replaced" }`) so it can immediately subscribe to the new token. This prevents stale session accumulation and the "Too many QR sessions" error.\n' +
        "- When the 60s TTL lapses, regenerate by calling this endpoint again and refresh the QR.\n\n" +
        "**Telegram-style instant login:** the already-signed-in mobile device scans the QR and immediately calls `POST /auth/devices/link/scan` with its own access token — that single call validates the QR, mints a brand-new web session, and logs the browser in. There is no separate approve/reject step and no confirmation screen.",
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/DeviceLinkInitiateRequest" },
            example: {
              deviceId: "web-browser-abc123",
              deviceType: "WEB",
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Link session created — display QR with `linkToken`",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/DeviceLinkInitiateResponseData",
                      },
                    },
                  },
                ],
              },
              example: {
                success: true,
                message:
                  "Device linking initiated. Please approve on your existing device.",
                data: {
                  linkToken: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
                  expiresAt: "2026-07-14T10:31:00.000Z",
                },
              },
            },
          },
        },
      },
    },
  },
  "/auth/devices/link/scan": {
    post: {
      tags: ["Auth"],
      summary: "Scan a QR device-link — instant login (Telegram-style)",
      operationId: "scanDeviceLink",
      description:
        "Called by the already-signed-in mobile device right after scanning the QR. A single call: validates the QR (exists, `PENDING`, not expired), atomically claims it, mints a brand-new web session/tokens via the same token-issuance path as password/social login, marks the QR `USED`, and pushes `auth:qr:success` (with the tokens) to the browser's `/auth` socket room `qr:{linkToken}`. There is no separate approve/reject step and no confirmation screen — the response IS the login result.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/DeviceLinkScanRequest" },
            example: { linkToken: "3fa85f64-5717-4562-b3fc-2c963f66afa6" },
          },
        },
      },
      responses: {
        "200": {
          description:
            "Device linked and the browser logged in — tokens are also pushed via `auth:qr:success`",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/DeviceLinkScanResponseData",
                      },
                    },
                  },
                ],
              },
              example: {
                success: true,
                message: "Device linked successfully.",
                data: {
                  sessionId: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
                  linkedAt: "2026-06-25T10:30:00.000Z",
                  accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
                  refreshToken: "newDeviceRefreshToken...",
                  accessTokenExpiresIn: 3600,
                  refreshTokenExpiresIn: 604800,
                },
              },
            },
          },
        },
        "401": unauthorized,
        "404": {
          description: "Link session not found or expired",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "This QR code has expired.",
              },
            },
          },
        },
        "409": {
          description: "QR already used/claimed (single-use)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "This QR code has already been scanned.",
              },
            },
          },
        },
        "429": tooManyRequests,
      },
    },
  },
  "/auth/account": {
    delete: {
      tags: ["Auth"],
      summary: "Delete my account (soft delete)",
      operationId: "deleteAccount",
      description:
        "Soft-deletes the authenticated user's account: marks it PENDING_DELETION with a 30-day grace window, revokes all sessions/refresh tokens, and emits a user.deleted event. Afterwards neither password login nor any linked Google/Apple provider can authenticate. Password confirmation is required ONLY when the account has a password; social-only accounts may omit it.\n\n" +
        "**Business rules:**\n" +
        "- 30-day grace window: the account is not immediately destroyed; a future reactivation flow can restore it.\n" +
        "- All FCM device tokens are unregistered.\n" +
        "- **Soft delete only — no row is ever removed.** The AuthUser is marked, its sessions and refresh tokens are revoked in place, linked Google/Apple rows are KEPT, and the profile is soft-deleted in user-service. The whole operation is reversible for the length of the grace period. Nothing in the codebase hard-purges the account: `scheduledDeletionAt` is recorded but no job currently reads it.\n" +
        "- Linked Google/Apple rows are retained, so social sign-in still cannot get in (social-auth.service rejects on `deletedAt`/`status`), but that provider `sub` stays reserved by this account and cannot be linked to a different account while the deletion stands. AIMess stores no provider access/refresh tokens (only `sub`/email/displayName), so there is nothing to revoke with the provider.\n" +
        "- Every still-connected socket is force-disconnected immediately (same `session-revoke` signal as 'Logout Device'); other devices do not wait for token expiry.\n" +
        "- Deletion is **silent**: no notification of any kind is created, pushed, or emitted — not for the deleting user and not for anyone else. Devices are dropped without an `auth:session_terminated` notice or a `session:list_updated` event. The 200 response is the ONLY feedback; show a local toast and redirect, do not wait on the notification stream.\n" +
        "- **No per-user rate limit.** The 5-attempts/hour limiter was removed on 2026-08-12 because it locked users out of their own delete dialog; this endpoint no longer returns `429` and emits no `RateLimit` headers. In production the gateway's global per-IP limiter is the only throttle in front of it (and that one is skipped when `NODE_ENV=development`).\n" +
        "- `400 AUTH_PASSWORD_REQUIRED` — the account has a password hash but `password` is absent OR an empty string. Both cases return the identical localized message, so the client can render one in-modal error.\n" +
        "- `400 AUTH_PASSWORD_INCORRECT` — wrong password supplied. Deliberately **400, never 401**: the caller's session is valid, only the password they typed into the confirmation dialog was wrong. A 401 makes a standard refresh-on-401 interceptor treat the session as expired, silently replay this DELETE, and sign the user out on the second failure — a mistyped password must surface an error, not a logout. `401` on this endpoint means only what it always means: the access token itself is missing, expired, or revoked.\n" +
        "- Status summary: **missing password** `400`, **incorrect password** `400`, **bad/absent access token** `401`. The response body carries only `{ success, message }` (already localized via `x-lang`) and no error `code`; distinguish the two 400s by `message` if you must, though both should render in the same place in the dialog.\n" +
        "- The client should keep its confirmation modal OPEN on `400` and render `message` inside it; only `200` should dismiss the modal and redirect.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                password: {
                  type: "string",
                  description:
                    "Current account password. Required (400 AUTH_PASSWORD_REQUIRED) when the account has a password; an incorrect value returns 400 AUTH_PASSWORD_INCORRECT (400, not 401 — see the endpoint description). Omit for social-only accounts (no passwordHash). No `minLength` on purpose — an empty string is accepted by the schema and answered by the same 400 as an absent field, rather than a differently-shaped validation error.",
                },
              },
            },
            examples: {
              withPassword: {
                summary: "Account with password",
                value: { password: "MyCurrentPass123!" },
              },
              socialOnly: {
                summary: "Social-only account (no password)",
                value: {},
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Account soft-deleted — 30-day grace window started",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/DeleteAccountResponseData",
                      },
                    },
                  },
                ],
              },
              example: {
                success: true,
                message: "Account scheduled for deletion",
                data: {
                  deletedAt: "2026-06-25T10:00:00.000Z",
                  permanentDeletionDate: "2026-07-25T10:00:00.000Z",
                },
              },
            },
          },
        },
        "400": {
          description:
            "Password missing, or password incorrect. Both keep the session alive — render the message in the confirmation dialog and leave it open.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              examples: {
                passwordRequired: {
                  summary:
                    "Password omitted (or empty) on an account that has one",
                  value: {
                    success: false,
                    message: "Password is required to confirm this action.",
                  },
                },
                wrongPassword: {
                  summary:
                    "Wrong password — NOT a 401, so no token refresh/logout",
                  value: {
                    success: false,
                    message: "The password you entered is incorrect.",
                  },
                },
              },
            },
          },
        },
        "401": {
          description:
            "Missing, expired or revoked access token. NEVER returned for a wrong password — see the 400 above.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: { success: false, message: "Unauthorized" },
            },
          },
        },
      },
    },
  },
} as const;
