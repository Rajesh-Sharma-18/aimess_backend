export const userPaths = {
  "/users": {
    get: {
      tags: ["Users", "Communities"],
      summary: "Discover / search users",
      description:
        "Returns a paginated list of users filtered by `section`.\n\n" +
        "- **`others`** (default) — everyone except yourself, accepted friends, and blocked users. Includes `relationshipStatus` (NONE / PENDING_IN / PENDING_OUT) and `friendshipId`.\n" +
        "- **`friends`** — your accepted friends only. `relationshipStatus` is always `FRIEND`.\n" +
        "- **`all`** — every user except yourself and anyone who blocked you (or whom you blocked). No `relationshipStatus` returned — useful for admin / search-all flows.\n\n" +
        "Optionally filter by `q` (searches username, firstName, lastName). Results are offset-paginated; use `page` + `limit`.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "section",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["friends", "others", "all"],
            default: "others",
          },
          description:
            "`others` = non-friends (excludes you + friends + blocked). `friends` = accepted friends only. `all` = everyone except you + blocked.",
        },
        {
          name: "q",
          in: "query",
          required: false,
          schema: { type: "string", maxLength: 100 },
          description:
            "Search term matched against username, firstName, lastName.",
        },
        {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, default: 1 },
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
      ],
      responses: {
        "200": {
          description: "User list + total count",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/UserDiscoveryResponseData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Invalid query params",
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
  "/users/friends/requests": {
    get: {
      tags: ["Users"],
      summary: "List my pending friend requests",
      description:
        "Returns the authenticated user's **PENDING** friend requests, newest first, offset-paginated.\n\n" +
        "- **`incoming`** (default) — requests addressed **to you** (awaiting your accept/reject).\n" +
        "- **`outgoing`** — requests **you sent** (awaiting the other person; you may cancel them).\n" +
        "- **`all`** — both directions.\n\n" +
        "Each item carries the other user's display profile, the `friendshipId` (pass to accept / reject / cancel), `direction`, and `createdAt`. `total` is the count of pending requests in the chosen direction; the page list may be shorter than `total` when a peer's profile has been deleted.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "direction",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["incoming", "outgoing", "all"],
            default: "incoming",
          },
          description:
            "`incoming` = requests addressed to you; `outgoing` = requests you sent; `all` = both.",
        },
        {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, default: 1 },
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
      ],
      responses: {
        "200": {
          description: "Pending friend requests + total",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/FriendRequestsListResponseData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Invalid query params (direction / page / limit)",
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
    post: {
      tags: ["Users"],
      summary: "Send a friend request",
      description:
        "Sends a friend request from the authenticated user to `addresseeId`.\n\n" +
        "**Business rules**\n" +
        "- You cannot befriend yourself (400).\n" +
        "- Both profiles must exist and be active (404 otherwise).\n" +
        "- Blocked in either direction → request refused (400).\n" +
        "- An existing **ACCEPTED** friendship → 409 (already friends).\n" +
        "- A **PENDING** request you already sent → 409 (already sent).\n" +
        "- A **PENDING** request the other user sent **to you** → the call **auto-accepts** it and returns the friendship with `status: ACCEPTED`.\n" +
        "- A prior **REJECTED / CANCELLED / UNFRIENDED** row is recycled into a fresh PENDING request.\n\n" +
        "Always responds **201** on success.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/SendFriendRequestRequest" },
          },
        },
      },
      responses: {
        "201": {
          description:
            "Friend request created (or auto-accepted when a mutual pending request existed).",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      message: {
                        type: "string",
                        example: "Friend request sent.",
                      },
                      data: { $ref: "#/components/schemas/Friendship" },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description:
            "Validation failed, befriending yourself, or blocked in either direction.",
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
          description: "Requester or addressee profile not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "409": {
          description: "Already friends, or a request was already sent",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/users/friends/requests/{id}/accept": {
    post: {
      tags: ["Users"],
      summary: "Accept a friend request",
      description:
        "Accepts a PENDING friend request addressed to the authenticated user. Only the **addressee** of a still-PENDING request may accept; otherwise 404. Bumps both users' friend counts and returns the friendship with `status: ACCEPTED` and `acceptedAt` set.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          description:
            "Friendship id from the request payload / discovery list.",
        },
      ],
      responses: {
        "200": {
          description: "Friend request accepted",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      message: {
                        type: "string",
                        example: "Friend request accepted.",
                      },
                      data: { $ref: "#/components/schemas/Friendship" },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Invalid friendship id (not a UUID)",
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
          description:
            "No matching PENDING request addressed to you (wrong id, not the addressee, or already resolved).",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/users/friends/requests/{id}/reject": {
    post: {
      tags: ["Users"],
      summary: "Reject a friend request",
      description:
        "Declines a PENDING friend request addressed to the authenticated user. Only the **addressee** of a still-PENDING request may reject; otherwise 404. Returns the friendship with `status: REJECTED` and `rejectedAt` set. The row can later be recycled if either party re-sends.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          description: "Friendship id of the pending request to decline.",
        },
      ],
      responses: {
        "200": {
          description: "Friend request declined",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      message: {
                        type: "string",
                        example: "Friend request declined.",
                      },
                      data: { $ref: "#/components/schemas/Friendship" },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Invalid friendship id (not a UUID)",
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
          description:
            "No matching PENDING request addressed to you (wrong id, not the addressee, or already resolved).",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/users/friends/requests/{id}": {
    delete: {
      tags: ["Users"],
      summary: "Cancel a friend request you sent",
      description:
        "Withdraws a PENDING friend request that the authenticated user **sent**. Only the **requester** of a still-PENDING request may cancel; otherwise 404. Returns the friendship with `status: CANCELLED` and `cancelledAt` set.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          description: "Friendship id of the pending request you sent.",
        },
      ],
      responses: {
        "200": {
          description: "Friend request cancelled",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      message: {
                        type: "string",
                        example: "Friend request cancelled.",
                      },
                      data: { $ref: "#/components/schemas/Friendship" },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Invalid friendship id (not a UUID)",
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
          description:
            "No matching PENDING request that you sent (wrong id, not the requester, or already resolved).",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/users/friends/auto-connect": {
    post: {
      tags: ["Users"],
      summary: "Auto-connect caller with all eligible users",
      description:
        "Creates ACCEPTED friendships between the authenticated user and every active user who has no existing friendship row with them.\n\n" +
        "**Idempotency**: calling this endpoint a second time returns `friendsCreated: 0` and counts previously-created friendships in `alreadyFriends` — it is safe to call repeatedly.\n\n" +
        "**Side effects**: a `friend.accepted` event is published via RabbitMQ for every new friendship created; `friendsCount` is incremented on both user profiles per pair.\n\n" +
        "**Classification rules** (applied per active user, in order):\n" +
        "1. Either party has a block → `blockedUsers`\n" +
        "2. Existing ACCEPTED row → `alreadyFriends`\n" +
        "3. Existing PENDING row (either direction) → `pendingRequests`\n" +
        "4. Any other existing row (REJECTED / CANCELLED / UNFRIENDED) → `skippedUsers`\n" +
        "5. No row → eligible; included in `friendsCreated`",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      responses: {
        "200": {
          description: "Auto-connect summary",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        type: "object",
                        required: [
                          "totalUsersScanned",
                          "eligibleUsers",
                          "friendsCreated",
                          "alreadyFriends",
                          "blockedUsers",
                          "pendingRequests",
                          "skippedUsers",
                        ],
                        properties: {
                          totalUsersScanned: {
                            type: "integer",
                            description:
                              "Total active users considered (excludes the caller).",
                            example: 42,
                          },
                          eligibleUsers: {
                            type: "integer",
                            description:
                              "Users with no prior friendship row — attempted as new friends.",
                            example: 38,
                          },
                          friendsCreated: {
                            type: "integer",
                            description:
                              "New ACCEPTED friendships created in this call.",
                            example: 38,
                          },
                          alreadyFriends: {
                            type: "integer",
                            description:
                              "Users already in an ACCEPTED friendship with the caller.",
                            example: 2,
                          },
                          blockedUsers: {
                            type: "integer",
                            description:
                              "Users skipped due to a block in either direction.",
                            example: 1,
                          },
                          pendingRequests: {
                            type: "integer",
                            description:
                              "Users with a PENDING request (outgoing or incoming) — not auto-accepted.",
                            example: 1,
                          },
                          skippedUsers: {
                            type: "integer",
                            description:
                              "Users with a prior non-pending, non-accepted row (REJECTED / CANCELLED / UNFRIENDED).",
                            example: 0,
                          },
                        },
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
  "/users/friends/{userId}": {
    delete: {
      tags: ["Users"],
      summary: "Unfriend (remove an accepted friend)",
      description:
        "Removes an existing **ACCEPTED** friendship between the authenticated user and `userId`, regardless of who originally sent the request. Decrements both users' friend counts. You cannot unfriend yourself (400). Returns a success envelope with **no `data` payload**.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "userId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          description: "userId of the friend to remove.",
        },
      ],
      responses: {
        "200": {
          description:
            "Friend removed. Success envelope only — `data` is omitted.",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      message: {
                        type: "string",
                        example: "Friend removed successfully.",
                      },
                      data: {
                        type: "object",
                        nullable: true,
                        description: "Always absent for this endpoint.",
                        example: null,
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Invalid userId, or attempting to unfriend yourself",
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
          description: "No active friendship exists between you and this user",
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
      summary: "Get presigned avatar upload URL",
      description:
        "Creates a short-lived presigned PUT URL for uploading a user avatar.\n\n" +
        "Upload-URL issuance is centralized in the media-service; this endpoint is a stable alias that forwards to " +
        "`POST /api/v1/media/upload-url` (category `USER_AVATAR`) and returns the same response and `objectKey`.\n\n" +
        "Flow: call this endpoint → PUT the file to the returned `uploadUrl` with the `Content-Type` header → send the returned " +
        "`objectKey` as `avatarObjectKey` on `PATCH /users/profiles/me`. You may also call " +
        '`POST /api/v1/media/upload-url` directly with `{ "category": "USER_AVATAR" }`.',
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
          description:
            "Presigned upload URL (identical payload to POST /api/v1/media/upload-url).",
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
          description:
            "Validation failed (e.g. `type` is not `AVATAR`, or contentType/contentLength invalid).",
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
        "415": {
          description: "Unsupported content type",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "503": {
          description: "Media service temporarily unavailable",
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
