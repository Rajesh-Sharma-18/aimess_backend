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
  description: "Validation failed — invalid query parameters or request body",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
      example: { success: false, message: "Validation error", errors: {} },
    },
  },
};

const notFound = {
  description: "Resource not found",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
      example: {
        success: false,
        message: "User not found",
        code: "USER_NOT_FOUND",
      },
    },
  },
};

const tooManyRequests = {
  description: "Rate limit exceeded",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
      example: {
        success: false,
        message: "Too many requests. Please slow down.",
        code: "RATE_LIMIT_EXCEEDED",
      },
    },
  },
};

export const userPaths = {
  "/users": {
    get: {
      tags: ["Users", "Communities"],
      summary: "Discover / search users",
      operationId: "discoverUsers",
      description:
        "Three operation modes controlled by the optional `type` parameter:\n\n" +
        "- **No `type`** (split mode) — returns `{ friends[], otherPeople[] }`, up to 5 users in each group. No pagination. Use for the search overlay / typeahead.\n" +
        "- **`type=friends`** — paginated list of your accepted friends only. `relationshipStatus` is always `FRIEND`.\n" +
        "- **`type=others`** — paginated list of everyone except yourself, accepted friends, and blocked users. `relationshipStatus` may be `NONE`, `PENDING_IN`, or `PENDING_OUT`.\n\n" +
        "Optionally filter by `q` (searches username, firstName, lastName, and full name in either order).",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "type",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["friends", "others"],
          },
          description:
            "Omit for split mode (friends[] + otherPeople[], max 5 each). `friends` = paginated accepted friends. `others` = paginated non-friends.",
        },
        {
          name: "q",
          in: "query",
          required: false,
          schema: { type: "string", maxLength: 100 },
          description:
            'Search term matched against username, firstName, lastName, or full name (e.g. "John Doe").',
          example: "john",
        },
        {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, default: 1 },
          description: "Used only when `type` is provided.",
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          description: "Used only when `type` is provided.",
        },
      ],
      responses: {
        "200": {
          description:
            "Split response when no `type` is given; paginated response when `type=friends` or `type=others`.",
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  {
                    allOf: [
                      { $ref: "#/components/schemas/ApiSuccessResponse" },
                      {
                        type: "object",
                        properties: {
                          data: {
                            $ref: "#/components/schemas/UserDiscoverySplitData",
                          },
                        },
                      },
                    ],
                  },
                  {
                    allOf: [
                      { $ref: "#/components/schemas/ApiSuccessResponse" },
                      {
                        type: "object",
                        properties: {
                          data: {
                            $ref: "#/components/schemas/UserDiscoveryPaginatedData",
                          },
                        },
                      },
                    ],
                  },
                ],
              },
              examples: {
                splitMode: {
                  summary: "No type (split mode)",
                  value: {
                    success: true,
                    message: "Users retrieved",
                    data: {
                      friends: [
                        {
                          userId: "660e8400-e29b-41d4-a716-446655440001",
                          username: "janedoe",
                          firstName: "Jane",
                          lastName: "Doe",
                          avatarUrl: null,
                          bio: null,
                          isOnline: false,
                          relationshipStatus: "FRIEND",
                          friendshipId: "770e8400-e29b-41d4-a716-446655440002",
                        },
                      ],
                      otherPeople: [
                        {
                          userId: "880e8400-e29b-41d4-a716-446655440003",
                          username: "bobsmith",
                          firstName: "Bob",
                          lastName: "Smith",
                          avatarUrl: null,
                          bio: null,
                          isOnline: true,
                          relationshipStatus: "NONE",
                          friendshipId: null,
                        },
                      ],
                    },
                  },
                },
                paginatedFriends: {
                  summary: "type=friends",
                  value: {
                    success: true,
                    message: "Users retrieved",
                    data: {
                      users: [
                        {
                          userId: "660e8400-e29b-41d4-a716-446655440001",
                          username: "janedoe",
                          firstName: "Jane",
                          lastName: "Doe",
                          avatarUrl: null,
                          bio: null,
                          isOnline: false,
                          relationshipStatus: "FRIEND",
                          friendshipId: "770e8400-e29b-41d4-a716-446655440002",
                        },
                      ],
                      pagination: {
                        total: 42,
                        page: 1,
                        limit: 20,
                        totalPages: 3,
                        hasNext: true,
                        hasPrevious: false,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "400": {
          description: "Invalid query parameters",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Invalid type value. Must be 'friends' or 'others'",
              },
            },
          },
        },
        "401": unauthorized,
      },
    },
  },
  "/users/usernames/generate": {
    post: {
      tags: ["Users"],
      summary: "Generate available username from account",
      operationId: "generateUsername",
      description:
        "Requires access token. Call with the same `account` from auth (uniqueness already enforced at registration). Derives a unique username (normalized, numeric suffix if taken).\n\n" +
        "**Example:** `account=John_Doe` → `username=john_doe` or `john_doe_2` if taken.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/GenerateUsernameRequest" },
            example: { account: "john_doe" },
          },
        },
      },
      responses: {
        "200": {
          description: "Suggested available username",
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
              example: {
                success: true,
                message: "Username generated",
                data: { username: "john_doe" },
              },
            },
          },
        },
        "400": {
          description: "Invalid account or resulting username fails validation",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message:
                  "Cannot derive a valid username from the provided account",
              },
            },
          },
        },
        "401": unauthorized,
      },
    },
  },
  "/users/usernames/validate": {
    post: {
      tags: ["Users"],
      summary: "Check username availability",
      operationId: "validateUsername",
      description:
        "Requires access token. Returns whether the username is available (your current username counts as available). Usernames are stored lowercase; checks are case-insensitive.\n\n" +
        "**Validation rules:** 3–32 characters, alphanumeric + underscore only (`^[a-zA-Z0-9_]+$`).",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ValidateUsernameRequest" },
            example: { username: "john_doe_99" },
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
              examples: {
                available: {
                  summary: "Username available",
                  value: {
                    success: true,
                    message: "Username available",
                    data: { username: "john_doe_99", available: true },
                  },
                },
                taken: {
                  summary: "Username taken",
                  value: {
                    success: true,
                    message: "Username taken",
                    data: { username: "john_doe_99", available: false },
                  },
                },
              },
            },
          },
        },
        "400": {
          description: "Invalid username format",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message:
                  "Username must be 3–32 characters (letters, digits, underscores only)",
              },
            },
          },
        },
        "401": unauthorized,
      },
    },
  },
  "/users/friends": {
    get: {
      tags: ["Users"],
      summary: "List my friends",
      operationId: "listFriends",
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
          example: "jane",
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
          description: "Friends list (cursor-paginated)",
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
              example: {
                success: true,
                message: "Friends retrieved",
                data: {
                  friends: [
                    {
                      userId: "660e8400-e29b-41d4-a716-446655440001",
                      username: "janedoe",
                      firstName: "Jane",
                      lastName: "Doe",
                      avatarUrl: "https://storage.example.com/avatars/jane.jpg",
                      friendshipId: "f1a2b3c4-d5e6-7890-abcd-ef1234567890",
                    },
                  ],
                  nextCursor: null,
                  hasMore: false,
                },
              },
            },
          },
        },
        "401": unauthorized,
      },
    },
  },
  "/users/friends/requests": {
    get: {
      tags: ["Users"],
      summary: "List pending friend requests",
      operationId: "listFriendRequests",
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
              example: {
                success: true,
                message: "Friend requests retrieved",
                data: {
                  requests: [
                    {
                      friendshipId: "f1a2b3c4-d5e6-7890-abcd-ef1234567890",
                      direction: "incoming",
                      user: {
                        userId: "660e8400-e29b-41d4-a716-446655440001",
                        username: "janedoe",
                        firstName: "Jane",
                        lastName: "Doe",
                        avatarUrl:
                          "https://storage.example.com/avatars/jane.jpg",
                      },
                      createdAt: "2026-06-24T10:00:00.000Z",
                    },
                  ],
                  total: 1,
                  page: 1,
                  limit: 20,
                  totalPages: 1,
                  hasNext: false,
                },
              },
            },
          },
        },
        "400": {
          description: "Invalid query params (direction / page / limit)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: { success: false, message: "Invalid direction value" },
            },
          },
        },
        "401": unauthorized,
      },
    },
    post: {
      tags: ["Users"],
      summary: "Send a friend request",
      operationId: "sendFriendRequest",
      description:
        "Sends a friend request from the authenticated user to `addresseeId`.\n\n" +
        "**Business rules:**\n" +
        "- You cannot befriend yourself (400 SELF_FRIEND_REQUEST).\n" +
        "- Both profiles must exist and be active (404 otherwise).\n" +
        "- Blocked in either direction → request refused (400 BLOCKED).\n" +
        "- An existing **ACCEPTED** friendship → 409 (already friends).\n" +
        "- A **PENDING** request you already sent → 409 (already sent).\n" +
        "- A **PENDING** request the other user sent **to you** → the call **auto-accepts** it and returns the friendship with `status: ACCEPTED`.\n" +
        "- A prior **REJECTED / CANCELLED / UNFRIENDED** row is recycled into a fresh PENDING request.\n\n" +
        "Always responds **201** on success (even on auto-accept).",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/SendFriendRequestRequest" },
            example: { addresseeId: "660e8400-e29b-41d4-a716-446655440001" },
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
              examples: {
                sent: {
                  summary: "Request sent successfully",
                  value: {
                    success: true,
                    message: "Friend request sent.",
                    data: {
                      friendshipId: "f1a2b3c4-d5e6-7890-abcd-ef1234567890",
                      status: "PENDING",
                      requesterId: "550e8400-e29b-41d4-a716-446655440000",
                      addresseeId: "660e8400-e29b-41d4-a716-446655440001",
                      createdAt: "2026-06-25T10:00:00.000Z",
                    },
                  },
                },
                autoAccepted: {
                  summary: "Auto-accepted (mutual pending request existed)",
                  value: {
                    success: true,
                    message: "Friend request accepted.",
                    data: {
                      friendshipId: "f1a2b3c4-d5e6-7890-abcd-ef1234567890",
                      status: "ACCEPTED",
                      requesterId: "660e8400-e29b-41d4-a716-446655440001",
                      addresseeId: "550e8400-e29b-41d4-a716-446655440000",
                      acceptedAt: "2026-06-25T10:00:00.000Z",
                    },
                  },
                },
              },
            },
          },
        },
        "400": {
          description:
            "Validation failed, self-request, or blocked in either direction",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              examples: {
                self: {
                  summary: "Cannot befriend yourself",
                  value: {
                    success: false,
                    message: "You cannot send a friend request to yourself",
                    code: "SELF_FRIEND_REQUEST",
                  },
                },
                blocked: {
                  summary: "User is blocked",
                  value: {
                    success: false,
                    message: "You cannot send a friend request to this user",
                    code: "USER_BLOCKED",
                  },
                },
              },
            },
          },
        },
        "401": unauthorized,
        "404": {
          description: "Requester or addressee profile not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "User not found",
                code: "USER_NOT_FOUND",
              },
            },
          },
        },
        "409": {
          description: "Already friends, or a request was already sent",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              examples: {
                alreadyFriends: {
                  summary: "Already friends",
                  value: {
                    success: false,
                    message: "You are already friends with this user",
                    code: "ALREADY_FRIENDS",
                  },
                },
                alreadySent: {
                  summary: "Request already sent",
                  value: {
                    success: false,
                    message: "Friend request already sent",
                    code: "REQUEST_ALREADY_SENT",
                  },
                },
              },
            },
          },
        },
        "429": tooManyRequests,
      },
    },
  },
  "/users/friends/requests/{id}/accept": {
    post: {
      tags: ["Users"],
      summary: "Accept a friend request",
      operationId: "acceptFriendRequest",
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
          example: "f1a2b3c4-d5e6-7890-abcd-ef1234567890",
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
              example: {
                success: true,
                message: "Friend request accepted.",
                data: {
                  friendshipId: "f1a2b3c4-d5e6-7890-abcd-ef1234567890",
                  status: "ACCEPTED",
                  requesterId: "660e8400-e29b-41d4-a716-446655440001",
                  addresseeId: "550e8400-e29b-41d4-a716-446655440000",
                  acceptedAt: "2026-06-25T10:05:00.000Z",
                },
              },
            },
          },
        },
        "400": {
          description: "Invalid friendship id (not a UUID)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Invalid friendship id format",
              },
            },
          },
        },
        "401": unauthorized,
        "404": {
          description:
            "No matching PENDING request addressed to you (wrong id, not the addressee, or already resolved).",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Pending friend request not found",
                code: "FRIEND_REQUEST_NOT_FOUND",
              },
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
      operationId: "rejectFriendRequest",
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
          example: "f1a2b3c4-d5e6-7890-abcd-ef1234567890",
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
              example: {
                success: true,
                message: "Friend request declined.",
                data: {
                  friendshipId: "f1a2b3c4-d5e6-7890-abcd-ef1234567890",
                  status: "REJECTED",
                  requesterId: "660e8400-e29b-41d4-a716-446655440001",
                  addresseeId: "550e8400-e29b-41d4-a716-446655440000",
                  rejectedAt: "2026-06-25T10:10:00.000Z",
                },
              },
            },
          },
        },
        "400": {
          description: "Invalid friendship id (not a UUID)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Invalid friendship id format",
              },
            },
          },
        },
        "401": unauthorized,
        "404": {
          description: "No matching PENDING request addressed to you.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Pending friend request not found",
                code: "FRIEND_REQUEST_NOT_FOUND",
              },
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
      operationId: "cancelFriendRequest",
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
          example: "f1a2b3c4-d5e6-7890-abcd-ef1234567890",
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
              example: {
                success: true,
                message: "Friend request cancelled.",
                data: {
                  friendshipId: "f1a2b3c4-d5e6-7890-abcd-ef1234567890",
                  status: "CANCELLED",
                  requesterId: "550e8400-e29b-41d4-a716-446655440000",
                  addresseeId: "660e8400-e29b-41d4-a716-446655440001",
                  cancelledAt: "2026-06-25T10:15:00.000Z",
                },
              },
            },
          },
        },
        "400": {
          description: "Invalid friendship id (not a UUID)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Invalid friendship id format",
              },
            },
          },
        },
        "401": unauthorized,
        "404": {
          description: "No matching PENDING request that you sent.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Pending friend request not found",
                code: "FRIEND_REQUEST_NOT_FOUND",
              },
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
      operationId: "autoConnectFriends",
      description:
        "Creates ACCEPTED friendships between the authenticated user and every active user who has no existing friendship row with them.\n\n" +
        "**Idempotency**: calling this endpoint a second time returns `friendsCreated: 0` and counts previously-created friendships in `alreadyFriends` — it is safe to call repeatedly.\n\n" +
        "**Side effects**: a `friend.accepted` event is published via RabbitMQ for every new friendship created; `friendsCount` is incremented on both user profiles per pair.",
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
              example: {
                success: true,
                message: "Auto-connect complete",
                data: {
                  totalUsersScanned: 42,
                  eligibleUsers: 38,
                  friendsCreated: 38,
                  alreadyFriends: 2,
                  blockedUsers: 1,
                  pendingRequests: 1,
                  skippedUsers: 0,
                },
              },
            },
          },
        },
        "401": unauthorized,
      },
    },
  },
  "/users/friends/{userId}": {
    delete: {
      tags: ["Users"],
      summary: "Unfriend (remove an accepted friend)",
      operationId: "unfriendUser",
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
          example: "660e8400-e29b-41d4-a716-446655440001",
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
              example: {
                success: true,
                message: "Friend removed successfully.",
                data: null,
              },
            },
          },
        },
        "400": {
          description: "Invalid userId, or attempting to unfriend yourself",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "You cannot unfriend yourself",
                code: "SELF_UNFRIEND",
              },
            },
          },
        },
        "401": unauthorized,
        "404": {
          description: "No active friendship exists between you and this user",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "No friendship found with this user",
                code: "FRIENDSHIP_NOT_FOUND",
              },
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
      operationId: "getUserSettings",
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
              example: {
                success: true,
                message: "Settings retrieved",
                data: {
                  privacy: {
                    whoCanFindMe: "EVERYONE",
                    whoCanSendFriendRequest: "EVERYONE",
                    showOnlineStatus: true,
                    profileVisibility: "PUBLIC",
                  },
                  chat: {
                    autoDeleteMessages: false,
                    readReceipts: true,
                  },
                  app: {
                    theme: "SYSTEM",
                    language: "en",
                  },
                  notifications: {
                    messages: true,
                    friendRequests: true,
                    communityUpdates: true,
                    quietHoursStart: null,
                    quietHoursEnd: null,
                  },
                  livestream: {
                    defaultQuality: "AUTO",
                  },
                },
              },
            },
          },
        },
        "401": unauthorized,
        "404": {
          description: "Profile or settings not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "User profile not found",
                code: "USER_NOT_FOUND",
              },
            },
          },
        },
      },
    },
    patch: {
      tags: ["Users"],
      summary: "Update my settings",
      operationId: "updateUserSettings",
      description:
        "Partial update of privacy, chat, app, notification, and/or livestream settings. Send only the groups and fields you want to change.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/UpdateUserSettingsRequest" },
            examples: {
              privacyUpdate: {
                summary: "Update privacy settings",
                value: {
                  privacy: {
                    whoCanFindMe: "FRIENDS_ONLY",
                    showOnlineStatus: false,
                  },
                },
              },
              notificationsUpdate: {
                summary: "Update notification settings",
                value: {
                  notifications: {
                    messages: true,
                    communityUpdates: false,
                    quietHoursStart: "22:00",
                    quietHoursEnd: "08:00",
                  },
                },
              },
            },
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
              example: {
                success: true,
                message: "Settings updated",
                data: {
                  privacy: {
                    whoCanFindMe: "FRIENDS_ONLY",
                    whoCanSendFriendRequest: "EVERYONE",
                    showOnlineStatus: false,
                    profileVisibility: "PUBLIC",
                  },
                  chat: { autoDeleteMessages: false, readReceipts: true },
                  app: { theme: "SYSTEM", language: "en" },
                  notifications: {
                    messages: true,
                    friendRequests: true,
                    communityUpdates: false,
                    quietHoursStart: "22:00",
                    quietHoursEnd: "08:00",
                  },
                  livestream: { defaultQuality: "AUTO" },
                },
              },
            },
          },
        },
        "400": {
          description: "Validation failed or invalid call allow list",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Invalid settings value",
                errors: {
                  "privacy.whoCanFindMe":
                    "Must be one of: EVERYONE, FRIENDS_ONLY, NOBODY",
                },
              },
            },
          },
        },
        "401": unauthorized,
        "404": {
          description: "Profile or settings not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: { success: false, message: "User profile not found" },
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
      operationId: "getConnectedAccounts",
      description:
        "Returns linked sign-in providers (EMAIL, GOOGLE, APPLE) with connection status. When auth-service is unavailable, may return a cached copy or omit providers (`accountStatus`).",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      responses: {
        "200": {
          description: "Connected accounts / linked providers",
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
              example: {
                success: true,
                message: "Connected accounts retrieved",
                data: {
                  providers: [
                    {
                      provider: "EMAIL",
                      connected: true,
                      providerUserId: "john@example.com",
                      providerEmail: "john@example.com",
                      linkedAt: "2026-06-20T10:00:00.000Z",
                    },
                    {
                      provider: "GOOGLE",
                      connected: true,
                      providerUserId: "1234567890",
                      providerEmail: "john@gmail.com",
                      linkedAt: "2026-06-21T10:00:00.000Z",
                    },
                    {
                      provider: "APPLE",
                      connected: false,
                      providerUserId: null,
                      providerEmail: null,
                      linkedAt: null,
                    },
                  ],
                  primaryAccount: "EMAIL",
                },
              },
            },
          },
        },
        "401": unauthorized,
      },
    },
  },
  "/users/profiles/me": {
    get: {
      tags: ["Users"],
      summary: "Get my profile",
      operationId: "getMyProfile",
      description:
        "Returns profile fields (bio, avatar, username, …). `avatarUrl` is a presigned GET URL — refresh via this endpoint before `avatarUrlExpiresIn` expires. For linked sign-in providers, use GET /users/accounts/me.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      responses: {
        "200": {
          description: "My profile",
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
              example: {
                success: true,
                message: "Profile retrieved",
                data: {
                  userId: "550e8400-e29b-41d4-a716-446655440000",
                  username: "johndoe",
                  firstName: "John",
                  lastName: "Doe",
                  bio: "Hello world!",
                  gender: "MALE",
                  dateOfBirth: "1995-03-15",
                  avatarUrl: "https://storage.example.com/avatars/john.jpg",
                  avatarUrlExpiresIn: 3600,
                  friendsCount: 42,
                  communitiesCount: 5,
                  isProfileCompleted: true,
                  createdAt: "2026-06-20T10:00:00.000Z",
                },
              },
            },
          },
        },
        "401": unauthorized,
        "404": {
          description: "Profile not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Profile not found",
                code: "PROFILE_NOT_FOUND",
              },
            },
          },
        },
      },
    },
    patch: {
      tags: ["Users"],
      summary: "Update my profile",
      operationId: "updateMyProfile",
      description:
        "Updates the authenticated user's profile (user id from access token). Username can only be changed once every 30 days. For avatars, upload via presigned URL first, then send `avatarObjectKey`.\n\n" +
        "**Username cooldown:** If the 30-day cooldown has not expired, the request returns 400 with `code: USERNAME_COOLDOWN`.\n\n" +
        "**Avatar flow:** Call `POST /api/v1/media/upload-url` with `category: USER_AVATAR`, PUT the file to the returned URL, then pass `objectKey` as `avatarObjectKey` here.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/UpdateProfileRequest" },
            examples: {
              basicUpdate: {
                summary: "Update name and bio",
                value: {
                  firstName: "Jonathan",
                  lastName: "Doe",
                  bio: "Senior developer at AIMess",
                },
              },
              withAvatar: {
                summary: "Update avatar",
                value: {
                  avatarObjectKey:
                    "avatars/550e8400-e29b-41d4-a716-446655440000/a1b2c3d4.jpg",
                },
              },
              changeUsername: {
                summary: "Change username (30-day cooldown applies)",
                value: { username: "john_new_handle" },
              },
            },
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
              example: {
                success: true,
                message: "Profile updated",
                data: {
                  userId: "550e8400-e29b-41d4-a716-446655440000",
                  username: "johndoe",
                  firstName: "Jonathan",
                  lastName: "Doe",
                  bio: "Senior developer at AIMess",
                  gender: "MALE",
                  dateOfBirth: "1995-03-15",
                  avatarUrl: "https://storage.example.com/avatars/john.jpg",
                  avatarUrlExpiresIn: 3600,
                  friendsCount: 42,
                  communitiesCount: 5,
                  isProfileCompleted: true,
                  createdAt: "2026-06-20T10:00:00.000Z",
                },
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
              examples: {
                usernameCooldown: {
                  summary: "Username change cooldown active",
                  value: {
                    success: false,
                    message:
                      "Username can only be changed once every 30 days. Next change available in 18 days.",
                    code: "USERNAME_COOLDOWN",
                  },
                },
                avatarNotUploaded: {
                  summary: "Avatar object key not found in storage",
                  value: {
                    success: false,
                    message:
                      "Avatar file not found. Upload it first via POST /media/upload-url.",
                    code: "AVATAR_NOT_UPLOADED",
                  },
                },
              },
            },
          },
        },
        "401": unauthorized,
        "404": notFound,
        "409": {
          description: "Username already taken",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Username already taken",
                code: "USERNAME_TAKEN",
              },
            },
          },
        },
      },
    },
  },
} as const;
