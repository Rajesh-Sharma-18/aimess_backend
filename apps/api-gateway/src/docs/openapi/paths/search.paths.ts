const unauthorized = {
  description: "Missing or invalid access token",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
    },
  },
};

const badRequest = {
  description:
    "`VALIDATION_FAILED` (bad `q` / `filter` / `limit`) or `INVALID_CURSOR` (the cursor could not be read, or a leg rejected the one it was handed)",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
      example: {
        success: false,
        message: "The pagination cursor is not valid. Please start the search again.",
        code: "INVALID_CURSOR",
      },
    },
  },
};

const forbidden = {
  description:
    "A downstream refused the caller — relayed with its own code (e.g. `ACCOUNT_BANNED`) rather than collapsed into a 401",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
      example: {
        success: false,
        message: "Your account has been banned.",
        code: "ACCOUNT_BANNED",
      },
    },
  },
};

const serviceUnavailable = {
  description: "`SEARCH_UNAVAILABLE` — every leg this request called failed",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
    },
  },
};

const searchItem = {
  type: "object" as const,
  description:
    "Discriminated on `type`. The category row is passed through verbatim from the service that owns it.",
  required: ["type", "id"],
  properties: {
    type: {
      type: "string" as const,
      enum: ["message", "community", "person"],
    },
    id: {
      type: "string" as const,
      description:
        "`messageId` for a message, community id for a community, `userId` (or `roomId` for a group) for a person.",
    },
    message: {
      type: "object" as const,
      description:
        "`type: \"message\"` only — chat-service `MessageSearchHit`. `(roomId, conversationType)` is the pair `GET /chat/messages/{messageId}/context` takes, so a hit is directly navigable.",
      additionalProperties: true,
    },
    community: {
      type: "object" as const,
      description:
        "`type: \"community\"` only — community-service `CommunityDiscoverItem`.",
      additionalProperties: true,
    },
    bucket: {
      type: "string" as const,
      enum: ["chat", "other"],
      description:
        "`type: \"person\"` only. `chat` is the bounded head (friends and active groups, first page only); `other` is the cursor-paged remainder.",
    },
    person: {
      type: "object" as const,
      description:
        "`type: \"person\"` only — user-service `SearchResultItem` (`SearchUserItem` | `SearchGroupItem`).",
      additionalProperties: true,
    },
  },
};

export const searchPaths = {
  "/search": {
    get: {
      tags: ["Search"],
      operationId: "globalSearch",
      summary: "Unified search (messages, communities, people)",
      description: [
        "ONE cursor-paginated request per search term. `filter` selects which downstream legs run,",
        "so a single-category tab costs exactly one downstream call and `all` fans out to three in",
        "parallel — each with the caller's own bearer token, so every downstream permission gate",
        "still applies.",
        "",
        "**Ordering** is fixed by section (message, then community, then person). There is no",
        "relevance score anywhere on this platform, so results are deterministic-by-source rather",
        "than ranked.",
        "",
        "**`all` quotas** with limit `L`: messages `ceil(L/2)`, communities `ceil(L/4)`, people",
        "`floor(L/4)`, minimum 1 each — no category can consume the page. The people leg's `chat`",
        "head (friends + active groups, first page only) rides along on top of its quota because no",
        "later page can return those rows again.",
        "",
        "**Cursors are opaque.** Feed `pagination.nextCursor` back verbatim and stop when",
        "`pagination.hasMore` is false. For a single `filter` the value is that leg's own cursor;",
        "for `all` it is a composite wrapping the three, where each leg advances independently and",
        "an exhausted leg stays exhausted. A cursor this endpoint cannot read is a 400",
        "`INVALID_CURSOR` — never a silent first page.",
        "",
        "**Partial failure** is tolerated: a leg that fails contributes an empty category and is",
        "retried on the next page. Only when every leg called by this request fails is the answer",
        "503. A downstream 403 is relayed as 403 with its own code (so a banned account still gets",
        "`ACCOUNT_BANNED`); a downstream 401 is relayed as 401.",
        "",
        "**Rate limit:** shares the `search` bucket (60/min per session by default).",
      ].join("\n"),
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "q",
          in: "query" as const,
          required: true,
          schema: { type: "string" as const, minLength: 1, maxLength: 100 },
          description: "Search term. Trimmed; 1-100 characters.",
          example: "john",
        },
        {
          name: "filter",
          in: "query" as const,
          required: false,
          schema: {
            type: "string" as const,
            enum: ["all", "message", "community", "people"],
            default: "all",
          },
          description:
            "Which legs to run. Anything but `all` issues exactly one downstream call and gives that leg the whole `limit`.",
          example: "all",
        },
        {
          name: "cursor",
          in: "query" as const,
          required: false,
          schema: { type: "string" as const, maxLength: 2048 },
          description:
            "Opaque continuation token from a previous `pagination.nextCursor`. Never construct one.",
        },
        {
          name: "limit",
          in: "query" as const,
          required: false,
          schema: {
            type: "integer" as const,
            minimum: 1,
            maximum: 50,
            default: 20,
          },
          description: "Page size. Split across the legs when `filter=all`.",
          example: 20,
        },
      ],
      responses: {
        "200": {
          description: "One page of results",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object" as const,
                    properties: {
                      data: {
                        type: "object" as const,
                        required: [
                          "pagination",
                          "data",
                          "hasMore",
                          "nextCursor",
                        ],
                        properties: {
                          pagination: {
                            type: "object" as const,
                            properties: {
                              totalData: {
                                type: "integer" as const,
                                description:
                                  "Rows on THIS page. Not a corpus total — never derive a page count from it.",
                              },
                              totalPage: {
                                type: "integer" as const,
                                description:
                                  "Always 1. Meaningless in cursor mode.",
                              },
                              currentPage: {
                                type: "integer" as const,
                                description:
                                  "Always 1. Meaningless in cursor mode.",
                              },
                              limit: { type: "integer" as const },
                              nextCursor: {
                                type: "string" as const,
                                nullable: true,
                              },
                              hasMore: { type: "boolean" as const },
                            },
                          },
                          data: {
                            type: "array" as const,
                            items: searchItem,
                          },
                          hasMore: {
                            type: "boolean" as const,
                            description: "Mirror of `pagination.hasMore`.",
                          },
                          nextCursor: {
                            type: "string" as const,
                            nullable: true,
                            description: "Mirror of `pagination.nextCursor`.",
                          },
                        },
                      },
                    },
                  },
                ],
              },
              example: {
                success: true,
                message: "Search results fetched",
                data: {
                  pagination: {
                    totalData: 3,
                    totalPage: 1,
                    currentPage: 1,
                    limit: 20,
                    nextCursor: "eyJ2IjoxLCJtIjoiMTc4MjEzMzEwNzUyMV81MDdmMWY3N2JjZjg2Y2Q3OTk0MzkwMTEiLCJjIjpudWxsLCJwIjpudWxsfQ",
                    hasMore: true,
                  },
                  data: [
                    {
                      type: "message",
                      id: "507f1f77bcf86cd799439011",
                      message: {
                        messageId: "507f1f77bcf86cd799439011",
                        conversationType: "GROUP",
                        roomId: "grp_1",
                        conversationName: "Johnson Family",
                        senderName: "Mary",
                        text: "john is here",
                        createdAt: "2026-09-07T10:31:47.521Z",
                      },
                    },
                    {
                      type: "community",
                      id: "68b0f1c2a4d3e5f6a7b8c9d0",
                      community: {
                        id: "68b0f1c2a4d3e5f6a7b8c9d0",
                        name: "Johns Club",
                        handle: "johns_club",
                      },
                    },
                    {
                      type: "person",
                      id: "u1",
                      bucket: "chat",
                      person: { type: "USER", userId: "u1", username: "john" },
                    },
                  ],
                  hasMore: true,
                  nextCursor: "eyJ2IjoxLCJtIjoiMTc4MjEzMzEwNzUyMV81MDdmMWY3N2JjZjg2Y2Q3OTk0MzkwMTEiLCJjIjpudWxsLCJwIjpudWxsfQ",
                },
              },
            },
          },
        },
        "400": badRequest,
        "401": unauthorized,
        "403": forbidden,
        "503": serviceUnavailable,
      },
    },
  },
};
