export const userPaths = {
  "/users/usernames/generate": {
    post: {
      tags: ["Users"],
      summary: "Generate available username from account",
      description:
        "Requires access token. Call with the same `account` from auth (uniqueness already enforced at registration). Derives a unique username (normalized, numeric suffix if taken).",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/GenerateUsernameRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Suggested username",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/GenerateUsernameResponseData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Invalid account or username format",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
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
  "/users/usernames/validate": {
    post: {
      tags: ["Users"],
      summary: "Check username availability",
      description:
        "Requires access token. Returns whether the username is available (your current username counts as available). Usernames are stored lowercase; checks are case-insensitive.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ValidateUsernameRequest" },
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
                        $ref: "#/components/schemas/ValidateUsernameResponseData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Invalid username format",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
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
  "/users/friends": {
    get: {
      tags: ["Users"],
      summary: "List my friends",
      description:
        "Accepted friends only, alphabetical (firstName, lastName). Optional `search` (case-insensitive on first/last name + username). Cursor pagination on userId; returns `nextCursor` (null when no more). Empty list when you have no accepted friends. `avatarUrl` is a presigned GET URL.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "search",
          in: "query",
          required: false,
          schema: { type: "string", minLength: 1, maxLength: 100 },
          description: "Filter by first/last name or username.",
        },
        {
          name: "cursor",
          in: "query",
          required: false,
          schema: { type: "string", format: "uuid" },
          description: "userId cursor from a previous `nextCursor`.",
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 30,
          },
        },
      ],
      responses: {
        "200": {
          description: "Friends list",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/FriendsListResponseData",
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
  "/users/uploads/url": {
    post: {
      tags: ["Users"],
      summary: "Get presigned URL to upload a file",
      description:
        "Generic upload endpoint. Pass `type` (e.g. `AVATAR`), `contentType`, and `contentLength` (bytes). Returns a short-lived PUT URL (private bucket). PUT the file to `uploadUrl` with the `Content-Type` header only, then send the returned `objectKey` as `avatarObjectKey` when PATCHing the profile.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/UserUploadUrlRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Presigned upload URL",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/UploadUrlResponseData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Validation failed or file too large",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
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
  "/users/settings/me": {
    get: {
      tags: ["Users"],
      summary: "Get my settings",
      description:
        "Returns privacy, chat, app, notification, and livestream preferences (find/friend-request/online/profile/call visibility, message auto-delete, read receipts, theme, language, per-category notification toggles + quiet hours, and default livestream quality).",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      responses: {
        "200": {
          description: "User settings",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/UserSettingsResponse",
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
        "404": {
          description: "Profile or settings not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
    patch: {
      tags: ["Users"],
      summary: "Update my settings",
      description:
        "Partial update of privacy, chat, app, notification, and/or livestream settings. Send only the groups and fields you want to change.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/UpdateUserSettingsRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Settings updated",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/UserSettingsResponse",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Validation failed or invalid call allow list",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
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
          description: "Profile or settings not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/users/accounts/me": {
    get: {
      tags: ["Users"],
      summary: "Get my linked sign-in providers",
      description:
        "Returns linked sign-in providers (EMAIL, GOOGLE, APPLE) with connection status. When auth-service is unavailable, may return a cached copy or omit providers (`accountStatus`).",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      responses: {
        "200": {
          description: "Connected accounts",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/ConnectedAccountsResponse",
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
  "/users/profiles/me": {
    get: {
      tags: ["Users"],
      summary: "Get my profile",
      description:
        "Returns profile fields (bio, avatar, username, …). `avatarUrl` is a presigned GET URL — refresh via this endpoint before `avatarUrlExpiresIn` expires. For linked sign-in providers, use GET /users/accounts/me.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      responses: {
        "200": {
          description: "Profile",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/UserProfileData",
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
        "404": {
          description: "Profile not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
    patch: {
      tags: ["Users"],
      summary: "Update my profile",
      description:
        "Updates the authenticated user's profile (user id from access token). Username can only be changed once every 30 days. For avatars, upload via presigned URL first, then send `avatarObjectKey`.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/UpdateProfileRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Profile updated",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/UserProfileData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description:
            "Validation failed, username change too soon, or avatar not uploaded",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
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
          description: "Profile not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "409": {
          description: "Username already taken",
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
