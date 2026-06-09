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

const forbidden = {
  description: "Forbidden — not a member or insufficient role",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
    },
  },
};

const notFound = {
  description: "Resource not found",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
    },
  },
};

const conflict = {
  description: "Conflict — e.g. message already pinned",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
    },
  },
};

function ok(description: string, exampleSchema?: Record<string, unknown>) {
  return {
    "200": {
      description,
      content: {
        "application/json": {
          schema: exampleSchema ?? {
            $ref: "#/components/schemas/ApiSuccessResponse",
          },
        },
      },
    },
  };
}

function created(description: string) {
  return {
    "201": {
      description,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
        },
      },
    },
  };
}

const roomIdParam = {
  name: "roomId",
  in: "path" as const,
  required: true,
  schema: { type: "string" as const },
  description: "Room / conversation ID",
};

const messageIdParam = {
  name: "messageId",
  in: "path" as const,
  required: true,
  schema: { type: "string" as const },
  description: "Message ID",
};

const limitParam = {
  name: "limit",
  in: "query" as const,
  required: false,
  schema: { type: "integer" as const, minimum: 1, maximum: 100, default: 30 },
};

/** Seq-based keyset pagination params (gap-safe cursors) */
function seqPaginationParams() {
  return [
    {
      name: "before_seq",
      in: "query" as const,
      required: false,
      schema: { type: "integer" as const, minimum: 0 },
      description:
        "Return messages with sequenceNumber < before_seq (newest-first, gap-safe). Mutually exclusive with after_seq and around.",
    },
    {
      name: "after_seq",
      in: "query" as const,
      required: false,
      schema: { type: "integer" as const, minimum: 0 },
      description:
        "Return messages with sequenceNumber > after_seq (oldest-first, gap-safe). Mutually exclusive with before_seq and around.",
    },
    {
      name: "around",
      in: "query" as const,
      required: false,
      schema: { type: "string" as const },
      description:
        "Message ID to center the fetch around — returns limit/2 messages before and after. Mutually exclusive with before_seq and after_seq.",
    },
    {
      name: "before_ts",
      in: "query" as const,
      required: false,
      schema: { type: "integer" as const, minimum: 1 },
      description:
        "V1 fallback: epoch ms. Use before_seq / after_seq instead for gap-safe pagination.",
    },
    {
      name: "after_ts",
      in: "query" as const,
      required: false,
      schema: { type: "integer" as const, minimum: 1 },
      description: "V1 fallback: epoch ms. See before_ts note.",
    },
  ];
}

// --------------------------------------------------------------------------
// GET /chat/private/rooms/{roomId}/messages
// --------------------------------------------------------------------------
const privateMessages = {
  get: {
    tags: ["Chat — Private"],
    summary: "List private messages (seq pagination)",
    description: [
      "Returns a page of messages for a 1-to-1 conversation.",
      "",
      "**Seq pagination (preferred — gap-safe):** supply `before_seq`, `after_seq`, or `around`.",
      "**Timestamp fallback:** supply `before_ts` / `after_ts` (epoch ms) — still honoured.",
      "",
      "Exactly one of `before_seq`, `after_seq`, `around`, or neither (latest page) should be supplied.",
    ].join("\n"),
    security: [{ bearerAuth: [] }],
    parameters: [roomIdParam, limitParam, ...seqPaginationParams()],
    responses: {
      ...ok("Messages page", {
        allOf: [
          { $ref: "#/components/schemas/ApiSuccessResponse" },
          {
            type: "object" as const,
            properties: {
              data: {
                type: "object" as const,
                properties: {
                  data: {
                    type: "array" as const,
                    items: { $ref: "#/components/schemas/ChatMessage" },
                  },
                  total: { type: "integer" as const },
                  hasMore: { type: "boolean" as const },
                  nextCursor: {
                    oneOf: [
                      { type: "integer" as const },
                      { type: "null" as const },
                    ],
                    description:
                      "Next sequenceNumber cursor, or null when no more pages.",
                  },
                },
              },
            },
          },
        ],
      }),
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

// --------------------------------------------------------------------------
// POST/DELETE /chat/private/rooms/{roomId}/messages/{messageId}/pin
// --------------------------------------------------------------------------
const privatePinMessage = {
  post: {
    tags: ["Chat — Private"],
    summary: "Pin a private message",
    description:
      "Pins `messageId` in the conversation. Broadcasts `pin:updated` (action: `pinned`) to the `conv:<roomId>` Socket.IO room. Returns 409 if already pinned.",
    security: [{ bearerAuth: [] }],
    parameters: [roomIdParam, messageIdParam],
    responses: {
      ...created("Message pinned"),
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
      "409": conflict,
    },
  },
  delete: {
    tags: ["Chat — Private"],
    summary: "Unpin a private message",
    description:
      "Unpins `messageId`. Broadcasts `pin:updated` (action: `unpinned`) to the `conv:<roomId>` Socket.IO room.",
    security: [{ bearerAuth: [] }],
    parameters: [roomIdParam, messageIdParam],
    responses: {
      ...ok("Message unpinned"),
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

// --------------------------------------------------------------------------
// GET /chat/groups/{roomId}/messages
// --------------------------------------------------------------------------
const groupMessages = {
  get: {
    tags: ["Chat — Groups"],
    summary: "List group messages (seq pagination)",
    description: [
      "Returns a page of messages for a group room.",
      "",
      "**Seq pagination (preferred — gap-safe):** supply `before_seq`, `after_seq`, or `around`.",
      "**Timestamp fallback:** supply `before_ts` / `after_ts` (epoch ms) — still honoured.",
    ].join("\n"),
    security: [{ bearerAuth: [] }],
    parameters: [roomIdParam, limitParam, ...seqPaginationParams()],
    responses: {
      ...ok("Messages page", {
        allOf: [
          { $ref: "#/components/schemas/ApiSuccessResponse" },
          {
            type: "object" as const,
            properties: {
              data: {
                type: "object" as const,
                properties: {
                  data: {
                    type: "array" as const,
                    items: { $ref: "#/components/schemas/ChatMessage" },
                  },
                  total: { type: "integer" as const },
                  hasMore: { type: "boolean" as const },
                  nextCursor: {
                    oneOf: [
                      { type: "integer" as const },
                      { type: "null" as const },
                    ],
                    description:
                      "Next sequenceNumber cursor, or null when no more pages.",
                  },
                },
              },
            },
          },
        ],
      }),
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

// --------------------------------------------------------------------------
// POST/DELETE /chat/groups/{roomId}/messages/{messageId}/pin
// --------------------------------------------------------------------------
const groupPinMessage = {
  post: {
    tags: ["Chat — Groups"],
    summary: "Pin a group message",
    description:
      "Pins `messageId` in the group room. Broadcasts `pin:updated` (action: `pinned`) to `conv:<roomId>`. Only members with sufficient role may pin. Returns 409 if already pinned.",
    security: [{ bearerAuth: [] }],
    parameters: [roomIdParam, messageIdParam],
    responses: {
      ...created("Message pinned"),
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
      "409": conflict,
    },
  },
  delete: {
    tags: ["Chat — Groups"],
    summary: "Unpin a group message",
    description:
      "Unpins `messageId`. Broadcasts `pin:updated` (action: `unpinned`) to `conv:<roomId>`.",
    security: [{ bearerAuth: [] }],
    parameters: [roomIdParam, messageIdParam],
    responses: {
      ...ok("Message unpinned"),
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

// --------------------------------------------------------------------------
// GET /chat/sync
// --------------------------------------------------------------------------
const chatSync = {
  get: {
    tags: ["Chat — Private", "Chat — Groups"],
    summary: "Incremental conversation sync",
    description: [
      "Returns all events (sent messages, edits, deletes, reactions, pins) for a **single conversation** with `sequenceNumber > from_seq`.",
      "",
      "Use this after reconnection or app-resume to fill any gaps without re-fetching the full message list.",
      "",
      "**Gap detection:** if the first event returned has `sequenceNumber > from_seq + 1`, messages were missed — clients should backfill with the messages endpoint.",
      "",
      "The response's `next_seq` should be persisted locally as the new `from_seq` for the next catchup call.",
    ].join("\n"),
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "conv_id",
        in: "query" as const,
        required: true,
        schema: { type: "string" as const },
        description: "Room / conversation ID to sync.",
      },
      {
        name: "from_seq",
        in: "query" as const,
        required: true,
        schema: { type: "integer" as const, minimum: 0 },
        description:
          "Return events with sequenceNumber > from_seq. Pass 0 to get all events (up to limit).",
      },
      {
        name: "limit",
        in: "query" as const,
        required: false,
        schema: {
          type: "integer" as const,
          minimum: 1,
          maximum: 200,
          default: 50,
        },
        description: "Maximum number of events to return.",
      },
      {
        name: "type",
        in: "query" as const,
        required: false,
        schema: {
          type: "string" as const,
          enum: ["private", "group"],
          default: "private",
        },
        description: "Conversation type. Determines which room model to query.",
      },
    ],
    responses: {
      ...ok("Sync events", {
        allOf: [
          { $ref: "#/components/schemas/ApiSuccessResponse" },
          {
            type: "object" as const,
            properties: {
              data: {
                type: "object" as const,
                properties: {
                  events: {
                    type: "array" as const,
                    description: "Events ordered by sequenceNumber ASC.",
                    items: {
                      type: "object" as const,
                      properties: {
                        type: {
                          type: "string" as const,
                          enum: [
                            "message",
                            "edit",
                            "delete",
                            "reaction",
                            "pin",
                          ],
                        },
                        sequenceNumber: { type: "integer" as const },
                        data: { type: "object" as const },
                      },
                    },
                  },
                  next_seq: {
                    type: "integer" as const,
                    description:
                      "Highest sequenceNumber returned. Persist as from_seq for the next call.",
                  },
                  has_more: {
                    type: "boolean" as const,
                    description:
                      "True when more events exist beyond this page.",
                  },
                  conversationType: {
                    type: "string" as const,
                    enum: ["private", "group"],
                  },
                },
              },
            },
          },
        ],
      }),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

export const chatExtrasPaths = {
  "/chat/private/rooms/{roomId}/messages": privateMessages,
  "/chat/private/rooms/{roomId}/messages/{messageId}/pin": privatePinMessage,
  "/chat/groups/{roomId}/messages": groupMessages,
  "/chat/groups/{roomId}/messages/{messageId}/pin": groupPinMessage,
  "/chat/sync": chatSync,
};
