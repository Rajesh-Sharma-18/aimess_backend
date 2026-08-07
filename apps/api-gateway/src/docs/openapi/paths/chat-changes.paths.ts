/**
 * Endpoints folded onto V1 when the parallel `/api/v2` surface was retired:
 *
 *   GET  /chat/{private,groups,community}/…/changes      — zero-loss changes feed
 *   POST /chat/{private,groups}/messages/{messageId}/react — single-write SET reaction
 *
 * Keys here are NEW — none of them collide with an existing v1 path item, so this
 * object is safe to spread alongside `chatPaths` / `chatExtrasPaths`. The
 * path-param group delete (`DELETE /chat/groups/messages/{messageId}`) is added to
 * the existing `groupMessageEdit` path item in `chat.paths.ts` instead, because
 * that key already exists.
 */

const unauthorized = {
  description: "Missing or invalid access token",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
    },
  },
};

const forbidden = {
  description: "Caller is not permitted to read this room",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
    },
  },
};

const notFound = {
  description: "Room or message not found",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
    },
  },
};

const roomIdPathParam = {
  name: "roomId",
  in: "path" as const,
  required: true,
  schema: { type: "string" as const },
};

const messageIdPathParam = {
  name: "messageId",
  in: "path" as const,
  required: true,
  schema: { type: "string" as const },
};

const changesParams = [
  {
    name: "since_revision",
    in: "query" as const,
    required: false,
    schema: { type: "integer" as const, minimum: 0, default: 0 },
    description:
      "The client's per-room CHANGE high-water. Returns messages with " +
      "`revision > since_revision`. `0` = cold start (drains from revision 1 " +
      "within the retention horizon).",
  },
  {
    name: "limit",
    in: "query" as const,
    required: false,
    schema: {
      type: "integer" as const,
      minimum: 1,
      maximum: 200,
      default: 100,
    },
    description: "Page size (default 100, max 200).",
  },
];

const CHANGES_DESCRIPTION = [
  "The canonical ZERO-LOSS catch-up feed. Returns every message whose per-room",
  "CHANGE `revision > since_revision` — INSERTS **and** mutations (edits,",
  "delete-for-everyone tombstones, reaction changes) — at their current state,",
  "ordered `revision ASC`.",
  "",
  "This closes the mutation-loss that a forward `after_seq` / `after_ts` page",
  "cannot: those return only newly inserted rows, so an edit, delete or reaction",
  "on an OLD message (whose `sequenceNumber` never moves) is never returned. Here",
  "that message reappears with its current state, because a mutation bumps its",
  "`revision` to the room's newest.",
  "",
  "Each message carries `revision` (its change cursor) alongside the immutable",
  "`sequenceNumber` (its placement). The client upserts by `id` and re-orders",
  "locally by `sequenceNumber`; feed order is irrelevant to placement. Idempotent —",
  "it returns current state, so replaying or overlapping with live socket events is",
  "safe.",
  "",
  "**Draining:** page with `nextRevisionCursor` fed back as `since_revision` until",
  "`hasMore` is false, then persist `roomRevision` as the new per-room high-water.",
  "",
  "**Deep gap:** if `since_revision` is below the retained horizon, the response is",
  "`resetRequired: true` with empty `items` — the client drops local room state,",
  "loads the newest history page, and sets its cursor to `roomRevision` (a bounded",
  "re-baseline).",
  "",
  "Access control is the same rule as the room's history read.",
].join("\n");

function changesResponseSchema(extraProps: Record<string, unknown> = {}) {
  return {
    allOf: [
      { $ref: "#/components/schemas/ApiSuccessResponse" },
      {
        type: "object" as const,
        properties: {
          data: {
            type: "object" as const,
            properties: {
              items: {
                type: "array" as const,
                items: { type: "object" as const },
                description:
                  "Full message objects at current state, `revision` ASC, each with " +
                  "`revision` + `sequenceNumber`.",
              },
              roomRevision: {
                type: "integer" as const,
                description:
                  "The room's current CHANGE max — the client's new high-water after draining.",
              },
              resetRequired: {
                type: "boolean" as const,
                description:
                  "`true` ⇒ `since_revision` is below retention; the client MUST re-baseline.",
              },
              hasMore: { type: "boolean" as const },
              nextRevisionCursor: {
                type: "string" as const,
                nullable: true,
                description:
                  "Feed back as `since_revision` to continue; `null` ⇒ caught up.",
              },
              ...extraProps,
            },
          },
        },
      },
    ],
  };
}

const privateChanges = {
  get: {
    tags: ["Chat — Private"],
    operationId: "getPrivateRoomChanges",
    summary: "Private room changes feed — zero-loss mutation catch-up",
    description: CHANGES_DESCRIPTION,
    security: [{ bearerAuth: [] }],
    parameters: [roomIdPathParam, ...changesParams],
    responses: {
      "200": {
        description:
          "Changed messages (current state) + `roomRevision` / `resetRequired` / " +
          "`nextRevisionCursor`, plus the peer's read and delivered watermarks " +
          "(receipts move without bumping `revision`, so the feed alone would never " +
          "tell a reconnecting sender that the peer read or received anything).",
        content: {
          "application/json": {
            schema: changesResponseSchema({
              peerReadSeq: {
                type: "integer" as const,
                description: "The peer's read watermark, as a sequenceNumber.",
              },
              peerDeliveredSeq: {
                type: "integer" as const,
                description:
                  "The peer's delivered watermark, as a sequenceNumber.",
              },
            }),
          },
        },
      },
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

const groupChanges = {
  get: {
    tags: ["Chat — Groups"],
    operationId: "getGroupRoomChanges",
    summary: "Group room changes feed — zero-loss mutation catch-up",
    description: CHANGES_DESCRIPTION,
    security: [{ bearerAuth: [] }],
    parameters: [roomIdPathParam, ...changesParams],
    responses: {
      "200": {
        description:
          "Changed messages (current state) + `roomRevision` / `resetRequired` / " +
          "`nextRevisionCursor`.",
        content: {
          "application/json": { schema: changesResponseSchema() },
        },
      },
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

const communityChanges = {
  get: {
    tags: ["Chat — Community"],
    operationId: "getCommunityRoomChanges",
    summary: "Community room changes feed — zero-loss mutation catch-up",
    description: [
      CHANGES_DESCRIPTION,
      "",
      "This is the revision-axis successor to `GET /chat/community/rooms/{roomId}/sync`,",
      "which approximates the same job on `updatedAt`. `/sync` remains available.",
    ].join("\n"),
    security: [{ bearerAuth: [] }],
    parameters: [roomIdPathParam, ...changesParams],
    responses: {
      "200": {
        description:
          "Changed messages (current state) + `roomRevision` / `resetRequired` / " +
          "`nextRevisionCursor` / `pinnedMessage`.",
        content: {
          "application/json": {
            schema: changesResponseSchema({
              pinnedMessage: {
                nullable: true,
                description: "Current active pin summary, or `null`.",
              },
            }),
          },
        },
      },
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

const REACT_DESCRIPTION = [
  "Single-write SET reaction: the caller's reaction on this message becomes",
  "`emoji`, replacing whatever they had before. The room is resolved server-side",
  "**from the message**, so an offline queue can drain a reaction with only",
  "`(messageId, emoji)` and no per-conversation-type branch. Broadcasts",
  "`message:reaction` to the room.",
  "",
  "This does not replace the room-scoped toggle pair",
  "(`POST`/`DELETE …/rooms/{roomId}/messages/{messageId}/reactions`), which remains",
  "available for clients that already know the room and want explicit add/remove",
  "semantics. Both go through the same orchestrator.",
].join("\n");

function reactOperation(tag: string, operationId: string) {
  return {
    post: {
      tags: [tag],
      operationId,
      summary: "Set the caller's reaction on a message",
      description: REACT_DESCRIPTION,
      security: [{ bearerAuth: [] }],
      parameters: [messageIdPathParam],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              required: ["emoji"],
              properties: {
                emoji: {
                  type: "string" as const,
                  description: "The reaction emoji to set.",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description:
            "The message's updated reaction groups under `{ reactions }`.",
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
                        properties: {
                          reactions: {
                            type: "array" as const,
                            items: { type: "object" as const },
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
        "403": forbidden,
        "404": notFound,
      },
    },
  };
}

export const chatChangesPaths = {
  "/chat/private/rooms/{roomId}/changes": privateChanges,
  "/chat/groups/{roomId}/changes": groupChanges,
  "/chat/community/rooms/{roomId}/changes": communityChanges,
  "/chat/private/messages/{messageId}/react": reactOperation(
    "Chat — Private",
    "setPrivateMessageReaction"
  ),
  "/chat/groups/messages/{messageId}/react": reactOperation(
    "Chat — Groups",
    "setGroupMessageReaction"
  ),
};
