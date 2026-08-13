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

const badRequest = {
  description: "Validation failed",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
      example: {
        success: false,
        message: "Validation error",
        errors: { token: "token is required" },
      },
    },
  },
};

const tooManyRequests = {
  description:
    "Rate limit exceeded — max 10 device token registrations per minute per IP",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
      example: {
        success: false,
        message: "Too many device token registrations, please try again later.",
      },
    },
  },
};

export const devicesPaths = {
  "/devices": {
    post: {
      tags: ["Devices"],
      operationId: "registerDevice",
      summary: "Register device token",
      description: [
        "Registers (or updates) an FCM / APNs push-notification token for the authenticated user.",
        "",
        "Call this after login and whenever the OS rotates the token.",
        "The server upserts by `token` — if the token already exists it is re-assigned to the current",
        "user/device and its `lastSeenAt` is bumped. Supplying `deviceId` further deduplicates across",
        "re-logins on the same physical device.",
        "",
        "**Multi-device fan-out:** push notifications are sent to ALL active tokens for a user.",
        "A single user can have tokens from their phone, tablet, and browser simultaneously — all receive",
        "each notification. Logout (single or all-devices) clears the corresponding token(s) automatically.",
        "",
        "**FCM payload shape** (informational — server-side only):",
        "- `data.deepLink` — `aimess://` URL for navigation on tap (e.g. `aimess://community/<id>`).",
        "- `data.type` — domain event type (e.g. `community.message.new`, `chat.message.new`).",
        "- `data.actorId` — userId of the actor that triggered the notification (when applicable).",
        "- `android.collapseKey` — collapses multiple unread messages per conversation.",
        '- `apns.payload.aps.sound` — `"default"` for audible alerts on iOS.',
        "",
        "**Privacy — showPreview:** when the user has disabled message previews in notification settings,",
        'the notification body is replaced with a generic `"New message"` string. The title is unchanged.',
        "",
        "**Rate limit:** 10 registrations per minute per IP (HTTP 429 when exceeded).",
        "",
        "**When to call:**",
        "- On successful login (before the user navigates to the home screen)",
        "- When `onTokenRefresh` fires (Android FCM) or APNs re-issues a token",
        "- On app resume after a long background pause (token may have rotated)",
      ].join("\n"),
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              required: ["token", "platform"],
              properties: {
                token: {
                  type: "string" as const,
                  description:
                    "FCM registration token (Android / Web) or APNs device token (iOS).",
                  example: "fCG3k7p2Rn2:APA91bH8q...",
                },
                platform: {
                  type: "string" as const,
                  enum: ["ANDROID", "IOS", "WEB"],
                  description:
                    "Device platform — determines which push channel (FCM vs APNs) to use.",
                  example: "ANDROID",
                },
                deviceId: {
                  type: "string" as const,
                  description:
                    "Optional stable device identifier (e.g. Android ID, IDFV). Used to deduplicate tokens so the same user with multiple logins on the same device keeps only one active token. Omit if unavailable.",
                  example: "a1b2c3d4e5f6",
                },
              },
            },
            examples: {
              android: {
                summary: "Android FCM token",
                value: {
                  token: "fCG3k7p2Rn2:APA91bH8qE3...",
                  platform: "ANDROID",
                  deviceId: "a1b2c3d4e5f6",
                },
              },
              ios: {
                summary: "iOS APNs token",
                value: {
                  token: "a3f8e2b1d7c9...",
                  platform: "IOS",
                  deviceId: "IDFV-ABCD-1234",
                },
              },
              web: {
                summary: "Web push token (no deviceId)",
                value: {
                  token: "BNHwHj8gFxT...",
                  platform: "WEB",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description:
            "Token registered (or updated if the same deviceId already existed)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
              example: {
                success: true,
                message: "Device token registered",
                data: null,
              },
            },
          },
        },
        "400": badRequest,
        "401": unauthorized,
        "429": tooManyRequests,
      },
    },
  },

  "/notifications/fcm-token": {
    post: {
      tags: ["Devices"],
      operationId: "registerFcmToken",
      summary: "Register FCM token (alias of POST /devices)",
      description: [
        "Stable alias of `POST /devices` for clients that target the legacy",
        "`/notifications/fcm-token` path. The request is forwarded verbatim to the",
        "same notifications-service endpoint — identical auth, validation, upsert",
        "behaviour and response envelope. Prefer `POST /devices` for new clients.",
        "",
        "**Body:** same as `POST /devices` (`token`, `platform`, optional",
        "`deviceId`). For convenience the aliases `fcmToken` (→ `token`) and",
        "`deviceType` (→ `platform`) are also accepted, and `platform` values are",
        "upper-cased (`android` → `ANDROID`).",
        "",
        "**Rate limit:** 10 registrations per minute per IP (shared with `/devices`).",
      ].join("\n"),
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              required: ["token", "platform"],
              properties: {
                token: {
                  type: "string" as const,
                  description:
                    "FCM registration token (Android / Web) or APNs device token (iOS). `fcmToken` is accepted as an alias.",
                  example: "fCG3k7p2Rn2:APA91bH8q...",
                },
                platform: {
                  type: "string" as const,
                  enum: ["ANDROID", "IOS", "WEB"],
                  description:
                    "Device platform. `deviceType` is accepted as an alias; values are upper-cased.",
                  example: "ANDROID",
                },
                deviceId: {
                  type: "string" as const,
                  description:
                    "Optional stable device identifier used to deduplicate tokens across re-logins on the same device.",
                  example: "a1b2c3d4e5f6",
                },
                tokenType: {
                  type: "string" as const,
                  enum: ["FCM", "VOIP"],
                  default: "FCM",
                  description:
                    "`VOIP` registers an iOS PushKit token used only for call ringing over APNs. Forwarded verbatim — omitting it stores the row as `FCM`.",
                  example: "FCM",
                },
              },
            },
            example: {
              token: "fCG3k7p2Rn2:APA91bH8qE3...",
              platform: "ANDROID",
              deviceId: "a1b2c3d4e5f6",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Token registered (or updated)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
              example: { success: true },
            },
          },
        },
        "400": badRequest,
        "401": unauthorized,
        "429": tooManyRequests,
      },
    },
  },

  "/notifications/fcm-token/{token}": {
    delete: {
      tags: ["Devices"],
      operationId: "unregisterFcmToken",
      summary: "Unregister FCM token (alias of DELETE /devices/{token})",
      description: [
        "Stable alias of `DELETE /devices/{token}` for clients that target the",
        "legacy `/notifications/fcm-token` path (the native iOS / Android logout",
        "step). Forwarded verbatim to the same notifications-service endpoint —",
        "identical auth, scoping and response envelope. Prefer",
        "`DELETE /devices/{token}` for new clients.",
        "",
        "The delete is scoped to the caller: a user can only ever remove their own",
        "token. Idempotent — a token that is already gone returns 200 with",
        "`removed: false`.",
      ].join("\n"),
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "token",
          in: "path" as const,
          required: true,
          schema: { type: "string" as const },
          description:
            "The exact FCM / APNs token string previously registered. URL-encode it.",
          example: "fCG3k7p2Rn2:APA91bH8qE3...",
        },
      ],
      responses: {
        "200": {
          description: "Token removed (or already absent — idempotent)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
              example: { success: true, removed: true },
            },
          },
        },
        "400": badRequest,
        "401": unauthorized,
        "429": tooManyRequests,
      },
    },
  },

  "/devices/{token}": {
    delete: {
      tags: ["Devices"],
      operationId: "unregisterDevice",
      summary: "Unregister device token",
      description: [
        "Removes a previously-registered push-notification token.",
        "",
        "Call this on explicit logout so the user stops receiving push notifications on the signed-out device.",
        "",
        "**When to call:**",
        "- After POST /auth/logout (before clearing local credentials)",
        "- After revoking a session via DELETE /auth/sessions/{sessionId}",
        "",
        "Idempotent: calling again for an already-removed token is safe — server returns 200.",
      ].join("\n"),
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "token",
          in: "path" as const,
          required: true,
          schema: { type: "string" as const },
          description:
            "The exact FCM / APNs token string previously registered via POST /devices.",
          example: "fCG3k7p2Rn2:APA91bH8qE3...",
        },
      ],
      responses: {
        "200": {
          description: "Token removed (or already absent — idempotent)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
              example: {
                success: true,
                message: "Device token unregistered",
                data: null,
              },
            },
          },
        },
        "401": unauthorized,
        "404": {
          description: "Token not found for this user",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Device token not found",
                code: "DEVICE_TOKEN_NOT_FOUND",
              },
            },
          },
        },
      },
    },
  },
};
