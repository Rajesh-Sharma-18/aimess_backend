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
        {
          name: "excludeGroupRoomId",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            '"Add Members" picker for a GROUP. Every ACTIVE member of this room is removed from the result set BEFORE pagination, so an existing member can never be offered and `total`/`hasNext` count only addable users. Combinable with `excludeCommunityId`. Unknown/inaccessible ids simply exclude nobody.',
          example: "grp_8f2c1a...",
        },
        {
          name: "excludeCommunityId",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            '"Add Members" picker for a COMMUNITY. Same semantics as `excludeGroupRoomId`, against the community\'s ACTIVE roster.',
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
    get: {
      tags: ["Users"],
      summary: "Check username availability (query param)",
      operationId: "validateUsernameQuery",
      description:
        "Requires access token. Same behavior as the POST variant, exposed as GET for client-side debounced availability checks. Returns whether the username is available (your current username counts as available). Usernames are stored lowercase; checks are case-insensitive.\n\n" +
        "**Validation rules:** 3–32 characters, alphanumeric + underscore only (`^[a-zA-Z0-9_]+$`).",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "username",
          in: "query",
          required: true,
          schema: { type: "string", minLength: 3, maxLength: 32 },
          description: "Username to check.",
          example: "john_doe_99",
        },
      ],
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
  "/users/friends/auto-disconnect": {
    post: {
      tags: ["Users"],
      summary: "Auto-disconnect caller from all accepted friends",
      operationId: "autoDisconnectFriends",
      description:
        "Removes (UNFRIENDS) every **ACCEPTED** friendship the authenticated user currently has — the bulk mirror of `DELETE /users/friends/{userId}` applied to all friends at once.\n\n" +
        "**Idempotency**: calling this endpoint again after all friends are already disconnected returns `totalFriends: 0, friendsDisconnected: 0` — safe to call repeatedly.\n\n" +
        "**Side effects**: for every removed friendship, a `friend.unfriended` event is published via RabbitMQ (same event manual unfriend publishes) and `friendsCount` is decremented on both user profiles. Private conversations, messages, community memberships, and block relationships are **not** affected — only the friendship rows are removed.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      responses: {
        "200": {
          description: "Auto-disconnect summary",
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
                          "totalFriends",
                          "friendsDisconnected",
                          "friends",
                        ],
                        properties: {
                          totalFriends: {
                            type: "integer",
                            description:
                              "ACCEPTED friendships found for the caller before disconnecting.",
                            example: 12,
                          },
                          friendsDisconnected: {
                            type: "integer",
                            description:
                              "Friendships actually flipped to UNFRIENDED in this call.",
                            example: 12,
                          },
                          friends: {
                            type: "array",
                            items: { type: "string", format: "uuid" },
                            description: "userIds of every friend removed.",
                          },
                        },
                      },
                    },
                  },
                ],
              },
              example: {
                success: true,
                message: "Auto-disconnect completed.",
                data: {
                  totalFriends: 12,
                  friendsDisconnected: 12,
                  friends: ["660e8400-e29b-41d4-a716-446655440001"],
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
  "/users/friends/status/{userId}": {
    get: {
      tags: ["Users"],
      summary: "Get friendship status with a user",
      operationId: "getFriendshipStatus",
      description:
        "Returns the current friendship lifecycle state between the caller and `userId`, including action flags (`canAccept` / `canReject` / `canCancel`). Use before showing Add Friend / Accept / Cancel buttons on a profile.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "userId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Friendship status",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/FriendshipStatusView",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
      },
    },
  },
  "/users/friends/blocked": {
    get: {
      tags: ["Users"],
      summary: "List blocked users",
      operationId: "getBlockedUsers",
      description:
        "Returns the list of users the caller has blocked, newest first. Each entry includes profile info and the block timestamp.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      responses: {
        "200": {
          description: "Blocked users list.",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            userId: {
                              type: "string",
                              format: "uuid",
                            },
                            username: {
                              type: "string",
                              nullable: true,
                            },
                            firstName: {
                              type: "string",
                              nullable: true,
                            },
                            lastName: {
                              type: "string",
                              nullable: true,
                            },
                            avatarUrl: {
                              allOf: [
                                { $ref: "#/components/schemas/MediaObject" },
                              ],
                              nullable: true,
                              description:
                                "Resolved avatar media object — read `downloadUrl`.",
                            },
                            blockedAt: {
                              type: "string",
                              format: "date-time",
                            },
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
        "401": unauthorized,
      },
    },
  },
  "/users/friends/block/{userId}": {
    post: {
      tags: ["Users"],
      summary: "Block a user",
      operationId: "blockUser",
      description:
        "Blocks `userId`. Ends any active friendship and prevents further friend requests / messaging discovery as enforced by user-service. Idempotent when already blocked. Cannot block yourself.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "userId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "User blocked (`data` is null).",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
            },
          },
        },
        "400": _badRequest,
        "401": unauthorized,
      },
    },
    delete: {
      tags: ["Users"],
      summary: "Unblock a user",
      operationId: "unblockUser",
      description:
        "Removes a block on `userId`. Does not restore a prior friendship — the other user must send a new friend request.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "userId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "User unblocked (`data` is null).",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
            },
          },
        },
        "401": unauthorized,
        "404": {
          description: "No block exists for this user",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/users/{userId}": {
    get: {
      tags: ["Users"],
      summary: "Get a user's public profile",
      operationId: "getPublicUserProfile",
      description:
        "Viewer-scoped public profile for `userId`. Bio and social counts may be null when privacy settings hide them from the caller. Returns 404 when the user is missing, deleted, or blocked in either direction.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "userId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Public profile",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/PublicUserProfileData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
        "404": {
          description: "User not found, deleted, or blocked",
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
  "/users/settings/call-allowed-friends": {
    get: {
      tags: ["Users"],
      summary: "List friends allowed to call me",
      operationId: "listCallAllowedFriends",
      description:
        "Cursor-paginated list of friends on the call allow-list (used when call visibility is CUSTOM). `cursor` is the previous page's `nextCursor` (CallAllowedFriend row id).",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "cursor",
          in: "query",
          required: false,
          schema: { type: "string", format: "uuid" },
          description: "Opaque page cursor from the previous response.",
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 100, default: 30 },
        },
      ],
      responses: {
        "200": {
          description: "Allow-list page",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/CallAllowedFriendsPage",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
      },
    },
  },
  "/users/settings/call-allowed-friends/{friendId}": {
    put: {
      tags: ["Users"],
      summary: "Add a friend to the call allow-list",
      operationId: "addCallAllowedFriend",
      description:
        "Adds an accepted friend to the call allow-list. Idempotent if already listed. `friendId` must be an ACCEPTED friend.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "friendId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Friend added (`data` is null).",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
            },
          },
        },
        "400": _badRequest,
        "401": unauthorized,
        "404": {
          description: "Friend not found / not an accepted friend",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
    delete: {
      tags: ["Users"],
      summary: "Remove a friend from the call allow-list",
      operationId: "removeCallAllowedFriend",
      description: "Removes `friendId` from the call allow-list. Idempotent.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "friendId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Friend removed (`data` is null).",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
            },
          },
        },
        "401": unauthorized,
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
  // ---------------------------------------------------------------------------
  // Recent Searches
  // ---------------------------------------------------------------------------
  "/users/recent-searches": {
    get: {
      tags: ["Users"],
      summary: "List recent searches",
      operationId: "listRecentSearches",
      deprecated: true,
      description:
        "**Deprecated** — use `GET /users/search` with no `q` (or a blank `q`) instead; it now returns `{ recent: [...] }`.\n\n" +
        "Returns the caller's last 10 recent searches, newest first.\n\n" +
        "Each entry is one of two shapes:\n" +
        "- **USER** — the caller tapped on a user's profile. Contains a `user` object with profile data.\n" +
        "- **QUERY** — the caller typed a search term. Contains a `query` string.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      responses: {
        "200": {
          description: "Recent search list",
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
                        properties: {
                          searches: {
                            type: "array",
                            items: {
                              $ref: "#/components/schemas/RecentSearchEntry",
                            },
                          },
                        },
                        required: ["searches"],
                      },
                    },
                  },
                ],
              },
              example: {
                success: true,
                message: "Success",
                data: {
                  searches: [
                    {
                      id: "aabbccdd-0000-4000-8000-aabbccdd0001",
                      type: "USER",
                      user: {
                        userId: "660e8400-e29b-41d4-a716-446655440001",
                        username: "janedoe",
                        firstName: "Jane",
                        lastName: "Doe",
                        bio: null,
                        avatarUrl: null,
                        avatarUrlExpiresIn: null,
                        isOnline: false,
                      },
                      createdAt: "2026-07-07T10:00:00.000Z",
                    },
                    {
                      id: "aabbccdd-0000-4000-8000-aabbccdd0002",
                      type: "QUERY",
                      query: "john doe",
                      createdAt: "2026-07-07T09:30:00.000Z",
                    },
                  ],
                },
              },
            },
          },
        },
        "401": unauthorized,
      },
    },
    post: {
      tags: ["Users"],
      summary: "Record a recent search",
      operationId: "recordRecentSearch",
      description:
        "Records a recent search for the caller. Provide **either** `searchedUserId` (when the user taps a profile) **or** `query` (when the user types a search term). " +
        "Duplicate entries for the same user/query are de-duplicated and bumped to the top. " +
        "The list is capped at 10; the oldest entry is pruned automatically.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/RecordRecentSearchBody" },
            examples: {
              userTap: {
                summary: "User profile tap",
                value: {
                  searchedUserId: "660e8400-e29b-41d4-a716-446655440001",
                },
              },
              textQuery: {
                summary: "Text query",
                value: { query: "john doe" },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Search recorded",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
              example: { success: true, message: "Success", data: null },
            },
          },
        },
        "400": {
          description:
            "Neither searchedUserId nor query provided, or invalid UUID",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Provide either searchedUserId or query",
              },
            },
          },
        },
        "401": unauthorized,
      },
    },
    delete: {
      tags: ["Users"],
      summary: "Clear all recent searches",
      operationId: "clearRecentSearches",
      description: "Deletes all recent search entries for the caller.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      responses: {
        "200": {
          description: "All entries cleared",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
              example: { success: true, message: "Success", data: null },
            },
          },
        },
        "401": unauthorized,
      },
    },
  },

  "/users/recent-searches/{id}": {
    delete: {
      tags: ["Users"],
      summary: "Delete a single recent search",
      operationId: "deleteRecentSearch",
      description:
        "Removes one recent search entry by ID. Returns 404 if the entry does not exist or belongs to another user.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          description: "ID of the recent search entry to delete.",
        },
      ],
      responses: {
        "200": {
          description: "Entry deleted",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
              example: { success: true, message: "Success", data: null },
            },
          },
        },
        "404": notFound,
        "401": unauthorized,
      },
    },
  },

  "/users/search": {
    get: {
      tags: ["Users"],
      summary: "Unified User Search (Recent / Chat / Other)",
      operationId: "searchUsers2",
      description:
        "Single entry point for the search experience. The response shape depends on `q`:\n\n" +
        "- **`q` empty, missing, or whitespace-only** — runs no search logic. Returns only `{ recent: [...] }`: up to 4 recently viewed Users/Groups (from `POST /users/search/recent`), newest-viewed first. `roomId` is resolved dynamically (never stored).\n" +
        "- **`q` has a value** — returns only `{ chat: [...], other: [...] }` (no `recent`):\n" +
        "  - **chat** — up to `limit` (default 10) results: private Users you already have a room with, and Groups you actively belong to, filtered by `q`.\n" +
        "  - **other** — up to `limit` (default 10, paginated via `page`) results: Users without an existing room, and Groups you are not an active member of, filtered by `q`. Excludes anything already in `chat`.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "q",
          in: "query",
          required: false,
          schema: { type: "string", maxLength: 100 },
          description: "Search term applied to Recent, Chat, and Other.",
          example: "jane",
        },
        {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, default: 1 },
          description: "Paginates the `other` section only.",
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 10, default: 10 },
          description:
            "Caps the `chat` and `other` sections (max 10 per spec).",
        },
      ],
      responses: {
        "200": {
          description: "Recent / Chat / Other search results",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/UserSearchData" },
                    },
                  },
                ],
              },
              examples: {
                blankQuery: {
                  summary: "q empty/missing — Recent only",
                  value: {
                    success: true,
                    message: "Users retrieved successfully.",
                    data: {
                      recent: [
                        {
                          type: "USER",
                          userId: "660e8400-e29b-41d4-a716-446655440001",
                          username: "janedoe",
                          firstName: "Jane",
                          lastName: "Doe",
                          fullName: "Jane Doe",
                          avatarUrl: null,
                          avatarUrlExpiresIn: null,
                          avatar: { url: null, expiresIn: null },
                          isOnline: false,
                          roomId: "room_abc123",
                        },
                        {
                          type: "GROUP",
                          roomId: "room_group456",
                          name: "Weekend Hikers",
                          avatar: "",
                          description: "",
                          memberCount: 12,
                          isActiveMember: true,
                        },
                      ],
                    },
                  },
                },
                withQuery: {
                  summary: "q has a value — Chat + Other only",
                  value: {
                    success: true,
                    message: "Users retrieved successfully.",
                    data: {
                      chat: [
                        {
                          type: "USER",
                          userId: "880e8400-e29b-41d4-a716-446655440003",
                          username: "bobsmith",
                          firstName: "Bob",
                          lastName: "Smith",
                          fullName: "Bob Smith",
                          avatarUrl: null,
                          avatarUrlExpiresIn: null,
                          avatar: { url: null, expiresIn: null },
                          isOnline: true,
                          roomId: "room_def789",
                        },
                      ],
                      other: [
                        {
                          type: "USER",
                          userId: "990e8400-e29b-41d4-a716-446655440004",
                          username: "alicew",
                          firstName: "Alice",
                          lastName: "White",
                          fullName: "Alice White",
                          avatarUrl: null,
                          avatarUrlExpiresIn: null,
                          avatar: { url: null, expiresIn: null },
                          isOnline: false,
                          roomId: null,
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
        "400": _badRequest,
        "401": unauthorized,
      },
    },
  },

  "/users/search/recent": {
    post: {
      tags: ["Users"],
      summary: "Record a recently viewed User/Group",
      operationId: "recordRecentUserSearch",
      description:
        "Upserts a recently-viewed User or Group by `(caller, targetType, targetId)`. " +
        "If the target was already recorded, only `lastViewedAt` is bumped (no duplicate row). " +
        "The list is capped at 20 entries per user; the oldest entries beyond the cap are pruned automatically. " +
        "`roomId` is never accepted or stored here — it is always resolved dynamically by `GET /users/search`.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/RecordRecentUserSearchBody",
            },
            examples: {
              user: {
                summary: "Viewed a user profile",
                value: {
                  targetType: "USER",
                  targetId: "660e8400-e29b-41d4-a716-446655440001",
                },
              },
              group: {
                summary: "Viewed a group",
                value: { targetType: "GROUP", targetId: "room_group456" },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Recorded",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
              example: {
                success: true,
                message: "Recently viewed item saved.",
                data: null,
              },
            },
          },
        },
        "400": _badRequest,
        "401": unauthorized,
      },
    },
    delete: {
      tags: ["Users"],
      summary: "Clear all recently viewed User/Group entries",
      operationId: "clearRecentUserSearches",
      description:
        "Deletes every recently-viewed User/Group row for the caller. Idempotent when already empty.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      responses: {
        "200": {
          description: "Cleared (`data` is null).",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
            },
          },
        },
        "401": unauthorized,
      },
    },
  },
  "/users/search/recent/{targetId}": {
    delete: {
      tags: ["Users"],
      summary: "Remove one recently viewed User/Group",
      operationId: "removeRecentUserSearch",
      description:
        "Deletes a single recently-viewed row for `(caller, targetType, targetId)`. Defaults `targetType` to `USER` when omitted. Returns 404 if no matching row exists.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "targetId",
          in: "path",
          required: true,
          schema: { type: "string", minLength: 1, maxLength: 64 },
        },
        {
          name: "targetType",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["USER", "GROUP"], default: "USER" },
        },
      ],
      responses: {
        "200": {
          description: "Removed (`data` is null).",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
            },
          },
        },
        "401": unauthorized,
        "404": {
          description: "No matching recent-search row",
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
