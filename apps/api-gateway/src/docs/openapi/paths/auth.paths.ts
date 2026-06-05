/** Paths are relative to server URL `…/api/v1` (see openapi-document). */
export const authPaths = {
  "/auth/accounts/validate": {
    post: {
      tags: ["Auth"],
      summary: "Check account name availability",
      description:
        "Validates account format and returns whether the name is free (for registration). No authentication required.",
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ValidateAccountRequest" },
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
            },
          },
        },
        "400": {
          description: "Invalid account format",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
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
      description:
        "Creates an auth user, issues access/refresh tokens, and publishes a profile creation event.",
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/RegisterRequest" },
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
            },
          },
        },
        "400": {
          description: "Validation failed",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "409": {
          description: "Email or account already exists",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "502": {
          description: "Auth service unavailable",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/auth/google": {
    post: {
      tags: ["Auth"],
      summary: "Sign in with Google",
      description:
        "Verify the Google ID token from the client's Google Sign-In flow (validated against the configured Google OAuth client id), then create or link the user and return AIMess tokens.",
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/GoogleLoginRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Signed in",
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
            },
          },
        },
        "400": {
          description: "Validation failed",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": {
          description: "Invalid Google token",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "409": {
          description: "Email required (first-time Apple) or conflict",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
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
      description:
        "Verify the Apple identity token (from ASAuthorizationAppleIDCredential on iOS / Sign in with Apple JS on web) directly against Apple's JWKS, then create or link the user and return AIMess tokens.",
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/AppleLoginRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Signed in",
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
            },
          },
        },
        "400": {
          description: "Validation failed",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": {
          description: "Invalid Apple token",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "409": {
          description: "Email required for first-time sign-in",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
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
      description:
        "Send username in `account`, or the user's verified linked email. Password is always required.",
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/LoginRequest" },
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
            },
          },
        },
        "400": {
          description: "Validation failed",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": {
          description: "Invalid credentials or account not allowed to login",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "502": {
          description: "Auth service unavailable",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/auth/refresh": {
    post: {
      tags: ["Auth"],
      summary: "Refresh access token",
      description:
        "Exchange a valid refresh token for a new access/refresh token pair. The old refresh token is invalidated (rotation). If a revoked refresh token is reused, all sessions for that user are revoked.",
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/RefreshTokenRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "New tokens issued",
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
            },
          },
        },
        "400": {
          description: "Validation failed",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": {
          description: "Invalid or expired refresh token",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "502": {
          description: "Auth service unavailable",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/auth/token": {
    post: {
      tags: ["Auth"],
      summary: "Get a new access token",
      description:
        "Issues a fresh access token using a valid refresh token. The refresh token is **not** rotated — use this for silent access-token renewal. Use `POST /auth/refresh` when you also want to rotate the refresh token.",
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/RefreshTokenRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "New access token issued",
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
            },
          },
        },
        "400": {
          description: "Validation failed",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": {
          description: "Invalid or expired refresh token",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "502": {
          description: "Auth service unavailable",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/auth/logout": {
    post: {
      tags: ["Auth"],
      summary: "Sign out",
      description:
        "Revokes the current session and its refresh tokens. Requires a valid (non-expired) access token.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      responses: {
        "200": {
          description: "Signed out",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
            },
          },
        },
        "401": {
          description: "Missing or invalid access token",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "502": {
          description: "Auth service unavailable",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/auth/sessions": {
    get: {
      tags: ["Auth"],
      summary: "List active sessions (devices)",
      description:
        "Returns **all** active devices/sessions for the user. The current device is marked `isCurrent: true`. Revoke one device with DELETE /sessions/{sessionId}, or all other devices with POST /sessions/revoke-all.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      responses: {
        "200": {
          description: "Active sessions",
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
            },
          },
        },
        "401": {
          description: "Missing or invalid access token",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "502": {
          description: "Auth service unavailable",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/auth/sessions/revoke-all": {
    post: {
      tags: ["Auth"],
      summary: "Sign out from all other devices",
      description:
        "Revokes every active session EXCEPT the caller's current one (the device making this call stays signed in). `revokedCount` is the number of other devices signed out.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      responses: {
        "200": {
          description: "All sessions revoked",
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
            },
          },
        },
        "401": {
          description: "Missing or invalid access token",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/auth/sessions/{sessionId}": {
    delete: {
      tags: ["Auth"],
      summary: "Revoke one device",
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
        },
      ],
      responses: {
        "200": {
          description: "Session revoked",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
            },
          },
        },
        "401": {
          description: "Missing or invalid access token",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Session not found or already ended",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "502": {
          description: "Auth service unavailable",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/auth/forgot-password/request": {
    post: {
      tags: ["Auth"],
      summary: "Request password reset OTP",
      description:
        "Sends a 6-digit OTP to the email if an account exists. In development, OTP is logged to the auth-service console (fixed code via OTP_DEV_FIXED_CODE).",
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ForgotPasswordRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Generic success (does not reveal whether email exists)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
            },
          },
        },
        "400": {
          description: "Validation failed",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/auth/forgot-password/verify": {
    post: {
      tags: ["Auth"],
      summary: "Verify password reset OTP",
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/ForgotPasswordVerifyRequest",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "OTP verified; use resetToken in the reset step",
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
            },
          },
        },
        "400": {
          description: "Validation failed or max OTP attempts",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": {
          description: "Invalid or expired OTP",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/auth/forgot-password/reset": {
    post: {
      tags: ["Auth"],
      summary: "Set new password after OTP verification",
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/ForgotPasswordResetRequest",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Password updated; existing sessions are revoked",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
            },
          },
        },
        "400": {
          description:
            "Validation failed or new password matches current password",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": {
          description: "Invalid or expired reset token",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
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
      description:
        "Requires access token. Sends OTP to the given email (logged in dev console until email delivery is configured).",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/LinkEmailRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "OTP sent",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
            },
          },
        },
        "400": {
          description: "Validation failed or email already linked",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": {
          description: "Unauthorized",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "409": {
          description: "Email already used by another account",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/auth/link-email/verify": {
    post: {
      tags: ["Auth"],
      summary: "Verify OTP and link email",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/LinkEmailVerifyRequest" },
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
            },
          },
        },
        "400": {
          description: "Validation failed or max OTP attempts",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": {
          description: "Invalid or expired OTP",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "409": {
          description: "Email already used by another account",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
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
      description:
        "Requires access token. Validates current email, then sends OTP to the new email.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ChangeEmailRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "OTP sent to new email",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
            },
          },
        },
        "400": {
          description: "Validation failed or email mismatch",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": {
          description: "Unauthorized",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "409": {
          description: "New email already in use",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/auth/change-email/verify": {
    post: {
      tags: ["Auth"],
      summary: "Verify OTP and change email",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ChangeEmailVerifyRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Email changed",
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
            },
          },
        },
        "400": {
          description: "Validation failed or max OTP attempts",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": {
          description: "Invalid or expired OTP",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "409": {
          description: "New email already in use",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
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
      description:
        "Requires access token and current password. Revokes other sessions after a successful change.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ChangePasswordRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Password changed",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
            },
          },
        },
        "400": {
          description: "Validation failed or same password",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": {
          description: "Unauthorized or wrong current password",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
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
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/LinkGoogleRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Google linked",
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
            },
          },
        },
        "400": {
          description: "Already linked",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": {
          description: "Unauthorized or invalid token",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "409": {
          description: "Social account linked to another user",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
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
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/LinkAppleRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Apple linked",
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
            },
          },
        },
        "400": {
          description: "Already linked",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": {
          description: "Unauthorized or invalid token",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "409": {
          description: "Social account linked to another user",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
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
      description:
        "Cannot unlink if it would leave the account with no sign-in method (password or another provider).",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/UnlinkSocialRequest" },
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
            },
          },
        },
        "400": {
          description: "Not linked or last sign-in method",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": {
          description: "Unauthorized",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/auth/devices/link/initiate": {
    post: {
      tags: ["Auth"],
      summary: "Start a QR device-link session",
      description:
        "Called by a new, unauthenticated device (web/desktop). Returns a `linkToken` and a `pollSecret`; the session expires in 120s.\n\n" +
        "**Client responsibilities (QR is entirely client-side — the backend never generates or scans it):**\n" +
        '- Encode **only the `linkToken`** into the QR (e.g. as `aimess://device-link?token=<linkToken>` or `{"t":"device-link","token":"<linkToken>"}`). NEVER put `pollSecret` in the QR — keep it in memory on this device; it is what authorizes token retrieval, so a photographed QR alone cannot steal the session.\n' +
        "- Poll `GET /auth/devices/link/status` with `linkToken` + `pollSecret` until `APPROVED`, then store the returned tokens (delivered once).\n" +
        "- When the 120s TTL lapses, regenerate by calling this endpoint again and refresh the QR.\n\n" +
        "The already-signed-in device scans the QR, extracts the `linkToken`, and calls `POST /auth/devices/link/approve`.",
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/DeviceLinkInitiateRequest" },
          },
        },
      },
      responses: {
        "201": {
          description: "Link session created",
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
            },
          },
        },
      },
    },
  },
  "/auth/devices/link/status": {
    get: {
      tags: ["Auth"],
      summary: "Poll a QR device-link session",
      description:
        "Called by the new device with its linkToken + pollSecret. Returns PENDING until approved, then APPROVED with tokens exactly once (subsequent polls return CONSUMED). A missing session or wrong pollSecret returns EXPIRED.",
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "linkToken",
          in: "query",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "pollSecret",
          in: "query",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Current link status",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/DeviceLinkStatusResponseData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    },
  },
  "/auth/devices/link/approve": {
    post: {
      tags: ["Auth"],
      summary: "Approve a QR device-link",
      description:
        "Called by an already-signed-in device after scanning the QR. The client decodes the QR locally and sends the extracted `linkToken` here. Issues a fresh session for the new device and marks the link approved. Returns the new device's `sessionId` so this device can immediately undo the link via DELETE /auth/sessions/{sessionId}.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/DeviceLinkApproveRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Device linked",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/DeviceLinkApproveResponseData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": {
          description: "Unauthorized",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Link session not found or expired",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "409": {
          description: "Link session already approved",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/auth/account": {
    delete: {
      tags: ["Auth"],
      summary: "Delete my account (soft delete)",
      description:
        "Soft-deletes the authenticated user's account: marks it PENDING_DELETION with a 30-day grace window, revokes all sessions/refresh tokens, and emits a user.deleted event. Afterwards neither password login nor any linked Google/Apple provider can authenticate. Password confirmation is required ONLY when the account has a password; social-only accounts may omit it.",
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
                  minLength: 1,
                  description:
                    "Current account password. Required (400 AUTH_PASSWORD_REQUIRED) when the account has a password; an incorrect value returns 401 AUTH_PASSWORD_INCORRECT. Omit for social-only accounts (no passwordHash).",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Account soft-deleted",
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
            },
          },
        },
        "400": {
          description: "Password required for an account that has one",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": {
          description: "Missing/invalid access token, or incorrect password",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
} as const;
