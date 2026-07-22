import { openApiParameters } from "../../components/parameters.js";
import { openApiSchemas } from "../../components/schemas.js";

/**
 * OpenAPI paths for API v2 — the PARALLEL, additive Cursor-V2 surface. V2 is not
 * a re-issue of every v1 route; it documents ONLY the endpoints whose pagination
 * contract changed (timestamp → gap-safe cursor). Everything else stays on v1.
 * Keys are relative to server URL `…/api/v2`. Response bodies reuse the shared
 * v1 component schemas (identical shapes — only the request cursor changed).
 */

const myCommunitiesV2 = {
  get: {
    tags: ["Communities"],
    operationId: "listMyCommunitiesV2",
    summary: "List my communities (joined) / search — Cursor V2",
    description:
      "V2 of `GET /api/v1/communities/mine`. **Response body is unchanged** " +
      "(`MyCommunitiesResponseData` for joined mode, `CommunityDiscoverResponseData` " +
      "for search mode); only the joined-mode pagination contract changed.\n\n" +
      "**Joined mode (default, no `q`/`categoryId`)** — communities where you are " +
      "an ACTIVE member, ordered by `lastActivityAt`. Replaces v1's `before_ts`/" +
      "`after_ts` with a single opaque **compound cursor** " +
      '(`pagination.nextCursor` = `"<lastActivityAtMs>_<communityId>"`). The `id` ' +
      "tiebreaker is IN the keyset boundary, so communities sharing one " +
      "`lastActivityAt` millisecond can no longer skip or duplicate across a page " +
      "edge (the v1 leak). Treat `cursor` as OPAQUE: omit it for the newest page, " +
      "then feed the returned `nextCursor` back verbatim. A bare epoch-ms is also " +
      "accepted for a coarse first jump.\n\n" +
      "**Search mode (`q` and/or `categoryId`)** — identical to v1 search mode " +
      "(PUBLIC + joined PRIVATE, offset/page pagination).",
    security: [{ bearerAuth: [] }],
    parameters: [
      { $ref: "#/components/parameters/LanguageHeader" },
      {
        name: "cursor",
        in: "query",
        required: false,
        schema: { type: "string", pattern: "^\\d+(_[a-fA-F0-9]{24})?$" },
        description:
          'Joined mode. Opaque compound cursor `"<lastActivityAtMs>_<communityId>"` ' +
          "(or a bare epoch-ms for a coarse first jump). Omit for the newest page; " +
          "feed `pagination.nextCursor` back verbatim to page older.",
      },
      {
        name: "q",
        in: "query",
        required: false,
        schema: { type: "string", minLength: 1, maxLength: 100 },
        description:
          "Search mode. Search term matched against community name and handle.",
      },
      {
        name: "categoryId",
        in: "query",
        required: false,
        schema: { type: "string", pattern: "^[a-f0-9]{24}$" },
        description: "Search mode. Filter to a single category (24-char hex).",
      },
      {
        name: "filter",
        in: "query",
        required: false,
        schema: {
          type: "string",
          enum: ["all", "live", "upcoming"],
          default: "all",
        },
        description: "Search mode. `all` browses every matching community.",
      },
      {
        name: "page",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, default: 1 },
        description: "Search mode. 1-based page number (offset pagination).",
      },
      {
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        description: "Page size (both modes).",
      },
    ],
    responses: {
      "200": {
        description:
          "Joined mode → `MyCommunitiesResponseData`; search mode → " +
          "`CommunityDiscoverResponseData`.",
        content: {
          "application/json": {
            schema: {
              allOf: [
                { $ref: "#/components/schemas/ApiSuccessResponse" },
                {
                  type: "object" as const,
                  properties: {
                    data: {
                      oneOf: [
                        {
                          $ref: "#/components/schemas/MyCommunitiesResponseData",
                        },
                        {
                          $ref: "#/components/schemas/CommunityDiscoverResponseData",
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      },
    },
  },
};

const communityMessagesV2 = {
  get: {
    tags: ["Chat — Community"],
    operationId: "getCommunityRoomMessagesV2",
    summary: "Get community room messages — Sequence Cursor V2",
    description:
      "V2 of `GET /api/v1/chat/community/rooms/{roomId}/messages`. **Response " +
      "body is identical** to v1 (`ChatCommunityMessagePage`, plus `pinnedMessage` " +
      "and `roomRevision`).\n\n" +
      "**History pages on an OPAQUE `cursor`** (the compound `(createdAt, id)` " +
      "keyset). Treat `cursor` as opaque: omit it for the newest page, then echo " +
      '`pagination.nextCursor` (a `"<ms>_<id>"` token) back verbatim to page ' +
      'OLDER. `nextCursor` is always a real token (never `"0"`); `null` only when ' +
      "there are no older rows. The `id` tiebreak makes same-millisecond boundaries " +
      "gap-safe (no skip, no dup). Works on all existing data.\n\n" +
      "Access control, personal-system-message visibility, and ban read-cutoff " +
      "behave exactly as v1.\n\n" +
      "**Params:** `cursor` (opaque, older) · `before_ts` (migration alias for " +
      "`cursor`) · `after_ts` (newer placement page) · `around=<messageId>` " +
      "(jump-to-message; returns `<ms>_<id>` continuation cursors) · `limit`.\n\n" +
      "**Opt-in seq keyset** (`before_seq`/`after_seq`): the gap-safe monotonic " +
      "`sequenceNumber` keyset. Only use it for rooms whose `sequenceNumber` has " +
      "been backfilled (`> 0`); otherwise use the opaque `cursor`.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      {
        name: "cursor",
        in: "query",
        required: false,
        schema: { type: "string", pattern: "^\\d+(_[a-fA-F0-9]{24})?$" },
        description:
          "Opaque history cursor (compound (createdAt,id) keyset). Omit for the newest " +
          "page; echo pagination.nextCursor back verbatim to page older.",
      },
      {
        name: "before_ts",
        in: "query",
        required: false,
        schema: { type: "string", pattern: "^\\d+(_[a-fA-F0-9]{24})?$" },
        description:
          "Migration alias for `cursor` (same compound token, pages older).",
      },
      {
        name: "after_ts",
        in: "query",
        required: false,
        schema: { type: "string", pattern: "^\\d+(_[a-fA-F0-9]{24})?$" },
        description: "Newer placement page (forward paging), compound token.",
      },
      {
        name: "before_seq",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 0 },
        description:
          "OPT-IN seq keyset (backfilled rooms only): sequenceNumber < before_seq, newest-first.",
      },
      {
        name: "after_seq",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 0 },
        description:
          "OPT-IN seq keyset (backfilled rooms only): sequenceNumber > after_seq, oldest-first.",
      },
      {
        name: "around",
        in: "query",
        required: false,
        schema: { type: "string", minLength: 1, maxLength: 100 },
        description:
          "Message ID to anchor a jump-to-message window. Returns `<ms>_<id>` " +
          "(older) / epoch-ms (newer) continuation cursors.",
      },
      {
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 100, default: 40 },
        description: "Page size (default 40, max 100).",
      },
    ],
    responses: {
      "200": {
        description:
          "Community messages. `ChatCommunityMessagePage` + `pinnedMessage` + " +
          "`roomRevision`; `around` adds bidirectional cursors.",
        content: {
          "application/json": {
            schema: {
              allOf: [
                { $ref: "#/components/schemas/ApiSuccessResponse" },
                {
                  type: "object" as const,
                  properties: {
                    data: {
                      $ref: "#/components/schemas/ChatCommunityMessagePage",
                    },
                  },
                },
              ],
            },
          },
        },
      },
    },
  },
};

const communityChangesV2 = {
  get: {
    tags: ["Chat — Community"],
    operationId: "getCommunityRoomChanges",
    summary: "Community room changes feed — zero-loss mutation catch-up",
    description:
      "The canonical ZERO-LOSS catch-up feed. Returns every message whose per-room " +
      "CHANGE `revision > since_revision` — INSERTS **and** mutations (edits, " +
      "delete-for-everyone tombstones, reaction changes) — current state, ordered " +
      "`revision ASC`.\n\n" +
      "This closes the mutation-loss that V2 `after_seq` cannot: `after_seq` returns " +
      "only new inserts (`sequenceNumber > X`), so an edit / delete / reaction on an " +
      "OLD message (whose `sequenceNumber` never moves) is never returned. Here that " +
      "message reappears with its current state because a mutation bumps its " +
      "`revision` to the room's newest.\n\n" +
      "Each message object carries `revision` (its change cursor) alongside the " +
      "immutable `sequenceNumber` (its placement). The client upserts by `id` and " +
      "re-orders locally by `sequenceNumber`; feed order is irrelevant to placement. " +
      "Idempotent (returns current state, safe to replay/overlap with live events).\n\n" +
      "**Draining:** page with `nextRevisionCursor` fed back as `since_revision` until " +
      "`hasMore=false`; persist `roomRevision` as the new per-room high-water.\n\n" +
      "**Deep gap:** if `since_revision` is below the retained horizon, `resetRequired: " +
      "true` is returned with empty `data` — the client drops local room state, loads " +
      "the newest V2 page, and sets its cursor to `roomRevision` (bounded re-baseline).\n\n" +
      "**Cold start** (`since_revision=0`) returns changes from revision 1 within the " +
      "horizon; for a full historical baseline, load V2 history first and set the cursor " +
      "to `roomRevision`. Access is the same PUBLIC-or-member rule as V2 reads.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      {
        name: "since_revision",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 0, default: 0 },
        description:
          "Client's per-room CHANGE high-water. Returns messages with revision > this. " +
          "0 = cold start (drains from revision 1 within the retention horizon).",
      },
      {
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 200, default: 100 },
        description: "Page size (default 100, max 200).",
      },
    ],
    responses: {
      "200": {
        description:
          "Changed messages (current state) + `roomRevision` / `resetRequired` / " +
          "`pinnedMessage` / `nextRevisionCursor`.",
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
                        roomRevision: {
                          type: "integer",
                          description:
                            "Room's current CHANGE max — the client's new high-water after draining.",
                        },
                        resetRequired: {
                          type: "boolean",
                          description:
                            "true ⇒ since_revision is below retention; client MUST re-baseline.",
                        },
                        pinnedMessage: {
                          nullable: true,
                          description: "Current active pin summary, or null.",
                        },
                        hasMore: { type: "boolean" },
                        nextRevisionCursor: {
                          type: "string",
                          nullable: true,
                          description:
                            "Feed back as since_revision to continue; null ⇒ caught up.",
                        },
                        data: {
                          type: "array",
                          items: {
                            $ref: "#/components/schemas/ChatCommunityMessage",
                          },
                          description:
                            "Full message objects (current state), revision ASC, each with `revision` + `sequenceNumber`.",
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
    },
  },
};

/** Opaque compound cursor over the `(createdAt, _id)` message keyset. */
const messageCursorSchema = {
  type: "string" as const,
  pattern: "^\\d+(_[a-fA-F0-9]{24})?$",
};

const privateMessagesV2 = {
  get: {
    tags: ["Chat — Private"],
    operationId: "getPrivateMessagesV2",
    summary: "Get private messages — Cursor V2",
    description:
      "V2 of `GET /api/v1/chat/private/rooms/{roomId}/messages`. **Response body " +
      "is identical** to v1 (`ChatMessagePage`). Access control, enrichment, " +
      "serialization and the `around` window are unchanged — the ONLY difference " +
      "is the pagination contract.\n\n" +
      "v1's `before_ts`/`after_ts` are **gone** from this surface. Pages carry the " +
      'same opaque compound `(createdAt, id)` keyset token (`"<ms>_<id>"`) on ' +
      "`before_cursor` / `after_cursor` — the same cursor contract as " +
      "`GET /api/v2/chat/community/rooms/{roomId}/messages`. Treat it as OPAQUE: " +
      "omit for the newest page, then echo `pagination.nextCursor` back verbatim. " +
      "Continuation is EXCLUSIVE, so consecutive pages never share a boundary " +
      "message (no client-side de-dupe). A bare epoch-ms is accepted for a coarse " +
      "first jump.\n\n" +
      "**Migrating from v1:** change the endpoint and rename `before_ts` → " +
      "`before_cursor`, `after_ts` → `after_cursor`. Nothing else changes.\n\n" +
      "`before_seq`/`after_seq` (gap-safe `sequenceNumber` keyset) and " +
      "`around=<messageId>` behave exactly as on v1.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      {
        name: "before_cursor",
        in: "query",
        required: false,
        schema: messageCursorSchema,
        description:
          "Older page (scroll-up), newest-first. Opaque compound token; echo " +
          "`pagination.nextCursor` back verbatim. Omit for the newest page.",
      },
      {
        name: "after_cursor",
        in: "query",
        required: false,
        schema: messageCursorSchema,
        description:
          "Newer page (forward paging), oldest-first. Same token format.",
      },
      {
        name: "before_seq",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 0 },
        description: "Seq keyset: sequenceNumber < before_seq, newest-first.",
      },
      {
        name: "after_seq",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 0 },
        description: "Seq keyset: sequenceNumber > after_seq, oldest-first.",
      },
      {
        name: "around",
        in: "query",
        required: false,
        schema: { type: "string", minLength: 1, maxLength: 100 },
        description:
          "Message ID anchoring a jump-to-message window; adds bidirectional " +
          "`hasMoreOlder`/`hasMoreNewer`/`olderCursor`/`newerCursor`.",
      },
      {
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 100, default: 30 },
        description: "Page size (default 30, max 100).",
      },
    ],
    responses: {
      "200": {
        description: "Messages — identical shape to v1 (`ChatMessagePage`).",
        content: {
          "application/json": {
            schema: {
              allOf: [
                { $ref: "#/components/schemas/ApiSuccessResponse" },
                {
                  type: "object" as const,
                  properties: {
                    data: { $ref: "#/components/schemas/ChatMessagePage" },
                  },
                },
              ],
            },
          },
        },
      },
    },
  },
};

const inboxV2 = {
  get: {
    tags: ["Chat — Inbox"],
    operationId: "getUnifiedInboxV2",
    summary: "Unified inbox (private + group) — Cursor V2",
    description:
      "V2 of `GET /api/v1/chat/inbox`. **Response body is identical** to v1 " +
      "(`ChatInboxPage`): same items, same ordering by `lastMessageAt`, same " +
      "unread/mute/pin fields. Only the pagination contract changed.\n\n" +
      "v1 paged on a bare, **inclusive** epoch-ms bound, so consecutive pages " +
      "shared the boundary row whenever two conversations tied on " +
      "`lastMessageAt` — clients had to de-duplicate by `roomId`. V2 pages on the " +
      "strict compound `(lastMessageAt, roomId)` keyset: `pagination.nextCursor` " +
      'is a `"<lastMessageAtMs>_<roomId>"` token you echo back verbatim as ' +
      "`before_cursor` (or `after_cursor`). Boundaries are EXCLUSIVE — no skip, " +
      "no duplicate, no client de-dupe.\n\n" +
      "**Migrating from v1:** change the endpoint and rename `before_ts` → " +
      "`before_cursor`, `after_ts` → `after_cursor`. Nothing else changes. A bare " +
      "epoch-ms is accepted for a coarse first jump. Omit both for the newest page.",
    security: [{ bearerAuth: [] }],
    parameters: [
      { $ref: "#/components/parameters/LanguageHeader" },
      {
        name: "before_cursor",
        in: "query",
        required: false,
        schema: { type: "string", pattern: "^\\d+(_[A-Za-z0-9_-]{1,64})?$" },
        description:
          'Older page (newest-first). Opaque compound token "<ms>_<roomId>"; ' +
          "echo `pagination.nextCursor` back verbatim.",
      },
      {
        name: "after_cursor",
        in: "query",
        required: false,
        schema: { type: "string", pattern: "^\\d+(_[A-Za-z0-9_-]{1,64})?$" },
        description: "Newer page (oldest-first). Same token format.",
      },
      {
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        description: "Page size (default 20, max 100).",
      },
    ],
    responses: {
      "200": {
        description: "Inbox list — identical shape to v1 (`ChatInboxPage`).",
        content: {
          "application/json": {
            schema: {
              allOf: [
                { $ref: "#/components/schemas/ApiSuccessResponse" },
                {
                  type: "object" as const,
                  properties: {
                    data: { $ref: "#/components/schemas/ChatInboxPage" },
                  },
                },
              ],
            },
          },
        },
      },
    },
  },
};

// Group shares the private V2 timeline contract byte-for-byte (same params, same
// envelope) — derived rather than duplicated so the two can never drift.
const groupMessagesV2 = {
  get: {
    ...privateMessagesV2.get,
    tags: ["Chat — Group"],
    operationId: "getGroupMessagesV2",
    summary: "Get group messages — Cursor V2",
    description:
      "V2 of `GET /api/v1/chat/group/rooms/{roomId}/messages`. Identical " +
      "contract to the private V2 timeline: same `before_cursor`/`after_cursor` " +
      "compound cursor, same opt-in `before_seq`/`after_seq`, same `around` " +
      "window, same `ChatMessagePage` response envelope. Only the room kind differs.",
  },
};

export const v2Paths = {
  "/communities/mine": myCommunitiesV2,
  "/chat/community/rooms/{roomId}/messages": communityMessagesV2,
  "/chat/community/rooms/{roomId}/changes": communityChangesV2,
  "/chat/private/rooms/{roomId}/messages": privateMessagesV2,
  "/chat/group/rooms/{roomId}/messages": groupMessagesV2,
  "/chat/inbox": inboxV2,
};

export const v2Tags = [
  {
    name: "Communities",
    description: "Communities and categories — Cursor V2 (community-service)",
  },
  {
    name: "Chat — Community",
    description: "Community room messaging — Sequence Cursor V2 (chat-service)",
  },
  {
    name: "Chat — Private",
    description: "1-to-1 private messaging — Cursor V2 (chat-service)",
  },
  {
    name: "Chat — Group",
    description: "Group room messaging — Cursor V2 (chat-service)",
  },
  {
    name: "Chat — Inbox",
    description:
      "Unified private + group conversation list — Cursor V2 (chat-service)",
  },
];

export const v2Components = {
  parameters: openApiParameters,
  schemas: openApiSchemas,
};
