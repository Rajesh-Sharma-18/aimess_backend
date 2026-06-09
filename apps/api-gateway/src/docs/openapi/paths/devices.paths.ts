const unauthorized = {
  description: "Missing or invalid access token",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
    },
  },
};

const badRequest = {
  description: "Validation failed",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
    },
  },
};

export const devicesPaths = {
  // POST /devices — register / upsert a device token for push notifications.
  "/devices": {
    post: {
      tags: ["Devices"],
      summary: "Register device token",
      description: [
        "Registers (or updates) an FCM / APNs push-notification token for the authenticated user.",
        "",
        "Call this after login and whenever the OS rotates the token.",
        "The server upserts by `(userId, deviceId)` — the old token for the same device is replaced.",
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
                  description: "FCM registration token or APNs device token.",
                },
                platform: {
                  type: "string" as const,
                  enum: ["ANDROID", "IOS", "WEB"],
                  description:
                    "Device platform — determines which push channel to use.",
                },
                deviceId: {
                  type: "string" as const,
                  description:
                    "Optional stable device identifier (e.g. Android ID, IDFV). Used to deduplicate tokens when the same user logs in on the same device multiple times.",
                },
              },
            },
            example: {
              token: "fCG3k7p2Rn2...",
              platform: "ANDROID",
              deviceId: "a1b2c3d4e5f6",
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Token registered (or updated)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
            },
          },
        },
        "400": badRequest,
        "401": unauthorized,
      },
    },
  },

  // DELETE /devices/{token} — unregister a device token on logout / sign-out.
  "/devices/{token}": {
    delete: {
      tags: ["Devices"],
      summary: "Unregister device token",
      description: [
        "Removes a previously-registered push-notification token.",
        "",
        "Call this on explicit logout so the user stops receiving push notifications on the signed-out device.",
      ].join("\n"),
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "token",
          in: "path" as const,
          required: true,
          schema: { type: "string" as const },
          description: "The FCM / APNs token to remove.",
        },
      ],
      responses: {
        "200": {
          description: "Token removed",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
            },
          },
        },
        "401": unauthorized,
        "404": {
          description: "Token not found for this user",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
};
