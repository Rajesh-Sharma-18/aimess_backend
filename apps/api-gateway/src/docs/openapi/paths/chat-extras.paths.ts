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

/**
 * Request body for the REST send endpoints (private / group). roomId comes from
 * the path; the sender is the authenticated caller. `clientMessageId` is the
 * idempotency key (a repeated value collapses onto the original message — the
 * server then answers 200 instead of 201). For PRIVATE, `receiverId` (the peer)
 * is required by the friendship gate. The structured `content` mirrors the
 * canonical ChatMessage body.
 */
function sendMessageRequestBody(includeReceiverId: boolean) {
  const contentSchema = {
    type: "object" as const,
    properties: {
      text: {
        type: "string" as const,
        maxLength: 4000,
        description: "Plain-text body (max 4000 chars).",
      },
      urls: { type: "array" as const, items: { type: "string" as const } },
      files: {
        type: "array" as const,
        maxItems: 30,
        description:
          "Media files (objectKey + metadata). Send-time caps apply per messageType (see ChatMessage.content).",
        items: { type: "object" as const },
      },
      location: { $ref: "#/components/schemas/ChatLocationAttachment" },
      contact: { $ref: "#/components/schemas/ChatContactAttachment" },
      sticker: { $ref: "#/components/schemas/ChatSticker" },
    },
  };
  return {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object" as const,
          required: includeReceiverId
            ? ["receiverId", "content", "messageType"]
            : ["content", "messageType"],
          properties: {
            ...(includeReceiverId
              ? {
                  receiverId: {
                    type: "string" as const,
                    description: "The peer's user ID (PRIVATE only).",
                  },
                }
              : {}),
            content: contentSchema,
            messageType: {
              type: "string" as const,
              enum: [
                "TEXT",
                "IMAGE",
                "VIDEO",
                "AUDIO",
                "VOICE",
                "DOCUMENT",
                "GIF",
                "STICKER",
                "LOCATION",
                "CONTACT",
                "SYSTEM",
              ],
              description:
                "Canonical UPPER-CASE message kind (matches @aimess/constants CONTENT_TYPES).",
            },
            parentMessageId: {
              type: "string" as const,
              nullable: true,
              description: "ID of the message being replied to (quote/thread).",
            },
            clientMessageId: {
              type: "string" as const,
              description:
                "Idempotency key. A repeated value returns the original message with HTTP 200 (`idempotent: true`).",
            },
            clientTs: {
              type: "integer" as const,
              format: "int64",
              description: "Client compose time (epoch ms) — display only.",
            },
          },
        },
      },
    },
  };
}

/**
 * 201/200 responses for the REST send endpoints. The data payload is the
 * canonical wire message (`ChatWireMessage` — byte-identical to the Socket.IO
 * `message:new`, i.e. `buildChatMessageEvent` output with `serverTs`/`sentAt`
 * and no `createdAt`) plus an `idempotent` flag. 201 = freshly inserted;
 * 200 = idempotent replay.
 */
function sendMessageResponses() {
  const sentSchema = {
    allOf: [
      { $ref: "#/components/schemas/ApiSuccessResponse" },
      {
        type: "object" as const,
        properties: {
          data: {
            allOf: [
              { $ref: "#/components/schemas/ChatWireMessage" },
              {
                type: "object" as const,
                properties: {
                  idempotent: {
                    type: "boolean" as const,
                    description:
                      "True when this send collapsed onto a pre-existing message (replay).",
                  },
                },
              },
            ],
          },
        },
      },
    ],
  };
  return {
    "201": {
      description: "Message sent (fresh insert).",
      content: { "application/json": { schema: sentSchema } },
    },
    "200": {
      description:
        "Idempotent replay — `clientMessageId` matched an existing message; the original is returned with `idempotent: true`.",
      content: { "application/json": { schema: sentSchema } },
    },
  };
}

/**
 * Request body + responses for the REST mark-read endpoints. roomId comes from
 * the path; the reader is the authenticated caller. PRIVATE/GROUP advance the
 * read pointer to `upToMessageId` and return its `readToSeq` (the per-room
 * sequence high-water mark) — they also emit `message:read` to the conversation
 * and `read_sync` to the reader's other devices.
 */
const markReadRequestBody = {
  required: true,
  content: {
    "application/json": {
      schema: {
        type: "object" as const,
        required: ["upToMessageId"],
        properties: {
          upToMessageId: {
            type: "string" as const,
            minLength: 1,
            description: "Highest message ID the caller has now read.",
          },
        },
      },
    },
  },
};

function markReadResponse(includeReadToSeq: boolean) {
  return ok("Conversation marked read.", {
    allOf: [
      { $ref: "#/components/schemas/ApiSuccessResponse" },
      {
        type: "object" as const,
        properties: {
          data: {
            type: "object" as const,
            properties: {
              ok: { type: "boolean" as const, example: true },
              ...(includeReadToSeq
                ? {
                    readToSeq: {
                      type: "integer" as const,
                      description:
                        "Per-room sequenceNumber of upToMessageId (read high-water mark); 0 if unknown.",
                    },
                  }
                : {}),
            },
          },
        },
      },
    ],
  });
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
        "Message ID to center the fetch around — returns limit/2 messages before and after (ascending, INCLUDING the target). " +
        "Mutually exclusive with before_seq and after_seq. The response adds bidirectional continuation on top of the usual " +
        "timeline shape: `hasMoreOlder`/`hasMoreNewer` (booleans) and `olderCursor`/`newerCursor` — both are plain `sequenceNumber` " +
        "values you feed straight back as `before_seq` (older) / `after_seq` (newer). The legacy `hasMore`/`nextCursor` mirror the OLDER direction.",
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
    operationId: "listPrivateMessages",
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
  post: {
    tags: ["Chat — Private"],
    operationId: "sendPrivateMessage",
    summary: "Send a private message",
    description:
      "Sends a message into the private room. The server broadcasts `message:new` to the `conv:<roomId>` Socket.IO room, bumps the conversation to the top of both inboxes, and triggers an FCM/APNs push to the peer. Requires friendship. Idempotent via `clientMessageId` (a replay answers 200 with `idempotent: true`).",
    security: [{ bearerAuth: [] }],
    parameters: [roomIdParam],
    requestBody: sendMessageRequestBody(true),
    responses: {
      ...sendMessageResponses(),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

// --------------------------------------------------------------------------
// POST /chat/private/rooms/{roomId}/read
// --------------------------------------------------------------------------
const privateMarkRead = {
  post: {
    tags: ["Chat — Private"],
    operationId: "markPrivateRead",
    summary: "Mark private conversation read",
    description:
      "Advances the caller's read pointer up to `upToMessageId`. Emits a `message:read` receipt to the `conv:<roomId>` Socket.IO room (the peer) and a `read_sync` to the caller's other devices. Returns the `readToSeq` high-water mark.",
    security: [{ bearerAuth: [] }],
    parameters: [roomIdParam],
    requestBody: markReadRequestBody,
    responses: {
      ...markReadResponse(true),
      "400": badRequest,
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
    operationId: "pinPrivateMessage",
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
    operationId: "unpinPrivateMessage",
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
    operationId: "listGroupMessages",
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
  post: {
    tags: ["Chat — Groups"],
    operationId: "sendGroupMessage",
    summary: "Send a group message",
    description:
      "Sends a message into the group room. The server broadcasts `message:new` to `conv:<roomId>`, bumps the conversation for every member's inbox, and fans out an FCM/APNs push to active members. Requires active membership. Idempotent via `clientMessageId` (a replay answers 200 with `idempotent: true`).",
    security: [{ bearerAuth: [] }],
    parameters: [roomIdParam],
    requestBody: sendMessageRequestBody(false),
    responses: {
      ...sendMessageResponses(),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

// --------------------------------------------------------------------------
// POST /chat/groups/{roomId}/read
// --------------------------------------------------------------------------
const groupMarkRead = {
  post: {
    tags: ["Chat — Groups"],
    operationId: "markGroupRead",
    summary: "Mark group read",
    description:
      "Advances the caller's group-member read pointer up to `upToMessageId`. Emits a `message:read` receipt to `conv:<roomId>` and a `read_sync` to the caller's other devices. Returns the `readToSeq` high-water mark.",
    security: [{ bearerAuth: [] }],
    parameters: [roomIdParam],
    requestBody: markReadRequestBody,
    responses: {
      ...markReadResponse(true),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

// --------------------------------------------------------------------------
// POST /chat/community/rooms/{roomId}/read
// --------------------------------------------------------------------------
const communityMarkRead = {
  post: {
    tags: ["Chat — Community"],
    operationId: "markCommunityRead",
    summary: "Mark community room read",
    description:
      "Marks the community room read for the caller. Community read is **coarser** than private/group: it advances the member's read pointer to *now* (read-to-now) rather than to a specific message, and emits **no** socket receipt. The body's `upToMessageId` is accepted for request parity but is not used as a per-message high-water mark.",
    security: [{ bearerAuth: [] }],
    parameters: [roomIdParam],
    requestBody: markReadRequestBody,
    responses: {
      ...markReadResponse(false),
      "400": badRequest,
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
    operationId: "pinGroupMessage",
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
    operationId: "unpinGroupMessage",
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
    operationId: "syncConversation",
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
  "/chat/private/rooms/{roomId}/read": privateMarkRead,
  "/chat/private/rooms/{roomId}/messages/{messageId}/pin": privatePinMessage,
  "/chat/groups/{roomId}/messages": groupMessages,
  "/chat/groups/{roomId}/read": groupMarkRead,
  "/chat/groups/{roomId}/messages/{messageId}/pin": groupPinMessage,
  "/chat/community/rooms/{roomId}/read": communityMarkRead,
  "/chat/sync": chatSync,
};
