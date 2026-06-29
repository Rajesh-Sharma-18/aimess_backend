/**
 * Stream Service OpenAPI paths.
 *
 * All paths are relative to the v1 server URL (…/api/v1). The api-gateway
 * proxies /api/v1/streams/* to stream-service :3007/api/v1/streams/*.
 *
 * Auth: every route requires a valid user JWT (`Authorization: Bearer <token>`).
 * Owner-only routes enforce creator ownership inside the service (403 on mismatch).
 *
 * Source of truth: apps/stream-service/src/api/routes/index.ts
 */

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
  description: "Forbidden — caller is not the stream owner or is banned",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
    },
  },
};

const notFound = {
  description: "Stream not found",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
    },
  },
};

const internalError = {
  description: "Internal server error",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
    },
  },
};

const streamAuth = [{ bearerAuth: [] }];

const streamIdParam = {
  name: "id",
  in: "path" as const,
  required: true,
  schema: { type: "string" as const },
  description: "MongoDB ObjectId of the livestream.",
};

const SOURCE_TYPES = ["PHONE_CAMERA", "URL", "YOUTUBE"] as const;
const STREAM_STATUSES = ["PENDING", "LIVE", "ENDED", "CANCELLED"] as const;

// ---------------------------------------------------------------------------
// Inline response wrappers
// ---------------------------------------------------------------------------
function streamOk(description: string, dataRef: string) {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          type: "object" as const,
          properties: {
            success: { type: "boolean" as const, example: true },
            data: { $ref: dataRef },
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// POST /streams — Create a livestream
// ---------------------------------------------------------------------------
const createStream = {
  post: {
    tags: ["Streams"],
    operationId: "createStream",
    summary: "Create a livestream",
    description: `Start the go-live flow for a community. Returns the stream record plus owner-only \`streamKey\` and \`ingest\` endpoints.

**Source types:**
- \`PHONE_CAMERA\` — WHIP (WebRTC) publish via SRS. \`streamKey\` is returned; use \`ingest.whipUrl\` to push from a phone camera.
- \`URL\` — Re-stream an RTMP/HLS URL via ffmpeg (requires \`sourceUrl\`). \`streamKey\` is internal.
- \`YOUTUBE\` — Embed a YouTube URL (\`sourceUrl\` required). No SRS ingest — stream stays PENDING until manually ended. No playback URLs minted.

**Concurrency cap:** At most \`STREAM_MAX_CONCURRENT_PER_COMMUNITY\` (default 5) PENDING+LIVE streams per community. Returns 409 on breach.

**Membership gate:** When \`STREAM_REQUIRE_MEMBERSHIP=true\`, the creator must be an ACTIVE community member or a 403 is returned.`,
    security: streamAuth,
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["communityId", "title", "sourceType"],
            properties: {
              communityId: {
                type: "string" as const,
                example: "550e8400-e29b-41d4-a716-446655440000",
                description: "UUID of the community hosting the stream.",
              },
              title: {
                type: "string" as const,
                minLength: 1,
                maxLength: 200,
                example: "Weekly Dev Q&A",
              },
              description: {
                type: "string" as const,
                maxLength: 2000,
                example: "Ask me anything about the new release.",
              },
              thumbnail: {
                type: "string" as const,
                example: "stream/thumbnail/abc123/uuid.jpg",
                description:
                  "MinIO object key for the thumbnail image (optional).",
              },
              sourceType: {
                type: "string" as const,
                enum: SOURCE_TYPES,
                example: "PHONE_CAMERA",
              },
              sourceUrl: {
                type: "string" as const,
                example: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                description: "Required when sourceType is URL or YOUTUBE.",
              },
            },
          },
        },
      },
    },
    responses: {
      "201": streamOk(
        "Stream created",
        "#/components/schemas/StreamCreateResult"
      ),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "409": {
        description: "Community concurrency limit reached or stream is LIVE",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
          },
        },
      },
      "500": internalError,
    },
  },
};

// ---------------------------------------------------------------------------
// GET /streams — List livestreams
// ---------------------------------------------------------------------------
const listStreams = {
  get: {
    tags: ["Streams"],
    operationId: "listStreams",
    summary: "List livestreams",
    description:
      "Paginated cursor list of streams. Filter by community and/or status. Results are ordered newest-first.\n\n**Live stream sidebar:** To populate the 'other live streams' sidebar while watching, call `GET /streams?status=LIVE&limit=5` (omit `communityId` to get global results across all communities).",
    security: streamAuth,
    parameters: [
      {
        name: "communityId",
        in: "query" as const,
        required: false,
        schema: { type: "string" as const },
        description: "Filter by community UUID.",
      },
      {
        name: "status",
        in: "query" as const,
        required: false,
        schema: { type: "string" as const, enum: STREAM_STATUSES },
      },
      {
        name: "limit",
        in: "query" as const,
        required: false,
        schema: {
          type: "integer" as const,
          minimum: 1,
          maximum: 100,
          default: 20,
        },
      },
      {
        name: "cursor",
        in: "query" as const,
        required: false,
        schema: { type: "string" as const },
        description:
          "Opaque cursor (the `id` of the last row from the previous page).",
      },
    ],
    responses: {
      "200": {
        description: "Paginated stream list",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: true },
                data: {
                  type: "object" as const,
                  properties: {
                    items: {
                      type: "array" as const,
                      items: { $ref: "#/components/schemas/StreamView" },
                    },
                    nextCursor: { type: "string" as const, nullable: true },
                    hasMore: { type: "boolean" as const },
                  },
                },
              },
            },
          },
        },
      },
      "400": badRequest,
      "401": unauthorized,
      "500": internalError,
    },
  },
};

// ---------------------------------------------------------------------------
// GET /streams/{id} — Get a single stream
// ---------------------------------------------------------------------------
const getStream = {
  get: {
    tags: ["Streams"],
    operationId: "getStream",
    summary: "Get stream details",
    description:
      "Returns the full stream record. `viewerCount` is merged from Redis (authoritative live value) when the stream is LIVE. Banned users receive 403.",
    security: streamAuth,
    parameters: [streamIdParam],
    responses: {
      "200": streamOk("Stream detail", "#/components/schemas/StreamView"),
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
      "500": internalError,
    },
  },
};

// ---------------------------------------------------------------------------
// PATCH /streams/{id} — Update stream metadata (owner only)
// ---------------------------------------------------------------------------
const updateStream = {
  patch: {
    tags: ["Streams"],
    operationId: "updateStream",
    summary: "Update stream metadata",
    description:
      "Owner-only. Updates `title`, `description`, and/or `thumbnail`. Broadcasts a `stream:info_updated` socket event to all viewers in real time. Only the provided fields are changed.",
    security: streamAuth,
    parameters: [streamIdParam],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            minProperties: 1,
            properties: {
              title: { type: "string" as const, minLength: 1, maxLength: 200 },
              description: { type: "string" as const, maxLength: 2000 },
              thumbnail: {
                type: "string" as const,
                description: "MinIO object key for the new thumbnail.",
              },
            },
          },
        },
      },
    },
    responses: {
      "200": streamOk("Updated stream", "#/components/schemas/StreamView"),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
      "500": internalError,
    },
  },
};

// ---------------------------------------------------------------------------
// DELETE /streams/{id} — Delete a stream (owner only)
// ---------------------------------------------------------------------------
const deleteStream = {
  delete: {
    tags: ["Streams"],
    operationId: "deleteStream",
    summary: "Delete a stream",
    description:
      "Owner-only. Deletes PENDING, ENDED, or CANCELLED streams. Returns 409 if the stream is LIVE (stop it first).",
    security: streamAuth,
    parameters: [streamIdParam],
    responses: {
      "200": {
        description: "Stream deleted",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: true },
                data: {
                  type: "object" as const,
                  properties: {
                    deleted: {
                      type: "string" as const,
                      description: "ID of the deleted stream.",
                    },
                  },
                },
              },
            },
          },
        },
      },
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
      "409": {
        description: "Cannot delete a LIVE stream — stop it first",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
          },
        },
      },
      "500": internalError,
    },
  },
};

// ---------------------------------------------------------------------------
// POST /streams/{id}/stop — Stop a live stream (owner only)
// ---------------------------------------------------------------------------
const stopStream = {
  post: {
    tags: ["Streams"],
    operationId: "stopStream",
    summary: "Stop a livestream",
    description: `Owner-only. Ends the stream, kicks the SRS publisher (best-effort), and broadcasts \`stream:status → ENDED\` to all viewers.

SRS will also fire \`on_unpublish\`, which is handled idempotently (no-op if already ENDED).`,
    security: streamAuth,
    parameters: [streamIdParam],
    responses: {
      "200": streamOk("Stream stopped", "#/components/schemas/StreamView"),
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
      "500": internalError,
    },
  },
};

// ---------------------------------------------------------------------------
// POST /streams/{id}/go-live — Manually mark stream as LIVE (owner only)
// ---------------------------------------------------------------------------
const goLive = {
  post: {
    tags: ["Streams"],
    operationId: "goLive",
    summary: "Mark stream as live",
    description: `Owner-only. Manually transitions a PENDING stream to LIVE and stamps FLV/HLS/DASH playback URLs.

Use this when SRS has no \`on_publish\` hook configured (e.g. hosted SRS). Call this after OBS connects and you confirm the RTMP feed is active. Idempotent if already LIVE.`,
    security: streamAuth,
    parameters: [streamIdParam],
    responses: {
      "200": streamOk("Stream is now live", "#/components/schemas/StreamView"),
      "400": { description: "Stream is already ENDED or CANCELLED" },
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
      "500": internalError,
    },
  },
};

// ---------------------------------------------------------------------------
// GET /streams/{id}/comments — Paginated comment history
// ---------------------------------------------------------------------------
const getComments = {
  get: {
    tags: ["Streams"],
    operationId: "getStreamComments",
    summary: "Get stream comments",
    description:
      "Cursor-paginated comment history for a stream. Returns comments **oldest-first** (the list is reversed from DB order). `before` is a comment ObjectId — pass `nextCursor` from a previous page to load older comments.",
    security: streamAuth,
    parameters: [
      streamIdParam,
      {
        name: "limit",
        in: "query" as const,
        required: false,
        schema: {
          type: "integer" as const,
          minimum: 1,
          maximum: 100,
          default: 30,
        },
      },
      {
        name: "before",
        in: "query" as const,
        required: false,
        schema: { type: "string" as const },
        description:
          "Exclusive cursor — comment ObjectId. Omit for the latest page.",
      },
    ],
    responses: {
      "200": {
        description: "Comment page",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: true },
                data: {
                  type: "object" as const,
                  properties: {
                    items: {
                      type: "array" as const,
                      items: { $ref: "#/components/schemas/StreamComment" },
                    },
                    nextCursor: { type: "string" as const, nullable: true },
                    hasMore: { type: "boolean" as const },
                  },
                },
              },
            },
          },
        },
      },
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
      "500": internalError,
    },
  },
};

// ---------------------------------------------------------------------------
// PATCH /streams/{id}/comment-status — Enable/disable chat (owner only)
// ---------------------------------------------------------------------------
const setCommentStatus = {
  patch: {
    tags: ["Streams"],
    operationId: "setStreamCommentStatus",
    summary: "Toggle live chat",
    description:
      "Owner-only. Enables or disables the live chat for the stream. Broadcasts `stream:comment_status` via Redis so all connected viewers update their `canComment` state in real time.",
    security: streamAuth,
    parameters: [streamIdParam],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["enabled"],
            properties: {
              enabled: {
                type: "boolean" as const,
                example: false,
                description: "true = chat open, false = chat frozen.",
              },
            },
          },
        },
      },
    },
    responses: {
      "200": streamOk("Updated stream", "#/components/schemas/StreamView"),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
      "500": internalError,
    },
  },
};

// ---------------------------------------------------------------------------
// GET /streams/{id}/viewers — Current viewer list (owner only)
// ---------------------------------------------------------------------------
const getViewers = {
  get: {
    tags: ["Streams"],
    operationId: "getStreamViewers",
    summary: "Get current viewers",
    description:
      "Owner-only. Returns the set of userIds currently watching the stream, sourced from the Redis session set `stream:session:users:<id>`. Returns an empty array if Redis is unavailable.",
    security: streamAuth,
    parameters: [streamIdParam],
    responses: {
      "200": {
        description: "Viewer userId list",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: true },
                data: {
                  type: "object" as const,
                  properties: {
                    items: {
                      type: "array" as const,
                      items: { type: "string" as const },
                      example: [
                        "550e8400-e29b-41d4-a716-446655440000",
                        "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
      "500": internalError,
    },
  },
};

// ---------------------------------------------------------------------------
// POST /streams/{id}/ban — Ban a user (owner only)
// ---------------------------------------------------------------------------
const banUser = {
  post: {
    tags: ["Streams"],
    operationId: "banStreamUser",
    summary: "Ban a user from the stream",
    description: `Owner-only. Bans a viewer from the stream. Idempotent — re-banning an already-banned user is a no-op.

**Live effect:** Publishes \`stream:banned\` to Redis; the gateway intercepts it, emits the event to the banned user's sockets, and forces them to leave the room. On any subsequent \`stream:join\`, \`CheckStreamAccess\` returns \`{ allowed: false, isBanned: true }\`.`,
    security: streamAuth,
    parameters: [streamIdParam],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["userId"],
            properties: {
              userId: {
                type: "string" as const,
                example: "550e8400-e29b-41d4-a716-446655440000",
                description: "UUID of the user to ban.",
              },
              reason: {
                type: "string" as const,
                maxLength: 500,
                example: "Spamming",
              },
            },
          },
        },
      },
    },
    responses: {
      "200": {
        description: "User banned",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: true },
                data: {
                  type: "object" as const,
                  properties: {
                    banned: {
                      type: "string" as const,
                      description: "userId that was banned.",
                    },
                  },
                },
              },
            },
          },
        },
      },
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
      "500": internalError,
    },
  },
};

// ---------------------------------------------------------------------------
// DELETE /streams/{id}/ban/{userId} — Unban a user (owner only)
// ---------------------------------------------------------------------------
const unbanUser = {
  delete: {
    tags: ["Streams"],
    operationId: "unbanStreamUser",
    summary: "Unban a user from the stream",
    description:
      "Owner-only. Lifts a ban. Idempotent — unbanning a non-banned user is a no-op.",
    security: streamAuth,
    parameters: [
      streamIdParam,
      {
        name: "userId",
        in: "path" as const,
        required: true,
        schema: { type: "string" as const },
        description: "UUID of the user to unban.",
      },
    ],
    responses: {
      "200": {
        description: "User unbanned",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: true },
                data: {
                  type: "object" as const,
                  properties: {
                    unbanned: {
                      type: "string" as const,
                      description: "userId that was unbanned.",
                    },
                  },
                },
              },
            },
          },
        },
      },
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
      "500": internalError,
    },
  },
};

// ---------------------------------------------------------------------------
// GET /streams/{id}/bans — List banned users (owner only)
// ---------------------------------------------------------------------------
const listBans = {
  get: {
    tags: ["Streams"],
    operationId: "listStreamBans",
    summary: "List stream bans",
    description:
      "Owner-only. Returns all users currently banned from the stream.",
    security: streamAuth,
    parameters: [streamIdParam],
    responses: {
      "200": {
        description: "Ban list",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: true },
                data: {
                  type: "object" as const,
                  properties: {
                    items: {
                      type: "array" as const,
                      items: { $ref: "#/components/schemas/StreamBanItem" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
      "500": internalError,
    },
  },
};

// ---------------------------------------------------------------------------
// POST /streams/{id}/comments/{commentId}/report — Report a comment
// ---------------------------------------------------------------------------
const reportComment = {
  post: {
    tags: ["Streams"],
    summary: "Report a chat comment",
    description: `Any authenticated viewer can report a live chat comment for moderation review. Idempotent — submitting a second report on the same comment returns the original report unchanged.

**Reason codes:**
- \`OFFENSIVE_LANGUAGE\` — Offensive or abusive language
- \`SPAM\` — Spam or repeated messages
- \`INAPPROPRIATE_CONTENT\` — Inappropriate content
- \`SCAM_OR_FRAUD\` — Scam or fraudulent links
- \`IMPERSONATION\` — Impersonating someone
- \`OTHER\` — Anything else (**\`details\` is required** for this reason)

\`details\` is optional free-text context (max 500 characters).`,
    security: streamAuth,
    parameters: [
      streamIdParam,
      {
        name: "commentId",
        in: "path" as const,
        required: true,
        schema: { type: "string" as const },
        description: "MongoDB ObjectId of the comment to report.",
      },
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["reason"],
            properties: {
              reason: {
                type: "string" as const,
                enum: [
                  "OFFENSIVE_LANGUAGE",
                  "SPAM",
                  "INAPPROPRIATE_CONTENT",
                  "SCAM_OR_FRAUD",
                  "IMPERSONATION",
                  "OTHER",
                ],
                example: "SPAM",
              },
              details: {
                type: "string" as const,
                maxLength: 500,
                example: "This user is flooding the chat with the same link.",
              },
            },
          },
        },
      },
    },
    responses: {
      "201": streamOk(
        "Report submitted (or existing report returned)",
        "#/components/schemas/StreamCommentReport"
      ),
      "400": badRequest,
      "401": unauthorized,
      "404": notFound,
      "500": internalError,
    },
  },
};

// ---------------------------------------------------------------------------
// GET /streams/{id}/comments/reports — List reported comments (owner/mod)
// ---------------------------------------------------------------------------
const listCommentReports = {
  get: {
    tags: ["Streams"],
    summary: "List reported comments for a stream",
    description:
      "Returns a newest-first, cursor-paged list of comment reports for the stream, each enriched with the reported comment's current content (`comment` is `null` if the comment was deleted). Authorized for the stream owner or a community ADMIN/MODERATOR.",
    security: streamAuth,
    parameters: [
      streamIdParam,
      {
        name: "limit",
        in: "query" as const,
        required: false,
        schema: {
          type: "integer" as const,
          minimum: 1,
          maximum: 100,
          default: 30,
        },
        description: "Page size (1-100, default 30).",
      },
      {
        name: "before",
        in: "query" as const,
        required: false,
        schema: { type: "string" as const },
        description: "Cursor — return reports older than this report id.",
      },
    ],
    responses: {
      "200": streamOk(
        "Paged list of reports",
        "#/components/schemas/StreamCommentReportList"
      ),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
      "500": internalError,
    },
  },
};

export const streamPaths = {
  "/streams": { ...createStream, ...listStreams },
  "/streams/{id}": { ...getStream, ...updateStream, ...deleteStream },
  "/streams/{id}/stop": stopStream,
  "/streams/{id}/go-live": goLive,
  "/streams/{id}/comments": getComments,
  "/streams/{id}/comment-status": setCommentStatus,
  "/streams/{id}/viewers": getViewers,
  "/streams/{id}/ban": banUser,
  "/streams/{id}/ban/{userId}": unbanUser,
  "/streams/{id}/bans": listBans,
  "/streams/{id}/comments/{commentId}/report": reportComment,
  "/streams/{id}/comments/reports": listCommentReports,
};
