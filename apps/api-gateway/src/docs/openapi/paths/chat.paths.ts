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

function successResponse(
  description: string,
  dataRef?: string,
  status = "200"
) {
  const schema = dataRef
    ? {
        allOf: [
          { $ref: "#/components/schemas/ApiSuccessResponse" },
          {
            type: "object" as const,
            properties: { data: { $ref: `#/components/schemas/${dataRef}` } },
          },
        ],
      }
    : { $ref: "#/components/schemas/ApiSuccessResponse" };

  return {
    [status]: {
      description,
      content: { "application/json": { schema } },
    },
  };
}

function cursorParam(description = "Cursor for pagination") {
  return {
    name: "cursor",
    in: "query" as const,
    schema: { type: "string" as const },
    description,
  };
}

/**
 * before_ts / after_ts pair for the timestamp-paginated message endpoints.
 * Epoch ms, mutually exclusive; omit both for the newest page.
 *
 * Pass `{ incrementalSyncAfterTs: true }` for the community messages endpoint,
 * whose `after_ts` is an incremental-sync cursor over `updatedAt` (not
 * `createdAt`) — it surfaces edits, reactions, and deletions. Private/group
 * `after_ts` is plain history forward-paging over `createdAt`.
 */
function messageTimelineParams(opts?: { incrementalSyncAfterTs?: boolean }) {
  return [
    {
      name: "before_ts",
      in: "query" as const,
      required: false,
      schema: { type: "integer" as const, minimum: 1 },
      description:
        'Epoch-ms value **or** a compound `"<epochMs>_<messageId>"` string returned as ' +
        "`nextCursor` from a previous response. Returns messages with createdAt <= before_ts " +
        "(newest-first). Mutually exclusive with after_ts; omit both for the newest page. " +
        "**Pass `nextCursor` verbatim** — do NOT parse it to a number. Community history " +
        'returns a compound `"<ms>_<objectId>"` cursor; stripping the `_<id>` part causes ' +
        "messages that share the same millisecond to be skipped silently.",
    },
    {
      name: "after_ts",
      in: "query" as const,
      required: false,
      schema: { type: "integer" as const, minimum: 1 },
      description: opts?.incrementalSyncAfterTs
        ? "Epoch ms. Incremental-sync mode: returns messages with updatedAt >= " +
          "after_ts (oldest-first) — new, edited, reacted, and deleted (tombstone) " +
          "messages, each carrying a syncEventType for reconciliation. NOTE: the " +
          "sort key is updatedAt, NOT createdAt. Mutually exclusive with before_ts. " +
          "`nextCursor` (epoch-ms string of the last updatedAt) must be parsed to an " +
          "integer before feeding it back as after_ts."
        : "Epoch ms. Returns messages with createdAt >= after_ts (oldest-first). " +
          "Mutually exclusive with before_ts. `nextCursor` comes back as an epoch-ms " +
          "string — parse it to an integer before feeding it back as after_ts.",
    },
  ];
}

function limitParam(defaultVal: number, max = 100) {
  return {
    name: "limit",
    in: "query" as const,
    schema: {
      type: "integer" as const,
      minimum: 1,
      maximum: max,
      default: defaultVal,
    },
  };
}

function mediaTypeParam() {
  return {
    name: "type",
    in: "query" as const,
    required: false,
    schema: {
      type: "string" as const,
      enum: ["IMAGE", "VIDEO", "GIF", "VOICE", "DOCUMENT", "STICKER"],
    },
    description: "Optional media-kind filter. Omit to list all shared media.",
  };
}

function pageNumberParam() {
  return {
    name: "pageNumber",
    in: "query" as const,
    required: false,
    schema: { type: "integer" as const, minimum: 1, default: 1 },
    description: "1-based page number.",
  };
}

function conversationTimestampParam() {
  return {
    name: "timestamp",
    in: "query" as const,
    required: false,
    schema: { type: "integer" as const, minimum: 1 },
    description:
      "Epoch milliseconds. Returns messages with createdAt < timestamp (defaults to now).",
  };
}

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

// Shared media listing (cursor-paginated) — private / group / community.
function mediaListPath(tag: string, summary: string) {
  return {
    get: {
      tags: [tag],
      summary,
      description:
        "Cursor-paginated list of media-bearing messages in the room (images, video, GIFs, voice notes, documents, stickers). Optional `type` narrows to a single media kind.",
      security: [{ bearerAuth: [] }],
      parameters: [
        roomIdPathParam,
        mediaTypeParam(),
        cursorParam(),
        limitParam(30),
      ],
      responses: {
        ...successResponse(
          "Shared media",
          tag.includes("Community")
            ? "ChatCommunityMessageList"
            : "ChatMessageList"
        ),
        "401": unauthorized,
        "404": notFound,
      },
    },
  };
}

// Conversation listing (offset-paginated) + mark-as-read side effect.
function conversationPath(tag: string, summary: string) {
  return {
    get: {
      tags: [tag],
      summary,
      description:
        "Offset-paginated message history, newest-first, returning messages with `createdAt < timestamp` (defaults to now). Side effect: advances the caller's read pointer, marking the room read up to the newest returned message.",
      security: [{ bearerAuth: [] }],
      parameters: [
        roomIdPathParam,
        pageNumberParam(),
        limitParam(30),
        conversationTimestampParam(),
      ],
      responses: {
        ...successResponse(
          "Messages page (read pointer advanced)",
          tag.includes("Community")
            ? "ChatCommunityConversationPage"
            : "ChatConversationPage"
        ),
        "401": unauthorized,
        "404": notFound,
      },
    },
  };
}

const privateMedia = mediaListPath(
  "Chat — Private",
  "List shared media (private)"
);
const groupMedia = mediaListPath("Chat — Groups", "List shared media (group)");
const communityMedia = mediaListPath(
  "Chat — Community",
  "List shared media (community)"
);

const groupConversation = conversationPath(
  "Chat — Groups",
  "Get conversation + mark as read (group)"
);
const communityConversation = conversationPath(
  "Chat — Community",
  "Get conversation + mark as read (community)"
);

const groupMessageEdit = {
  patch: {
    tags: ["Chat — Groups"],
    operationId: "editGroupMessage",
    summary: "Edit a group message (text only)",
    description:
      "Edits the caller's own TEXT message within the 15-minute edit window. Expired edits return 410 (CHAT_EDIT_WINDOW_EXPIRED).",
    security: [{ bearerAuth: [] }],
    parameters: [messageIdPathParam],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatEditMessageRequest" },
        },
      },
    },
    responses: {
      ...successResponse("Message edited", "ChatWireMessage"),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
      "410": {
        description: "Edit window expired (CHAT_EDIT_WINDOW_EXPIRED)",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
          },
        },
      },
    },
  },
};

const communityMessageEdit = {
  patch: {
    tags: ["Chat — Community"],
    operationId: "editCommunityMessage",
    summary: "Edit a community message (text only)",
    description:
      "Edits the caller's own TEXT community message within the 15-minute edit window. The body must include `communityId` so the edit broadcast reaches the right community room. Expired edits return 410 (CHAT_EDIT_WINDOW_EXPIRED).",
    security: [{ bearerAuth: [] }],
    parameters: [messageIdPathParam],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            $ref: "#/components/schemas/ChatEditCommunityMessageRequest",
          },
        },
      },
    },
    responses: {
      ...successResponse("Message edited", "ChatCommunityEditResponse"),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
      "410": {
        description: "Edit window expired (CHAT_EDIT_WINDOW_EXPIRED)",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
          },
        },
      },
    },
  },
};

const communityMessageReact = {
  post: {
    tags: ["Chat — Community"],
    operationId: "reactToCommunityMessage",
    summary: "React to a community message",
    description:
      "Toggle an emoji reaction on a community message. Sending the same emoji again **removes** the reaction (toggle semantics — no separate un-react call needed). " +
      "On success the server broadcasts a `community:message:reaction` Socket.IO event to all room members carrying the same `reactions` array as the REST response.",
    security: [{ bearerAuth: [] }],
    parameters: [messageIdPathParam],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatCommunityReactRequest" },
        },
      },
    },
    responses: {
      ...successResponse("Reaction toggled", "ChatCommunityReactResponse"),
      "400": badRequest,
      "401": unauthorized,
      "404": notFound,
    },
  },
};

// =============================================================================
// Private messaging
// =============================================================================
const privateConversations = {
  get: {
    tags: ["Chat — Private"],
    operationId: "listConversations",
    summary: "List conversations",
    description:
      "Cursor-paginated list of the authenticated user's private rooms, ordered by latest activity desc. " +
      "Query params, pagination, response envelope (`{pagination,data}`, no top-level hasMore/nextCursor " +
      "duplicates), sorting, avatar/media resolution, `lastActivity`, and `unreadMessageCount` follow the " +
      "exact same contract as `GET /communities/mine`: only `before_ts`/`after_ts`/`limit` are accepted " +
      "(mutually exclusive `before_ts`/`after_ts`, `limit` max 50 default 20), `pagination.hasMore`/`nextCursor` " +
      "are exact, and `nextCursor` is an epoch-ms string fed back verbatim as the next `before_ts`/`after_ts`. " +
      "Each item is a lean, community-list-style object with the peer's fields flattened directly onto it " +
      "(no nested `peer` object): `roomId`, `participants`, `peerId`, `displayName`, `memberId`, `avatar`, " +
      "`avatarUrl`, `avatarUrlExpiresIn`, `isDeletedUser`, `isOnline`, `unreadMessageCount`, `lastActivityAt` " +
      "(epoch ms, never an ISO string), `lastActivity`, `isMuted`. Internal per-user maps (mute/archive/delete/ " +
      "read state for OTHER participants) and redundant raw fields (`lastMessage`, `lastMessageAt`, " +
      "`createdAt`/`updatedAt`) are never included.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "before_ts",
        in: "query" as const,
        required: false,
        schema: { type: "integer" as const, minimum: 1 },
        description:
          "Epoch ms. Returns rooms with lastActivityAt <= before_ts, newest-first.",
      },
      {
        name: "after_ts",
        in: "query" as const,
        required: false,
        schema: { type: "integer" as const, minimum: 1 },
        description:
          "Epoch ms. Returns rooms with lastActivityAt >= after_ts, oldest-first.",
      },
      limitParam(20, 50),
    ],
    responses: {
      ...successResponse(
        "Conversation list",
        "ChatPrivateConversationListData"
      ),
      "401": unauthorized,
    },
  },
};

const chatInbox = {
  get: {
    tags: ["Chat — Inbox"],
    operationId: "getUnifiedInbox",
    summary: "Unified inbox (private + group)",
    description:
      "Merged, timestamp-ordered list of the authenticated user's private rooms and group chats. " +
      "Timestamps are epoch milliseconds and mutually exclusive: `before_ts` returns items with " +
      "`lastMessageAt <= before_ts` (newest-first); `after_ts` returns items with `lastMessageAt >= after_ts` " +
      "(oldest-first). Omit both for the newest page. Boundaries are inclusive, so consecutive pages can " +
      "share the boundary item — de-duplicate by `roomId`. Continue paging with `pagination.nextCursor` " +
      "(epoch-ms string) fed back as the same `before_ts`/`after_ts` you used.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "before_ts",
        in: "query" as const,
        required: false,
        schema: { type: "integer" as const, minimum: 1 },
        description: "Epoch ms. Returns items with lastMessageAt <= before_ts.",
      },
      {
        name: "after_ts",
        in: "query" as const,
        required: false,
        schema: { type: "integer" as const, minimum: 1 },
        description: "Epoch ms. Returns items with lastMessageAt >= after_ts.",
      },
      limitParam(20),
    ],
    responses: {
      ...successResponse("Inbox list", "ChatInboxPage"),
      "400": badRequest,
      "401": unauthorized,
    },
  },
};

const privateRoomByPeer = {
  get: {
    tags: ["Chat — Private"],
    operationId: "getPrivateRoomDetails",
    summary: "Get private room details",
    description:
      "Returns the private room details for the peer (get-or-create + friendship gate, same as the POST). " +
      "Response shape mirrors `GET /communities/{id}` field-for-field wherever applicable " +
      "(`id`, `avatar`, `isMuted`, `muteUntil`, `createdAt`, `updatedAt`), plus the private-chat-specific " +
      "`user`/presence fields and `isOffline` (negation of the existing `isOnline` presence field).",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "peerId",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "User ID of the peer.",
      },
    ],
    responses: {
      ...successResponse("Private room details", "ChatPrivateRoomDetails"),
      "401": unauthorized,
      "403": forbidden,
    },
  },
  post: {
    tags: ["Chat — Private"],
    operationId: "getOrCreatePrivateRoom",
    summary: "Get or create private room",
    description:
      "Returns the existing private room with `peerId`, or creates one. Requires friendship.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "peerId",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "User ID of the peer.",
      },
    ],
    responses: {
      ...successResponse("Private room", "ChatPrivateRoom"),
      "401": unauthorized,
      "403": forbidden,
    },
  },
};

const privateRoomDelete = {
  delete: {
    tags: ["Chat — Private"],
    operationId: "deleteConversation",
    summary: "Delete conversation for me",
    description:
      "Soft-deletes the conversation for the authenticated user. The peer's view is unaffected.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      ...successResponse("Conversation deleted"),
      "401": unauthorized,
      "404": notFound,
    },
  },
};

const privateRoomClear = {
  post: {
    tags: ["Chat â€” Private"],
    operationId: "clearPrivateChat",
    summary: "Clear chat for me",
    description:
      "Clears all previous private messages for the authenticated user only. " +
      "The conversation remains in the inbox, peers keep their history, and new messages remain visible.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      ...successResponse("Chat cleared"),
      "401": unauthorized,
      "404": notFound,
    },
  },
};

const privateMessages = {
  get: {
    tags: ["Chat — Private"],
    operationId: "getPrivateMessages",
    summary: "Get private messages",
    description:
      "Timestamp-paginated message history for a private room. Timestamps are epoch " +
      "milliseconds and mutually exclusive: `before_ts` returns messages with " +
      "`createdAt <= before_ts` (newest-first); `after_ts` returns messages with " +
      "`createdAt >= after_ts` (oldest-first). Omit both for the newest page. " +
      "Boundaries are inclusive, so consecutive pages can share the boundary message — " +
      "de-duplicate by message id. Continue paging with `pagination.nextCursor` " +
      "(epoch-ms string) fed back as the same `before_ts`/`after_ts` you used.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      ...messageTimelineParams(),
      limitParam(30),
    ],
    responses: {
      ...successResponse("Messages", "ChatMessagePage"),
      "401": unauthorized,
      "404": notFound,
    },
  },
};

const privateMessageDelete = {
  patch: {
    tags: ["Chat — Private"],
    operationId: "editPrivateMessage",
    summary: "Edit a private message (text only)",
    description:
      "Edits the caller's own TEXT message. Prior content is kept in editHistory.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "messageId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatEditMessageRequest" },
        },
      },
    },
    responses: {
      ...successResponse("Message edited", "ChatWireMessage"),
      "400": badRequest,
      "401": unauthorized,
      "404": notFound,
      "410": {
        description:
          "Edit window expired (CHAT_EDIT_WINDOW_EXPIRED) — edits are allowed only within 15 minutes of sending.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
          },
        },
      },
    },
  },
  delete: {
    tags: ["Chat — Private"],
    operationId: "deletePrivateMessage",
    summary: "Delete private message",
    description:
      "`type=forMe` soft-deletes for the caller; `type=forEveryone` deletes for both participants.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "messageId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      {
        name: "type",
        in: "query",
        required: true,
        schema: { type: "string", enum: ["forMe", "forEveryone"] },
        description: "Delete scope.",
      },
    ],
    responses: {
      ...successResponse("Message deleted", "ChatDeleteTombstone"),
      "400": badRequest,
      "401": unauthorized,
    },
  },
};

const privateMessageReport = {
  post: {
    tags: ["Chat — Private"],
    operationId: "reportPrivateMessage",
    summary: "Report a private message",
    description:
      "Reports another participant's message. One report per user per message.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "messageId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatReportMessageRequest" },
        },
      },
    },
    responses: {
      ...successResponse("Message reported", undefined, "201"),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

const privateRoomMute = {
  post: {
    tags: ["Chat — Private"],
    operationId: "mutePrivateChat",
    summary: "Mute a private chat",
    description:
      "Mutes the room for the caller. Omit or null `muteUntil` to mute indefinitely.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    requestBody: {
      required: false,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatMuteRoomRequest" },
        },
      },
    },
    responses: {
      ...successResponse("Chat muted"),
      "400": badRequest,
      "401": unauthorized,
      "404": notFound,
    },
  },
};

const privateRoomUnmute = {
  post: {
    tags: ["Chat — Private"],
    operationId: "unmutePrivateChat",
    summary: "Unmute a private chat",
    description: "Removes the caller's mute on the room.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      ...successResponse("Chat unmuted"),
      "401": unauthorized,
      "404": notFound,
    },
  },
};

const privateRoomArchive = {
  patch: {
    tags: ["Chat — Private"],
    operationId: "archivePrivateChat",
    summary: "Archive a private chat",
    description:
      "Archives the conversation for the caller only (per-user). The peer is unaffected. Archived rooms are hidden from the default inbox until unarchived.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      ...successResponse("Chat archived", "ChatPrivateRoom"),
      "401": unauthorized,
      "404": notFound,
    },
  },
};

const privateRoomUnarchive = {
  patch: {
    tags: ["Chat — Private"],
    operationId: "unarchivePrivateChat",
    summary: "Unarchive a private chat",
    description:
      "Restores an archived private conversation to the caller's inbox.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      ...successResponse("Chat unarchived", "ChatPrivateRoom"),
      "401": unauthorized,
      "404": notFound,
    },
  },
};

const privatePresence = {
  get: {
    tags: ["Chat — Private"],
    operationId: "getUserPresence",
    summary: "Get a user's presence",
    description: "Returns online/offline state and last-seen for a user.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "userId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      ...successResponse("Presence", "ChatPresence"),
      "401": unauthorized,
    },
  },
};

const privatePins = {
  get: {
    tags: ["Chat — Private"],
    operationId: "getPrivatePinnedMessages",
    summary: "Get pinned messages (private)",
    description: "Cursor-paginated pinned messages for a private room.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      cursorParam(),
      limitParam(20),
    ],
    responses: {
      ...successResponse("Pinned messages", "ChatPinList"),
      "401": unauthorized,
    },
  },
};

// =============================================================================
// Group rooms
// =============================================================================
const groupCreate = {
  post: {
    tags: ["Chat — Groups"],
    operationId: "createGroup",
    summary: "Create a group",
    description: "Creator becomes OWNER. Rate limited to 10 creations per day.",
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatCreateGroupRequest" },
        },
      },
    },
    responses: {
      ...successResponse("Group created", "ChatGroupRoom", "201"),
      "400": badRequest,
      "401": unauthorized,
      "429": {
        description: "Rate limit exceeded",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
          },
        },
      },
    },
  },
};

const groupMyGroups = {
  get: {
    tags: ["Chat — Groups"],
    operationId: "listMyGroups",
    summary: "List my groups",
    description:
      "Cursor-paginated list of groups the authenticated user belongs to.",
    security: [{ bearerAuth: [] }],
    parameters: [cursorParam(), limitParam(20)],
    responses: {
      ...successResponse("User's groups", "ChatGroupRoomList"),
      "401": unauthorized,
    },
  },
};

const groupById = {
  get: {
    tags: ["Chat — Groups"],
    operationId: "getGroupDetails",
    summary: "Get group details",
    description:
      "Members-only. ACTIVE members get the live room; a member who LEFT still " +
      "reads it with `isJoined=false` and `lastMessagePreview` capped at their " +
      "`leftAt` (same cutoff as the timeline). Kicked, banned and non-members " +
      "get 403 `CHAT_NOT_A_MEMBER`. To preview a group before joining, use " +
      "`GET /chat/invite-links/preview/{token}`.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      ...successResponse("Group details", "ChatGroupRoom"),
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
  patch: {
    tags: ["Chat — Groups"],
    operationId: "updateGroup",
    summary: "Update group",
    description: "Partial update — admin/owner only.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatUpdateGroupRequest" },
        },
      },
    },
    responses: {
      ...successResponse("Group updated", "ChatGroupRoom"),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
    },
  },
  delete: {
    tags: ["Chat — Groups"],
    operationId: "clearGroupConversation",
    summary: "Delete conversation (clear history)",
    description:
      "Clears the caller's own message history for this group; the caller " +
      "remains a member. Does not disband the group or affect other members' history.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      ...successResponse("Conversation cleared"),
      "401": unauthorized,
      "404": notFound,
    },
  },
};

const groupClear = {
  post: {
    tags: ["Chat â€” Groups"],
    operationId: "clearGroupChat",
    summary: "Clear chat for me",
    description:
      "Clears all previous group messages for the authenticated user only. " +
      "The user remains a member, other members keep their history, and new messages remain visible.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      ...successResponse("Chat cleared"),
      "401": unauthorized,
      "404": notFound,
    },
  },
};

const groupDisband = {
  post: {
    tags: ["Chat — Groups"],
    operationId: "disbandGroup",
    summary: "Disband group",
    description: "Owner-only. Soft-deletes the group and removes all members.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      ...successResponse("Group disbanded"),
      "401": unauthorized,
      "403": forbidden,
    },
  },
};

const groupArchive = {
  patch: {
    tags: ["Chat — Groups"],
    operationId: "archiveGroup",
    summary: "Archive a group chat",
    description:
      "Archives the group for the caller only (per-user). Other members are unaffected.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      ...successResponse("Group archived", "ChatGroupRoom"),
      "401": unauthorized,
      "404": notFound,
    },
  },
};

const groupUnarchive = {
  patch: {
    tags: ["Chat — Groups"],
    operationId: "unarchiveGroup",
    summary: "Unarchive a group chat",
    description: "Restores an archived group to the caller's inbox.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      ...successResponse("Group unarchived", "ChatGroupRoom"),
      "401": unauthorized,
      "404": notFound,
    },
  },
};

// =============================================================================
// Group messages
// =============================================================================
const groupMessages = {
  get: {
    tags: ["Chat — Groups"],
    operationId: "getGroupMessages",
    summary: "Get group messages",
    description:
      "Timestamp-paginated message history for a group room. Timestamps are epoch " +
      "milliseconds and mutually exclusive: `before_ts` returns messages with " +
      "`createdAt <= before_ts` (newest-first); `after_ts` returns messages with " +
      "`createdAt >= after_ts` (oldest-first). Omit both for the newest page. " +
      "Boundaries are inclusive, so consecutive pages can share the boundary message — " +
      "de-duplicate by message id. Continue paging with `pagination.nextCursor` " +
      "(epoch-ms string) fed back as the same `before_ts`/`after_ts` you used.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      ...messageTimelineParams(),
      limitParam(30),
    ],
    responses: {
      ...successResponse("Messages", "ChatMessagePage"),
      "401": unauthorized,
      "404": notFound,
    },
  },
};

const groupMessageDelete = {
  post: {
    tags: ["Chat — Groups"],
    operationId: "deleteGroupMessage",
    summary: "Delete group message",
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            $ref: "#/components/schemas/ChatDeleteGroupMessageRequest",
          },
        },
      },
    },
    responses: {
      ...successResponse("Message deleted", "ChatDeleteTombstone"),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
    },
  },
};

const groupPins = {
  get: {
    tags: ["Chat — Groups"],
    operationId: "getGroupPinnedMessages",
    summary: "Get pinned messages (group)",
    description: "Cursor-paginated pinned messages for a group room.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      cursorParam(),
      limitParam(20),
    ],
    responses: {
      ...successResponse("Pinned messages", "ChatPinList"),
      "401": unauthorized,
    },
  },
};

// =============================================================================
// Group members
// =============================================================================
const groupMemberAdd = {
  post: {
    tags: ["Chat — Groups"],
    operationId: "addGroupMember",
    summary: "Add member to group",
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatAddMemberRequest" },
        },
      },
    },
    responses: {
      ...successResponse("Member added", "ChatGroupMember", "201"),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "409": {
        description:
          "User is already an active member of the group (CHAT_ALREADY_MEMBER).",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
          },
        },
      },
    },
  },
};

const groupMemberLeave = {
  post: {
    tags: ["Chat — Groups"],
    operationId: "leaveGroup",
    summary: "Leave group",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      ...successResponse("Left group"),
      "401": unauthorized,
      "404": notFound,
    },
  },
};

const groupMemberKick = {
  post: {
    tags: ["Chat — Groups"],
    operationId: "kickGroupMember",
    summary: "Kick member from group",
    description: "Admin/owner only.",
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatKickMemberRequest" },
        },
      },
    },
    responses: {
      ...successResponse("Member kicked"),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
    },
  },
};

const groupMemberBan = {
  post: {
    tags: ["Chat — Groups"],
    operationId: "banGroupMember",
    summary: "Ban member from group",
    description:
      "Owner/admin/moderator only (must outrank the target). Sets member status to BANNED. Optional `reason` is stored on the membership.",
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatBanMemberRequest" },
        },
      },
    },
    responses: {
      ...successResponse("Member banned", "ChatGroupMember"),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

const groupMemberUnban = {
  post: {
    tags: ["Chat — Groups"],
    operationId: "unbanGroupMember",
    summary: "Unban member from group",
    description:
      "Owner/admin/moderator only. Clears the ban (status → LEFT). Does **not** re-add the user as an active member — they must rejoin via invite.",
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatUnbanMemberRequest" },
        },
      },
    },
    responses: {
      ...successResponse("Member unbanned", "ChatGroupMember"),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

const groupMemberReport = {
  post: {
    tags: ["Chat — Groups"],
    operationId: "reportGroupMember",
    summary: "Report a group member",
    description:
      "Any active member may report another member in the same group.",
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatReportMemberRequest" },
        },
      },
    },
    responses: {
      ...successResponse("Member reported", "ChatReportMemberResult"),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

const groupMemberMute = {
  post: {
    tags: ["Chat — Groups"],
    operationId: "muteGroupChat",
    summary: "Mute group notifications",
    description:
      "Mutes the group for the caller only. Omit or null `muteUntil` to mute indefinitely. Parity with `POST /chat/private/rooms/{roomId}/mute`.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    requestBody: {
      required: false,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatMuteRoomRequest" },
        },
      },
    },
    responses: {
      ...successResponse("Group muted", "ChatGroupMember"),
      "400": badRequest,
      "401": unauthorized,
      "404": notFound,
    },
  },
};

const groupMemberUnmute = {
  post: {
    tags: ["Chat — Groups"],
    operationId: "unmuteGroupChat",
    summary: "Unmute group notifications",
    description: "Removes the caller's mute on the group.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      ...successResponse("Group unmuted", "ChatGroupMember"),
      "401": unauthorized,
      "404": notFound,
    },
  },
};

const groupMemberMuteMember = {
  post: {
    tags: ["Chat — Groups"],
    operationId: "muteGroupMember",
    summary: "Mute another member (moderation)",
    description:
      "Owner/admin/moderator only, and the caller must outrank the target (a moderator cannot mute another moderator). " +
      "This is the MODERATION mute — the counterpart of `POST /communities/{id}/members/{userId}/mute` — and is entirely " +
      "distinct from `POST /chat/group-members/{roomId}/mute`, which mutes the caller's OWN notifications. " +
      "Omit or null `durationMinutes` to mute indefinitely; a minute count is added to the SERVER's clock (expiry is applied lazily, " +
      "so posting rights return the instant it passes). A muted member keeps FULL read access — history, new messages, " +
      "media downloads, member list, search, receipts — but every write is rejected with `CHAT_MUTED_IN_GROUP` (403): " +
      "send (all content types), edit, delete-own, react, and pin. Typing and voice-recording indicators are dropped " +
      "server-side too. " +
      "Emits `group:member:muted` on `conv:<roomId>` (roster badges) AND on the target's own `user:<id>` channel, so every " +
      "logged-in device disables its composer with no refresh, plus a `typing:stop`/`recording:stop` retraction for the target.",
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatMuteMemberRequest" },
        },
      },
    },
    responses: {
      ...successResponse("Member muted", "ChatGroupMember"),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

const groupMemberUnmuteMember = {
  post: {
    tags: ["Chat — Groups"],
    operationId: "unmuteGroupMember",
    summary: "Unmute another member (moderation)",
    description:
      "Owner/admin/moderator only. Lifts a moderation mute and restores sending, media, voice notes, reactions, pinning " +
      "and typing immediately. 404 `CHAT_MEMBER_NOT_MUTED` when the member is not currently muted (a fully-expired timed " +
      "mute counts as not muted). Emits `group:member:unmuted` to the room AND to the target's `user:<id>` channel, so " +
      "every device re-enables its composer without a refetch. A timed mute that simply lapses emits the same event from " +
      'the auto-unmute sweep, with `actorId: ""`.',
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatUnmuteMemberRequest" },
        },
      },
    },
    responses: {
      ...successResponse("Member unmuted", "ChatGroupMember"),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

const groupMemberRole = {
  post: {
    tags: ["Chat — Groups"],
    operationId: "updateGroupMemberRole",
    summary: "Update member role",
    description: "Admin/owner only.",
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatUpdateRoleRequest" },
        },
      },
    },
    responses: {
      ...successResponse("Role updated"),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
    },
  },
};

const groupMembers = {
  get: {
    tags: ["Chat — Groups"],
    operationId: "listGroupMembers",
    summary: "List group members",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      limitParam(50),
      {
        name: "offset",
        in: "query" as const,
        schema: { type: "integer" as const, minimum: 0, default: 0 },
      },
    ],
    responses: {
      ...successResponse("Members", "ChatGroupMemberList"),
      "401": unauthorized,
      "404": notFound,
    },
  },
};

// =============================================================================
// Group invite links
// =============================================================================
const inviteLinkCreate = {
  post: {
    tags: ["Chat — Groups"],
    operationId: "createGroupInviteLink",
    summary: "Create group invite link",
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatCreateInviteLinkRequest" },
        },
      },
    },
    responses: {
      ...successResponse("Invite link created", "ChatInviteLink", "201"),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
    },
  },
};

const inviteLinkRevoke = {
  post: {
    tags: ["Chat — Groups"],
    operationId: "revokeGroupInviteLink",
    summary: "Revoke group invite link",
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatRevokeInviteLinkRequest" },
        },
      },
    },
    responses: {
      ...successResponse("Invite link revoked"),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
    },
  },
};

const inviteLinkPreview = {
  get: {
    tags: ["Chat — Groups"],
    operationId: "previewGroupInviteLink",
    summary: "Preview invite link",
    description: "Public endpoint — no auth required.",
    parameters: [
      {
        name: "token",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      ...successResponse("Link preview", "ChatInviteLinkPreview"),
      "404": notFound,
    },
  },
};

const inviteLinkJoin = {
  post: {
    tags: ["Chat — Groups"],
    operationId: "joinGroupViaInviteLink",
    summary: "Join group via invite link",
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatJoinByInviteLinkRequest" },
        },
      },
    },
    responses: {
      ...successResponse("Joined group"),
      "400": badRequest,
      "401": unauthorized,
      "404": notFound,
    },
  },
};

const inviteLinksByRoom = {
  get: {
    tags: ["Chat — Groups"],
    operationId: "listGroupInviteLinks",
    summary: "List active invite links for a group",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      ...successResponse("Active invite links", "ChatInviteLinkList"),
      "401": unauthorized,
      "403": forbidden,
    },
  },
};

// =============================================================================
// Notifications
// =============================================================================
// Real-time notification spine (shipped 2026-06-17):
// When a business action occurs (community member-added, friend request, chat mention, etc.),
// notifications-service consumes the RabbitMQ event and calls chat-service's createNotification gRPC.
// The gRPC writes the inbox row AND publishes to Redis notify:<userId>.
// The gateway's /notify Socket.IO namespace relays the event to connected clients in real time.
// Offline users receive FCM push; online users skip push (real-time socket is sufficient).
// See docs/IMPLEMENTATION-NOTES.md "Real-time Notification Spine" for full flow.
const notifications = {
  get: {
    tags: ["Chat — Notifications"],
    operationId: "listNotifications",
    summary: "List notifications",
    description:
      "Fetch the user's in-app Notification Center inbox (paginated, tab-filterable) " +
      "plus per-tab unread counts. Real-time updates arrive via the Socket.IO /notify " +
      "namespace (notification:new, notification:count_update, notification:deleted); " +
      "use this endpoint for initial load and pagination. Pagination is a hybrid: " +
      "`cursor` (createdAt-based, opaque) drives the actual query, while " +
      "`pagination.currentPage`/`totalPage` are cosmetic — pass `page` back only if " +
      "you need it echoed, it has no effect on which rows are returned.",
    security: [{ bearerAuth: [] }],
    parameters: [
      cursorParam(
        "Opaque cursor — pass back `nextCursor` from the previous response verbatim (ISO createdAt string). Omit for the first page."
      ),
      limitParam(20, 100),
      {
        name: "type",
        in: "query" as const,
        required: false,
        schema: { $ref: "#/components/schemas/NotificationCategory" },
        description: "Filter to one tab. Omit or ALL for the mixed feed.",
      },
      {
        name: "page",
        in: "query" as const,
        required: false,
        schema: { type: "integer" as const, minimum: 1, default: 1 },
        description:
          "Echoed back as pagination.currentPage. Does not affect which rows are returned — use `cursor` for actual paging.",
      },
    ],
    responses: {
      ...successResponse("Notifications", "ChatNotificationListData"),
      "401": unauthorized,
    },
  },
};

const notificationRead = {
  post: {
    tags: ["Chat — Notifications"],
    operationId: "markNotificationRead",
    summary: "Mark notification(s) as read",
    description:
      "Accepts either a single `notificationId` or a `notificationIds` array (1-500) " +
      "so one endpoint covers mark-one and mark-many. Scoped to the caller — a user " +
      "cannot mark another user's notification read. Relays the refreshed unread " +
      "count over Socket.IO (notification:read + legacy notification:count_update alias) " +
      "to every connected device.",
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatMarkReadRequest" },
          examples: {
            single: {
              summary: "Mark one notification read",
              value: { notificationId: "683abc100def000000000099" },
            },
            bulk: {
              summary: "Mark multiple notifications read",
              value: {
                notificationIds: [
                  "683abc100def000000000099",
                  "683abc100def0000000000a0",
                ],
              },
            },
          },
        },
      },
    },
    responses: {
      ...successResponse("Marked as read", "ChatMarkReadResponseData"),
      "400": badRequest,
      "401": unauthorized,
    },
  },
};

const notificationReadAll = {
  post: {
    tags: ["Chat — Notifications"],
    operationId: "markAllNotificationsRead",
    summary: "Mark all notifications as read",
    description:
      "Marks every unread notification read, or only those in one tab when `type` " +
      "is given (also accepted as a `type` query param for backward compatibility). " +
      "The returned `unreadCount` is always the total across ALL tabs, so a per-tab " +
      "Read All correctly leaves other tabs' unreads counted. Relays " +
      "notification:all-read over Socket.IO with the same authoritative total.",
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: false,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatMarkAllReadRequest" },
        },
      },
    },
    parameters: [
      {
        name: "type",
        in: "query" as const,
        required: false,
        schema: { $ref: "#/components/schemas/NotificationCategory" },
        description:
          "Alternative to passing `type` in the body. Body takes precedence if both are present.",
      },
    ],
    responses: {
      ...successResponse("All marked as read", "ChatMarkAllReadResponseData"),
      "401": unauthorized,
    },
  },
};

const notificationUnreadCount = {
  get: {
    tags: ["Chat — Notifications"],
    operationId: "getUnreadNotificationCount",
    summary: "Get unread notification count",
    description:
      "Total unread count across all tabs (badge count). For per-tab counts use the `counts` block on GET /chat/notifications.",
    security: [{ bearerAuth: [] }],
    responses: {
      ...successResponse("Unread count", "ChatUnreadCountData"),
      "401": unauthorized,
    },
  },
};

const notificationAction = {
  patch: {
    tags: ["Chat — Notifications"],
    operationId: "recordNotificationAction",
    summary: "Record an action on a notification",
    description:
      "Records the caller's decision on an actionable notification (e.g. TERMINATE / CONFIRM / REJECT / ACCEPT) with a short `body` note.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "Notification id from GET /chat/notifications.",
      },
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            $ref: "#/components/schemas/ChatNotificationActionRequest",
          },
        },
      },
    },
    responses: {
      ...successResponse("Action recorded"),
      "400": badRequest,
      "401": unauthorized,
      "404": notFound,
    },
  },
};

const unreadSummary = {
  get: {
    tags: ["Chat — Inbox"],
    operationId: "getChatUnreadSummary",
    summary: "Get chat unread badge summary",
    description:
      "Returns unread counts for private, group, and community surfaces plus `chatUnread` (private + group) for the inbox badge.",
    security: [{ bearerAuth: [] }],
    responses: {
      ...successResponse("Unread summary", "ChatUnreadSummary"),
      "401": unauthorized,
    },
  },
};

// =============================================================================
// Community rooms & messages
// =============================================================================
const communityRooms = {
  get: {
    tags: ["Chat — Community"],
    operationId: "listCommunityRooms",
    summary: "List community rooms",
    description: "Public endpoint — no auth required.",
    responses: {
      ...successResponse("Community rooms", "ChatCommunityRoomList"),
    },
  },
};

const communitySearch = {
  get: {
    tags: ["Chat — Community"],
    operationId: "searchCommunityRooms",
    summary: "Search community rooms",
    description: "Public endpoint — no auth required.",
    parameters: [
      {
        name: "query",
        in: "query",
        required: true,
        schema: { type: "string", minLength: 1, maxLength: 100 },
      },
    ],
    responses: {
      ...successResponse("Search results", "ChatCommunityRoomList"),
      "400": badRequest,
    },
  },
};

const communityJoin = {
  post: {
    tags: ["Chat — Community"],
    operationId: "joinCommunityRoom",
    summary: "Join a community room",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      ...successResponse("Joined room"),
      "401": unauthorized,
      "404": notFound,
    },
  },
};

const communityLeave = {
  post: {
    tags: ["Chat — Community"],
    operationId: "leaveCommunityRoom",
    summary: "Leave a community room",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      ...successResponse("Left room"),
      "401": unauthorized,
    },
  },
};

// Community send 201/200 response body: the canonical community wire message
// (ChatCommunityWireMessage) plus an `idempotent` flag. Shared by both the fresh
// (201) and idempotent-replay (200) responses.
const communitySendResponseSchema = {
  allOf: [
    { $ref: "#/components/schemas/ApiSuccessResponse" },
    {
      type: "object" as const,
      properties: {
        data: {
          allOf: [
            { $ref: "#/components/schemas/ChatCommunityWireMessage" },
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

const communityMessages = {
  get: {
    tags: ["Chat — Community"],
    operationId: "getCommunityRoomMessages",
    summary: "Get community room messages",
    description:
      "Dual-mode message endpoint. The query param determines which mode is active — **provide only one of before_ts / after_ts**.\n\n" +
      "**Access control (Telegram-style):**\n" +
      "- **PUBLIC** communities: any authenticated user can read message history — membership is NOT required (guests can browse before joining).\n" +
      "- **PRIVATE** communities: only ACTIVE (or BANNED, see below) members can read; other non-members get `403 CHAT_NOT_A_MEMBER`.\n" +
      "- **BANNED members**: keep read access to their **pre-ban history only** — every message/edit/reaction/deletion created " +
      "at or before their ban timestamp remains visible (scroll, jump-to-message, and incremental-sync all honor this cutoff), " +
      "but anything created after the ban is never returned, even on rejoin/resync. This applies in both PUBLIC and PRIVATE " +
      "communities and replaces the previous behavior where a banned member was rejected outright.\n\n" +
      "**Personal system messages:** SYSTEM messages with `isPersonal: true` (e.g. COMMUNITY_JOINED, 'You joined this community', " +
      "MEMBER_BANNED 'You were banned from this community.', MEMBER_MUTED, MEMBER_UNMUTED) are returned ONLY to the target user " +
      "— other members never see them in this history, even in PUBLIC communities.\n\n" +
      "**Scroll / history mode** (`before_seq`, `before_ts`, or neither):\n" +
      "- `before_seq` → messages with `sequenceNumber < before_seq`, newest-first. **Preferred**: gap-safe, the same " +
      "axis private/group page on, and it takes precedence over the `*_ts` params. Walk forward with `after_seq`.\n" +
      "- `before_ts` → messages with `createdAt <= before_ts`, newest-first.\n" +
      "- Omit both for the newest page.\n" +
      "- Response shape: `ChatCommunityMessagePage` (`pagination` + `data[]` + top-level `hasMore`/`nextCursor`).\n" +
      "- Boundaries inclusive — de-dupe by message id. Feed `nextCursor` back as the next `before_ts`.\n\n" +
      "**Incremental-sync mode** (`after_ts` only, for offline/reconnect sync):\n" +
      "- Queries by `updatedAt >= after_ts` — catches **new messages, edits, reaction changes, and deletions** in one call.\n" +
      "- Each item has a `syncEventType: 'new'|'edited'|'deleted'|'reacted'` field for client-side reconciliation.\n" +
      "- Tombstones (`deletedForAll=true`) are **included** so the client can purge deleted messages.\n" +
      "- Response shape: `ChatCommunityIncrementalSync` (`data[]`, `hasMore`, `nextCursor`) — **no pagination wrapper**.\n" +
      "- Store `nextCursor` as the next `after_ts` to page forward or re-sync.\n\n" +
      "**Jump-to-message** (`around=<messageId>`):\n" +
      "- Returns ~limit/2 messages on each side of the anchor (ascending, INCLUDING the target). Mutually exclusive with before_ts/after_ts.\n" +
      "- Adds **bidirectional continuation** on top of the `ChatCommunityMessagePage` shape so the client can page BOTH ways from the landing point: " +
      '`hasMoreOlder`/`hasMoreNewer` (booleans) and `olderCursor`/`newerCursor`. Feed `olderCursor` (a compound `"<ms>_<id>"`) back as `before_ts` to page older, ' +
      "and `newerCursor` (plain epoch-ms) back as `after_ts` to page newer — no new cursor scheme, the existing params consume them directly. " +
      "The legacy `hasMore`/`nextCursor` mirror the OLDER direction for single-direction clients. `pinnedMessage` is included as usual.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      ...messageTimelineParams({ incrementalSyncAfterTs: true }),
      {
        name: "before_seq",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 0 },
        description:
          "Preferred history cursor: returns messages with `sequenceNumber < before_seq` (newest-first, gap-safe). " +
          "Same contract as private/group. Takes precedence over before_ts/after_ts; mutually exclusive with after_seq. " +
          "Read the boundary from the oldest returned message's `sequenceNumber` (or `olderCursor` on a seq page).",
      },
      {
        name: "after_seq",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 0 },
        description:
          "Forward history paging: messages with `sequenceNumber > after_seq` (oldest-first). " +
          "Use this — NOT `after_ts`, which is the updatedAt-based incremental-sync mode — to walk toward the live edge.",
      },
      {
        name: "around",
        in: "query",
        required: false,
        schema: { type: "string", minLength: 1, maxLength: 100 },
        description:
          "Message ID to anchor a jump-to-message window. Returns ~limit/2 messages on each side (INCLUDING the target). " +
          "Mutually exclusive with before_ts/after_ts. The response adds `hasMoreOlder`/`hasMoreNewer` + `olderCursor` " +
          '(→ `before_ts`, compound `"<ms>_<id>"`) / `newerCursor` (→ `after_ts`, epoch-ms) so the client can page both directions.',
      },
      limitParam(30),
    ],
    responses: {
      "200": {
        description:
          "Messages. Shape depends on the mode: scroll mode returns `ChatCommunityMessagePage`; " +
          "incremental-sync mode (`after_ts`) returns `ChatCommunityIncrementalSync`.",
        content: {
          "application/json": {
            schema: {
              oneOf: [
                {
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
                {
                  allOf: [
                    { $ref: "#/components/schemas/ApiSuccessResponse" },
                    {
                      type: "object" as const,
                      properties: {
                        data: {
                          $ref: "#/components/schemas/ChatCommunityIncrementalSync",
                        },
                      },
                    },
                  ],
                },
              ],
            },
          },
        },
      },
      "400": badRequest,
      "401": unauthorized,
      "404": notFound,
    },
  },
  post: {
    tags: ["Chat — Community"],
    operationId: "sendCommunityMessage",
    summary: "Send a community message",
    description:
      "Sends a message into the community room. `roomId` (the chat room id) comes from the path; `communityId` (used for the broadcast + activity bump) is required in the body. The server broadcasts `community:message:new` to the `community:<communityId>` Socket.IO room, denormalizes community activity (orders GET /communities/mine), and bumps the room for every member. Requires active membership; the room must not be suspended. Idempotent via `clientMessageId` (a replay answers 200 with `idempotent: true`), matching the private/group send contract.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path" as const,
        required: true,
        schema: { type: "string" as const },
      },
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["communityId", "messageType"],
            properties: {
              communityId: {
                type: "string" as const,
                example: "comm_01j9x8vb2f3g4h5k6m7n8p9q",
                description:
                  "The community-service Community.id (used for the broadcast + activity bump).",
              },
              message: {
                type: "string" as const,
                maxLength: 4000,
                description:
                  "Plain-text body (max 4000 chars). Required for TEXT messages.",
              },
              messageType: {
                type: "string" as const,
                enum: [
                  "TEXT",
                  "IMAGE",
                  "VIDEO",
                  "AUDIO",
                  "GIF",
                  "VOICE",
                  "DOCUMENT",
                  "STICKER",
                  "LOCATION",
                  "CONTACT",
                ],
                description:
                  "Community message kind. Accepted case-insensitively; normalized to UPPER-CASE on the wire. " +
                  "TEXT — plain text (requires `message`). " +
                  "IMAGE — photo(s) (requires `media.files`, mime image/*). " +
                  "VIDEO — video clip (requires `media.files`, mime video/*). " +
                  "AUDIO — audio file (requires `media.files`, mime audio/*). " +
                  "GIF — animated GIF (requires `media.files`, mime image/gif or video/mp4). " +
                  "VOICE — voice note (requires `media.files`, mime audio/ogg or audio/aac, include `durationMs` + `waveform`). " +
                  "DOCUMENT — file attachment (requires `media.files`, any MIME). " +
                  "STICKER — sticker asset (requires `sticker`). " +
                  "LOCATION — GPS share (requires `location`). " +
                  "CONTACT — contact card (requires `contact`).",
              },
              parentMessageId: {
                type: "string" as const,
                nullable: true,
                example: "668f1a2b3c4d5e6f7a8b9c01",
                description:
                  "ObjectId of the message being replied to (thread reply). " +
                  "When set, the response `quoteData` will contain a snapshot of the parent message " +
                  "(senderId, senderName, contentType, preview text/media). " +
                  'Example: `"668f1a2b3c4d5e6f7a8b9c01"`. Pass null or omit for a top-level message.',
              },
              clientMessageId: {
                type: "string" as const,
                description:
                  "Idempotency key (UUID v4 or any unique string). " +
                  "If the same key is sent twice, the second call returns 200 with `idempotent: true` and the original message — no duplicate is stored.",
              },
              media: {
                type: "object" as const,
                description:
                  "Structured media attachments. Required for IMAGE, VIDEO, AUDIO, GIF, VOICE, and DOCUMENT messages.",
                properties: {
                  files: {
                    type: "array" as const,
                    description:
                      "One or more file objects. For IMAGE up to 10 files; other types 1 file each. " +
                      "Provide either `objectKey` (preferred — object-storage key, resolved to presigned URL on read) " +
                      "or `url` (direct CDN / presigned upload URL). Never persist the resolved URL — it is time-limited.",
                    items: {
                      type: "object" as const,
                      required: ["mime", "size", "name"],
                      properties: {
                        objectKey: {
                          type: "string" as const,
                          description:
                            "Object-storage key returned by the media-upload endpoint. " +
                            "Preferred over `url` — the server resolves it to a presigned GET URL at read time.",
                          example: "media/images/comm_01j9x8vb/668f1a2b.jpg",
                        },
                        url: {
                          type: "string" as const,
                          description:
                            "Direct CDN or presigned URL. Use when objectKey is unavailable.",
                          example:
                            "https://cdn.aimess.me/media/images/comm_01j9x8vb/668f1a2b.jpg",
                        },
                        mime: {
                          type: "string" as const,
                          description:
                            "MIME type. Supported: image/jpeg, image/png, image/webp, image/gif, " +
                            "video/mp4, video/quicktime, video/webm, audio/ogg, audio/aac, audio/mpeg, " +
                            "audio/flac, application/pdf, application/msword, text/plain, and more.",
                          example: "image/jpeg",
                        },
                        size: {
                          type: "integer" as const,
                          description:
                            "File size in bytes. Limits: images ≤10 MB each; video ≤100 MB; audio/voice ≤50 MB; documents ≤50 MB.",
                          example: 204800,
                        },
                        name: {
                          type: "string" as const,
                          description:
                            "Original filename (sanitized server-side).",
                          example: "photo.jpg",
                        },
                        width: {
                          type: "integer" as const,
                          nullable: true,
                          description:
                            "Pixel width. Provide for images and videos so the client can pre-allocate layout space before the asset loads.",
                          example: 1920,
                        },
                        height: {
                          type: "integer" as const,
                          nullable: true,
                          description: "Pixel height.",
                          example: 1080,
                        },
                        durationMs: {
                          type: "integer" as const,
                          nullable: true,
                          description:
                            "Duration in milliseconds. Required for VOICE (≤300 000 ms = 5 min) and VIDEO (≤180 000 ms = 3 min). Also provide for AUDIO.",
                          example: 34500,
                        },
                        blurhash: {
                          type: "string" as const,
                          nullable: true,
                          description:
                            "BlurHash encoded placeholder string for images. Rendered as a low-res placeholder while the real image loads. " +
                            "Generate with the @woltapp/blurhash library (4×3 or 4×4 components). " +
                            'Example: `"LqKk3+%NIXxu~qxt%MWBt7WBNGjY"`.',
                          example: "LqKk3+%NIXxu~qxt%MWBt7WBNGjY",
                        },
                        waveform: {
                          type: "array" as const,
                          nullable: true,
                          items: {
                            type: "number" as const,
                            minimum: 0,
                            maximum: 1,
                          },
                          description:
                            "Normalised amplitude samples in [0, 1], exactly 100 elements. " +
                            "Required for VOICE messages — drives the in-chat waveform scrubber bar. " +
                            "Compute from the raw PCM/OGG before upload (e.g. with ffmpeg or the `waveform-data` npm package).",
                          example: [
                            0.1, 0.3, 0.6, 0.9, 0.7, 0.4, 0.2, 0.5, 0.8, 0.6,
                            0.3, 0.2, 0.4, 0.7, 0.9, 0.8, 0.5, 0.3, 0.1, 0.2,
                          ],
                        },
                      },
                    },
                  },
                },
              },
              location: {
                $ref: "#/components/schemas/ChatLocationAttachment",
              },
              contact: { $ref: "#/components/schemas/ChatContactAttachment" },
              sticker: { $ref: "#/components/schemas/ChatSticker" },
            },
          },
          examples: {
            "text-simple": {
              summary: "TEXT — plain text",
              value: {
                communityId: "comm_01j9x8vb2f3g4h5k6m7n8p9q",
                messageType: "TEXT",
                message: "Hey everyone! 👋 Welcome to the community.",
                clientMessageId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
              },
            },
            "text-reply": {
              summary: "TEXT — reply to another message (parentMessageId)",
              description:
                "Use `parentMessageId` to thread a reply. The response will include `quoteData` with a snapshot of the parent message.",
              value: {
                communityId: "comm_01j9x8vb2f3g4h5k6m7n8p9q",
                messageType: "TEXT",
                message: "Totally agree with that! 🙌",
                // parentMessageId: ObjectId of the message you are replying to
                // Get this from the id/messageId field of any ChatCommunityMessage or ChatCommunityWireMessage
                parentMessageId: "668f1a2b3c4d5e6f7a8b9c01",
                clientMessageId: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
              },
            },
            "image-single": {
              summary: "IMAGE — single photo",
              value: {
                communityId: "comm_01j9x8vb2f3g4h5k6m7n8p9q",
                messageType: "IMAGE",
                message: "Check out this view! 🌅",
                media: {
                  files: [
                    {
                      objectKey: "media/images/comm_01j9x8vb/668f1a2b.jpg",
                      mime: "image/jpeg",
                      size: 204800,
                      name: "sunset.jpg",
                      width: 1920,
                      height: 1080,
                      blurhash: "LqKk3+%NIXxu~qxt%MWBt7WBNGjY",
                    },
                  ],
                },
                clientMessageId: "c3d4e5f6-a7b8-9012-cdef-123456789012",
              },
            },
            "image-multi": {
              summary: "IMAGE — multiple photos (up to 10)",
              value: {
                communityId: "comm_01j9x8vb2f3g4h5k6m7n8p9q",
                messageType: "IMAGE",
                message: "Event highlights 🎉",
                media: {
                  files: [
                    {
                      objectKey: "media/images/comm_01j9x8vb/img1.jpg",
                      mime: "image/jpeg",
                      size: 512000,
                      name: "event1.jpg",
                      width: 1080,
                      height: 1080,
                      blurhash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4",
                    },
                    {
                      objectKey: "media/images/comm_01j9x8vb/img2.jpg",
                      mime: "image/jpeg",
                      size: 483000,
                      name: "event2.jpg",
                      width: 1080,
                      height: 1080,
                      blurhash: "LGF5?xYk^6#M@-5c,1J5@[or[Q6.",
                    },
                  ],
                },
                clientMessageId: "d4e5f6a7-b8c9-0123-defa-234567890123",
              },
            },
            video: {
              summary: "VIDEO — video clip (≤100 MB, ≤3 min)",
              value: {
                communityId: "comm_01j9x8vb2f3g4h5k6m7n8p9q",
                messageType: "VIDEO",
                media: {
                  files: [
                    {
                      objectKey: "media/videos/comm_01j9x8vb/668f2b3c.mp4",
                      mime: "video/mp4",
                      size: 8388608,
                      name: "highlight_reel.mp4",
                      width: 1280,
                      height: 720,
                      durationMs: 47300,
                    },
                  ],
                },
                clientMessageId: "e5f6a7b8-c9d0-1234-efab-345678901234",
              },
            },
            audio: {
              summary: "AUDIO — audio file (mp3 / aac / flac)",
              value: {
                communityId: "comm_01j9x8vb2f3g4h5k6m7n8p9q",
                messageType: "AUDIO",
                media: {
                  files: [
                    {
                      objectKey: "media/audio/comm_01j9x8vb/668f3c4d.mp3",
                      mime: "audio/mpeg",
                      size: 3145728,
                      name: "community_podcast_ep1.mp3",
                      durationMs: 198000,
                    },
                  ],
                },
                clientMessageId: "f6a7b8c9-d0e1-2345-fabc-456789012345",
              },
            },
            "voice-note": {
              summary: "VOICE — voice note (ogg/aac, ≤5 min, with waveform)",
              description:
                "Voice notes require `durationMs` and `waveform` (100 normalised amplitude samples). " +
                "The waveform drives the in-chat scrubber bar on the client.",
              value: {
                communityId: "comm_01j9x8vb2f3g4h5k6m7n8p9q",
                messageType: "VOICE",
                media: {
                  files: [
                    {
                      objectKey: "media/voice/comm_01j9x8vb/668f4d5e.ogg",
                      mime: "audio/ogg",
                      size: 98304,
                      name: "voice_note.ogg",
                      durationMs: 34500,
                      waveform: [
                        0.1, 0.3, 0.6, 0.9, 0.7, 0.4, 0.2, 0.5, 0.8, 0.6, 0.3,
                        0.2, 0.4, 0.7, 0.9, 0.8, 0.5, 0.3, 0.1, 0.2, 0.4, 0.6,
                        0.8, 0.7, 0.5, 0.3, 0.1, 0.4, 0.6, 0.9, 0.8, 0.7, 0.5,
                        0.3, 0.2, 0.4, 0.6, 0.8, 0.7, 0.5, 0.3, 0.2, 0.4, 0.7,
                        0.9, 0.8, 0.6, 0.4, 0.2, 0.3, 0.5, 0.7, 0.9, 0.8, 0.6,
                        0.4, 0.2, 0.1, 0.3, 0.5, 0.7, 0.6, 0.4, 0.2, 0.1, 0.3,
                        0.5, 0.7, 0.8, 0.9, 0.7, 0.5, 0.3, 0.1, 0.2, 0.4, 0.6,
                        0.8, 0.9, 0.7, 0.5, 0.3, 0.2, 0.4, 0.6, 0.7, 0.8, 0.6,
                        0.4, 0.2, 0.1, 0.3, 0.5, 0.6, 0.7, 0.5, 0.3, 0.2, 0.1,
                        0.2,
                      ],
                    },
                  ],
                },
                clientMessageId: "a7b8c9d0-e1f2-3456-abcd-567890123456",
              },
            },
            gif: {
              summary: "GIF — animated GIF",
              value: {
                communityId: "comm_01j9x8vb2f3g4h5k6m7n8p9q",
                messageType: "GIF",
                media: {
                  files: [
                    {
                      objectKey: "media/gifs/comm_01j9x8vb/668f5e6f.gif",
                      mime: "image/gif",
                      size: 2097152,
                      name: "celebration.gif",
                      width: 480,
                      height: 270,
                    },
                  ],
                },
                clientMessageId: "b8c9d0e1-f2a3-4567-bcde-678901234567",
              },
            },
            document: {
              summary: "DOCUMENT — file attachment (PDF / doc / text)",
              value: {
                communityId: "comm_01j9x8vb2f3g4h5k6m7n8p9q",
                messageType: "DOCUMENT",
                message: "Community guidelines v2.0",
                media: {
                  files: [
                    {
                      objectKey: "media/docs/comm_01j9x8vb/668f6f7a.pdf",
                      mime: "application/pdf",
                      size: 1048576,
                      name: "community_guidelines_v2.pdf",
                    },
                  ],
                },
                clientMessageId: "c9d0e1f2-a3b4-5678-cdef-789012345678",
              },
            },
            sticker: {
              summary: "STICKER — sticker from a pack",
              value: {
                communityId: "comm_01j9x8vb2f3g4h5k6m7n8p9q",
                messageType: "STICKER",
                sticker: {
                  packId: "sticker_pack_celebrations_v1",
                  stickerId: "sticker_party_01",
                  objectKey: "stickers/celebrations/party_01.webp",
                },
                clientMessageId: "d0e1f2a3-b4c5-6789-defa-890123456789",
              },
            },
            location: {
              summary: "LOCATION — GPS location share",
              value: {
                communityId: "comm_01j9x8vb2f3g4h5k6m7n8p9q",
                messageType: "LOCATION",
                location: {
                  lat: 28.6139,
                  lng: 77.209,
                  placeName: "India Gate",
                  placeAddress: "Rajpath, New Delhi, India 110001",
                },
                clientMessageId: "e1f2a3b4-c5d6-7890-efab-901234567890",
              },
            },
            contact: {
              summary: "CONTACT — contact card share",
              value: {
                communityId: "comm_01j9x8vb2f3g4h5k6m7n8p9q",
                messageType: "CONTACT",
                contact: {
                  name: "Rajesh Sharma",
                  phone: "+91 98765 43210",
                  userId: "usr_01j8r5t2q3w4e5r6t7y8u9i0",
                },
                clientMessageId: "f2a3b4c5-d6e7-8901-fabc-012345678901",
              },
            },
          },
        },
      },
    },
    responses: {
      "201": {
        description:
          "Message sent (fresh insert). The data payload is the canonical community wire message (byte-identical to the Socket.IO `community:message:new`) plus an `idempotent` flag.",
        content: {
          "application/json": {
            schema: communitySendResponseSchema,
          },
        },
      },
      "200": {
        description:
          "Idempotent replay — `clientMessageId` matched an existing message; the original is returned with `idempotent: true`.",
        content: {
          "application/json": {
            schema: communitySendResponseSchema,
          },
        },
      },
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

const communityRoomSync = {
  get: {
    tags: ["Chat — Community"],
    operationId: "syncCommunityMessages",
    summary: "Community incremental sync (REST)",
    description: [
      "Returns every message in the room whose `updatedAt >= since_ts` — new",
      "messages, edits, reaction changes, **and tombstones** (deleted messages).",
      "Results are sorted oldest-first by `updatedAt`.",
      "",
      "### When to use",
      "Call this endpoint when the app returns to the foreground after being",
      "backgrounded. Pass the highest `updatedAt` timestamp you have stored",
      "locally as `since_ts`; on the next call pass the returned `nextCursor`.",
      "",
      "### Response shape",
      "```json",
      '{ "data": [...], "hasMore": true, "nextCursor": "1718000000000" }',
      "```",
      "Feed `nextCursor` back as `since_ts` to page forward when `hasMore` is",
      "`true`. When `hasMore` is `false` you are fully caught up.",
      "",
      "### Tombstones",
      "Deleted messages are **included** (`isDeleted: true`). The client should",
      "remove them from local storage when it sees `isDeleted: true`.",
      "",
      "### Banned members",
      "A BANNED member may still call this endpoint but only ever catches up on",
      "events at or before their ban timestamp — anything created after the ban",
      "is never returned, even across multiple sync pages.",
      "",
      "**Rate limit:** 120 requests / min per user.",
    ].join("\n"),
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "The community room ObjectId",
      },
      {
        name: "since_ts",
        in: "query",
        required: true,
        schema: { type: "integer", format: "int64", example: 1718000000000 },
        description:
          "Lower bound (inclusive) for `updatedAt`, epoch milliseconds.",
      },
      {
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        description: "Max events to return per page (1–200, default 50).",
      },
    ],
    responses: {
      ...successResponse(
        "Incremental sync page",
        "ChatCommunityIncrementalSync"
      ),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
    },
  },
};

const communityMessageDelete = {
  delete: {
    tags: ["Chat — Community"],
    operationId: "deleteCommunityMessage",
    summary: "Delete community message for all",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "messageId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      ...successResponse("Message deleted", "ChatCommunityDeleteTombstone"),
      "401": unauthorized,
      "403": forbidden,
    },
  },
};

// =============================================================================
// Community room pins
// =============================================================================
const communityPinMessage = {
  post: {
    tags: ["Chat — Community"],
    operationId: "pinCommunityMessageMod",
    summary: "Pin a community message (MODERATOR+)",
    description:
      "Pins a message in a community room. Requires MODERATOR or ADMIN role.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["messageId", "communityId"],
            properties: {
              messageId: { type: "string" as const },
              communityId: { type: "string" as const },
            },
          },
        },
      },
    },
    responses: {
      ...successResponse("Message pinned", "CommunityMessagePinWithCount"),
      "400": {
        description: "CHAT_PIN_LIMIT_REACHED",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
          },
        },
      },
      "401": unauthorized,
      "403": {
        description: "CHAT_INSUFFICIENT_PERMISSIONS",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
          },
        },
      },
      "404": {
        description: "CHAT_MESSAGE_NOT_FOUND",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
          },
        },
      },
    },
  },
};

const communityUnpinMessage = {
  delete: {
    tags: ["Chat — Community"],
    operationId: "unpinCommunityMessageMod",
    summary: "Unpin a community message (MODERATOR+)",
    description:
      "Unpins a message from a community room. Requires MODERATOR or ADMIN role. Pass `communityId` as a query parameter.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      {
        name: "messageId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      {
        name: "communityId",
        in: "query",
        required: true,
        schema: { type: "string" as const, minLength: 1 },
        description: "ID of the community the room belongs to.",
      },
    ],
    responses: {
      ...successResponse("Message unpinned", "CommunityMessageUnpinResult"),
      "401": unauthorized,
      "403": {
        description: "CHAT_INSUFFICIENT_PERMISSIONS",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
          },
        },
      },
      "404": {
        description: "CHAT_PIN_NOT_FOUND",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
          },
        },
      },
    },
  },
};

// =============================================================================
// GET /chat/community/rooms/{roomId}/messages/{messageId}/context
// =============================================================================
const communityMessageContext = {
  get: {
    tags: ["Chat — Community"],
    operationId: "getCommunityMessageContext",
    summary: "Get navigation anchor for a community message",
    description: [
      "Returns a compound cursor anchor so the FE can scroll to the pinned message.",
      "",
      "**Use case:** tap the pin banner → call this endpoint → use the returned `anchor.beforeCursor` as `?cursor=` when fetching the community message history.",
      "",
      "Always returns HTTP 200. When `isAvailable` is `false` the original message has been deleted or does not exist; display a 'message unavailable' placeholder.",
      "",
      "Requires community membership.",
    ].join("\n"),
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" as const },
        description: "Community room ID (equals communityId).",
      },
      {
        name: "messageId",
        in: "path",
        required: true,
        schema: { type: "string" as const },
        description: "The message to navigate to.",
      },
    ],
    responses: {
      "200": {
        description: "Message context anchor",
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
                      required: ["messageId", "roomId", "isAvailable"],
                      properties: {
                        messageId: { type: "string" as const },
                        roomId: { type: "string" as const },
                        isAvailable: {
                          type: "boolean" as const,
                          description:
                            "`true` — message exists. `false` — deleted or not found.",
                        },
                        anchor: {
                          type: "object" as const,
                          nullable: true,
                          description:
                            "Present when `isAvailable` is true. Pass `beforeCursor` as `?cursor=` to the community history endpoint.",
                          properties: {
                            beforeCursor: {
                              type: "string" as const,
                              description:
                                'Compound `"<createdAt_ms>_<messageId>"` cursor.',
                            },
                            afterCursor: {
                              type: "string" as const,
                              description:
                                "Same value as `beforeCursor` (reserved).",
                            },
                          },
                        },
                        error: {
                          type: "object" as const,
                          nullable: true,
                          description: "Present when `isAvailable` is false.",
                          properties: {
                            code: {
                              type: "string" as const,
                              example: "MESSAGE_NOT_FOUND",
                            },
                            message: {
                              type: "string" as const,
                              example: "Message doesn't exist",
                            },
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
      "403": forbidden,
    },
  },
};

const communityGetPins = {
  get: {
    tags: ["Chat — Community"],
    operationId: "listCommunityPinnedMessages",
    summary: "List pinned messages in a community room",
    description:
      "Cursor-paginated list of pinned messages for a community room.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      cursorParam(),
      limitParam(20),
    ],
    responses: {
      ...successResponse("Pinned messages", "CommunityMessagePinList"),
      "401": unauthorized,
    },
  },
};

// =============================================================================
// Message search (private / group / community)
// =============================================================================
function searchPath(tag: string, summary: string) {
  return {
    get: {
      tags: [tag],
      summary,
      description:
        "Index-backed full-text search over message text in the room, newest-first.\n\n" +
        "Matching uses a MongoDB `$text` index, so terms match at WORD granularity — " +
        "a partial word returns nothing until it is complete. Clients bridge that gap " +
        "by filtering their local cache while the user types.\n\n" +
        "Pagination is an opaque `(createdAt, _id)` keyset cursor, not an offset: pass " +
        "the previous response's `nextCursor` back as `cursor`. Stable under concurrent " +
        "inserts, so pages never duplicate or drop rows. `page`/`skip` are no longer accepted.\n\n" +
        "Each item carries `searchScore` (MongoDB textScore) for client-side relevance " +
        "ranking and highlighting, plus the `id` and `sequenceNumber` needed to navigate " +
        "via `GET .../messages?around={id}`.",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "roomId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "q",
          in: "query",
          required: true,
          schema: { type: "string" },
          description: "Search term. Matched at word granularity.",
        },
        {
          name: "cursor",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Opaque keyset cursor `<createdAtMs>_<objectId>` taken from the previous " +
            "response's `nextCursor`. Omit for the first page.",
        },
        limitParam(30),
      ],
      responses: {
        ...successResponse(
          "Matching messages",
          tag.includes("Community")
            ? "ChatCommunityMessageList"
            : "ChatMessageList"
        ),
        "401": unauthorized,
      },
    },
  };
}

const privateSearch = searchPath("Chat — Private", "Search private messages");
const groupSearch = searchPath("Chat — Groups", "Search group messages");
const communitySearch2 = searchPath(
  "Chat — Community",
  "Search community messages"
);

// =============================================================================
// Private — forward & reactions
// =============================================================================
const privateMessageForward = {
  post: {
    tags: ["Chat — Private"],
    operationId: "forwardPrivateMessage",
    summary: "Forward private message",
    description:
      "Forwards a message to another private room. Idempotent via `clientMessageId`.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" as const },
      },
      {
        name: "messageId",
        in: "path",
        required: true,
        schema: { type: "string" as const },
      },
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["targetRoomId", "receiverId"],
            properties: {
              targetRoomId: { type: "string" as const },
              receiverId: { type: "string" as const },
              clientMessageId: { type: "string" as const },
            },
          },
        },
      },
    },
    responses: {
      ...successResponse("Message forwarded", "ChatWireMessage", "201"),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

const communityMessageForward = {
  post: {
    tags: ["Chat — Community"],
    operationId: "forwardCommunityMessage",
    summary: "Forward community message",
    description:
      "Forwards a community message into another community room. Path `roomId` is the **source** room. Idempotent via optional `clientMessageId`.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" as const },
        description: "Source community room id.",
      },
      {
        name: "messageId",
        in: "path",
        required: true,
        schema: { type: "string" as const },
      },
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            $ref: "#/components/schemas/ChatCommunityForwardRequest",
          },
        },
      },
    },
    responses: {
      ...successResponse(
        "Message forwarded",
        "ChatCommunityWireMessage",
        "201"
      ),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

const privateMessageReactions = {
  get: {
    tags: ["Chat — Private"],
    operationId: "getPrivateMessageReactions",
    summary: "Get reactions on a private message",
    description:
      "Returns reactions grouped by emoji with user details and a `selfReacted` flag.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" as const },
      },
      {
        name: "messageId",
        in: "path",
        required: true,
        schema: { type: "string" as const },
      },
    ],
    responses: {
      ...successResponse("Reactions", "ChatMessageReactions"),
      "401": unauthorized,
      "404": notFound,
    },
  },
  post: {
    tags: ["Chat — Private"],
    operationId: "addPrivateMessageReaction",
    summary: "Add a reaction to a private message",
    description:
      "Adds the caller's `emoji` reaction. **Idempotent**: re-adding an emoji the caller already reacted with is a no-op (no duplicate). The caller must be a participant of the room. " +
      "On success the server broadcasts a `message:reaction` Socket.IO event on `conv:<roomId>` carrying the same `reactions` array as the REST response. To remove a reaction, use `DELETE .../reactions/{emoji}`.",
    security: [{ bearerAuth: [] }],
    parameters: [roomIdPathParam, messageIdPathParam],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatReactRequest" },
        },
      },
    },
    responses: {
      ...successResponse("Reaction added", "ChatReactResponse"),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

const privateMessageRemoveReaction = {
  delete: {
    tags: ["Chat — Private"],
    operationId: "removePrivateMessageReaction",
    summary: "Remove a reaction from a private message",
    description:
      "Removes the caller's `emoji` reaction. **Idempotent**: removing an emoji the caller has not reacted with is a no-op. The caller must be a participant of the room. " +
      "On success the server broadcasts a `message:reaction` Socket.IO event on `conv:<roomId>` carrying the same `reactions` array as the REST response.",
    security: [{ bearerAuth: [] }],
    parameters: [
      roomIdPathParam,
      messageIdPathParam,
      {
        name: "emoji",
        in: "path" as const,
        required: true,
        schema: { type: "string" as const, minLength: 1, maxLength: 32 },
        description: "URL-encoded Unicode emoji to remove.",
      },
    ],
    responses: {
      ...successResponse("Reaction removed", "ChatReactResponse"),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

// =============================================================================
// GET /chat/messages/{messageId}/context — unified cross-type navigation API
// =============================================================================
const unifiedMessageContext = {
  get: {
    tags: ["Chat — Messages"],
    operationId: "getMessageContext",
    summary:
      "Get a message navigation context anchor (private, group, or community)",
    description: [
      "Single endpoint for every 'locate and scroll to a message I don't currently have loaded' use case — reply-tap, pinned-message-tap, search-result-tap, a shared/forwarded message deep link, or a push-notification deep link.",
      "",
      "Pass the conversation type and room id alongside the message id — the same triple already carried by a reply's `quoteData`, a pin record, a search hit, or a notification's `navigation` payload.",
      "",
      "**Use case:** resolve the (conversationType, roomId, messageId) triple from the source (reply/pin/search/notification) → call this endpoint → either call the conversation's `GET .../messages?around=<messageId>` (simplest), or page from `anchor.sequenceNumber` via `?before_seq=`/`?after_seq=` (private/group), or from `anchor.beforeCursor`/`afterCursor` via `?before_ts=`/`?after_ts=` (all three).",
      "",
      "Always returns HTTP 200 for a content-level result. When `isAvailable` is `false` the target message has been deleted or does not exist (or does not belong to the given room); display a 'message unavailable' placeholder. Access failures (not a participant/member of the room, or the room doesn't exist) return a normal 401/403/404 instead.",
    ].join("\n"),
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "messageId",
        in: "path" as const,
        required: true,
        schema: { type: "string" as const },
        description: "The message to navigate to.",
      },
      {
        name: "conversationType",
        in: "query" as const,
        required: true,
        schema: {
          type: "string" as const,
          enum: ["PRIVATE", "GROUP", "COMMUNITY"],
        },
        description: "The conversation type the message belongs to.",
      },
      {
        name: "roomId",
        in: "query" as const,
        required: true,
        schema: { type: "string" as const },
        description:
          "The room the message is claimed to belong to (private room id, group room id, or community id). Validated server-side — a mismatched roomId returns `isAvailable: false`, never a foreign message's content.",
      },
    ],
    responses: {
      "200": {
        description: "Message context anchor",
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
                        "messageId",
                        "roomId",
                        "conversationType",
                        "isAvailable",
                      ],
                      properties: {
                        messageId: { type: "string" as const },
                        roomId: { type: "string" as const },
                        conversationType: {
                          type: "string" as const,
                          enum: ["PRIVATE", "GROUP", "COMMUNITY"],
                        },
                        isAvailable: {
                          type: "boolean" as const,
                          description:
                            "`true` — message exists in this room. `false` — deleted, not found, or belongs to a different room.",
                        },
                        anchor: {
                          type: "object" as const,
                          nullable: true,
                          description: "Present when `isAvailable` is true.",
                          properties: {
                            sequenceNumber: {
                              type: "integer" as const,
                              description:
                                "Room-local monotonic sequence number (private/group only). Pass as `?before_seq=`/`?after_seq=`.",
                            },
                            beforeCursor: {
                              type: "string" as const,
                              description:
                                'Compound `"<createdAt_ms>_<messageId>"` cursor for `?before_ts=`.',
                            },
                            afterCursor: {
                              type: "string" as const,
                              description:
                                "Same value as `beforeCursor` (reserved for `?after_ts=`).",
                            },
                          },
                        },
                        error: {
                          type: "object" as const,
                          nullable: true,
                          description: "Present when `isAvailable` is false.",
                          properties: {
                            code: {
                              type: "string" as const,
                              example: "MESSAGE_NOT_FOUND",
                            },
                            message: {
                              type: "string" as const,
                              example: "Message doesn't exist",
                            },
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
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

// =============================================================================
// Groups — forward & reactions
// =============================================================================
const groupMessageForward = {
  post: {
    tags: ["Chat — Groups"],
    operationId: "forwardGroupMessage",
    summary: "Forward group message",
    description:
      "Forwards a message to another room. Idempotent via `clientMessageId`.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" as const },
      },
      {
        name: "messageId",
        in: "path",
        required: true,
        schema: { type: "string" as const },
      },
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["targetRoomId"],
            properties: {
              targetRoomId: { type: "string" as const },
              clientMessageId: { type: "string" as const },
              senderName: { type: "string" as const },
              senderAvatar: { type: "string" as const },
            },
          },
        },
      },
    },
    responses: {
      ...successResponse("Message forwarded", "ChatWireMessage", "201"),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

const groupMessageReactions = {
  get: {
    tags: ["Chat — Groups"],
    operationId: "getGroupMessageReactions",
    summary: "Get reactions on a group message",
    description:
      "Returns reactions grouped by emoji with user details and a `selfReacted` flag.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" as const },
      },
      {
        name: "messageId",
        in: "path",
        required: true,
        schema: { type: "string" as const },
      },
    ],
    responses: {
      ...successResponse("Reactions", "ChatMessageReactions"),
      "401": unauthorized,
      "404": notFound,
    },
  },
  post: {
    tags: ["Chat — Groups"],
    operationId: "addGroupMessageReaction",
    summary: "Add a reaction to a group message",
    description:
      "Adds the caller's `emoji` reaction. **Idempotent**: re-adding an emoji the caller already reacted with is a no-op (no duplicate). The caller must be an active member of the group. " +
      "On success the server broadcasts a `message:reaction` Socket.IO event on `conv:<roomId>` carrying the same `reactions` array as the REST response. To remove a reaction, use `DELETE .../reactions/{emoji}`.",
    security: [{ bearerAuth: [] }],
    parameters: [roomIdPathParam, messageIdPathParam],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatReactRequest" },
        },
      },
    },
    responses: {
      ...successResponse("Reaction added", "ChatReactResponse"),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

const groupMessageRemoveReaction = {
  delete: {
    tags: ["Chat — Groups"],
    operationId: "removeGroupMessageReaction",
    summary: "Remove a reaction from a group message",
    description:
      "Removes the caller's `emoji` reaction. **Idempotent**: removing an emoji the caller has not reacted with is a no-op. The caller must be an active member of the group. " +
      "On success the server broadcasts a `message:reaction` Socket.IO event on `conv:<roomId>` carrying the same `reactions` array as the REST response.",
    security: [{ bearerAuth: [] }],
    parameters: [
      roomIdPathParam,
      messageIdPathParam,
      {
        name: "emoji",
        in: "path" as const,
        required: true,
        schema: { type: "string" as const, minLength: 1, maxLength: 32 },
        description: "URL-encoded Unicode emoji to remove.",
      },
    ],
    responses: {
      ...successResponse("Reaction removed", "ChatReactResponse"),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

// =============================================================================
// Calls
// =============================================================================
const callHistory = {
  get: {
    tags: ["Chat — Calls"],
    operationId: "getCallHistory",
    summary: "Get call history",
    description:
      "Cursor-paginated list of calls the authenticated user participated in, ordered by `initiatedAt` descending.",
    security: [{ bearerAuth: [] }],
    parameters: [cursorParam(), limitParam(20, 50)],
    responses: {
      ...successResponse("Call history", "ChatCallList"),
      "401": unauthorized,
    },
  },
};

const callById = {
  get: {
    tags: ["Chat — Calls"],
    operationId: "getCallDetails",
    summary: "Get call details",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "callId",
        in: "path",
        required: true,
        schema: { type: "string" as const },
      },
    ],
    responses: {
      ...successResponse("Call details", "ChatCall"),
      "401": unauthorized,
      "403": {
        description:
          "You were not a participant in this call (CALL_NOT_PARTICIPANT).",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
          },
        },
      },
      "404": notFound,
    },
  },
};

// =============================================================================
// Community message pin / unpin
// =============================================================================
const communityMessagePin = {
  post: {
    tags: ["Chat — Community"],
    operationId: "pinCommunityMessageAdmin",
    summary: "Pin a community message (moderator/admin only)",
    description:
      "Pins a message in the community room. Moderator or admin role required. Limit enforced by PIN_LIMIT_PER_ROOM.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path" as const,
        required: true,
        schema: { type: "string" as const },
        description: "Community room ID",
      },
      {
        name: "messageId",
        in: "path" as const,
        required: true,
        schema: { type: "string" as const },
        description: "Message ID to pin",
      },
    ],
    responses: {
      ...successResponse("Message pinned", "CommunityPinResponse"),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
  delete: {
    tags: ["Chat — Community"],
    operationId: "unpinCommunityMessageAdmin",
    summary: "Unpin a community message (moderator/admin only)",
    description:
      "Unpins a previously pinned message. Moderator or admin role required.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path" as const,
        required: true,
        schema: { type: "string" as const },
        description: "Community room ID",
      },
      {
        name: "messageId",
        in: "path" as const,
        required: true,
        schema: { type: "string" as const },
        description: "Message ID to unpin",
      },
    ],
    responses: {
      ...successResponse("Message unpinned", "CommunityPinResponse"),
      "401": unauthorized,
      "403": forbidden,
      "404": notFound,
    },
  },
};

// =============================================================================
// Assemble all chat paths
// =============================================================================
// --- Unified inbox · bulk (multi-select) operations -------------------------
// Direct counterparts of POST /communities/{leave,mute,read}/bulk. One call
// may mix PRIVATE (`prv_…`) and GROUP (`grp_…`) rows; the type comes from the
// id prefix, never from the client. Every item is routed to the SAME
// single-conversation code path the one-off endpoint uses, so bulk and
// individual calls produce identical writes, socket events and pushes.

const conversationsBulkLeave = {
  post: {
    tags: ["Chat — Inbox"],
    operationId: "bulkLeaveConversations",
    summary: "Bulk leave or delete conversations",
    description:
      "Removes multiple conversations from the caller's list in one call. " +
      "Items are processed independently — a failure for one never rolls back " +
      "the others, and the response is always `200 OK`. Inspect each item's " +
      "`status`/`errorCode` and the `summary`.\n\n" +
      "**PRIVATE rows** always run delete-for-me (`DELETE /chat/private/rooms/{roomId}`): " +
      "the conversation leaves the caller's list, the peer is unaffected, " +
      "history stays on the server and the room reappears if a new message " +
      "arrives. `conv:deleted` is emitted to the caller's other devices.\n\n" +
      "**GROUP rows** follow `groupAction`: `LEAVE` (default) removes " +
      "membership for real (`group:removed` to the leaver, " +
      "`group:member:removed` + MEMBER_LEFT system message to the rest, " +
      "member count decremented — the group does not return on reload), " +
      "`DELETE` only clears the caller's history and keeps membership.\n\n" +
      "A group ADMIN cannot leave while other members remain — that item " +
      "fails with `OWNER_CANNOT_LEAVE` (mirrors community's " +
      "`ADMIN_CANNOT_LEAVE`); transfer ownership or disband first.",
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatBulkLeaveRequest" },
          examples: {
            mixed: {
              summary: "Two private chats and two groups in one call",
              value: {
                roomIds: [
                  "prv_abc123",
                  "prv_def456",
                  "grp_aaa111",
                  "grp_bbb222",
                ],
                groupAction: "LEAVE",
              },
            },
          },
        },
      },
    },
    responses: {
      ...successResponse("Bulk leave processed", "ChatBulkLeaveResult"),
      "400": badRequest,
      "401": unauthorized,
      "429": {
        description: "Rate limited (30 bulk operations per minute per user)",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
          },
        },
      },
    },
  },
};

const conversationsBulkMute = {
  post: {
    tags: ["Chat — Inbox"],
    operationId: "bulkMuteConversations",
    summary: "Bulk mute or unmute conversations",
    description:
      "Mutes or unmutes multiple conversations for the caller. This is the " +
      "**conversation** mute (the list row's bell), NOT the group/community " +
      "moderation mute that silences another member — see " +
      "`POST /chat/group-members/mute-member` for that.\n\n" +
      "Mute suppresses **push notifications only**. Everything else keeps " +
      "working exactly as before: messages still arrive over the socket and " +
      "are still persisted, the unread count still increments, the row still " +
      "bumps to the top of the list on new activity, read receipts, typing " +
      "and media all continue.\n\n" +
      "`durationMinutes` is resolved against the SERVER clock; omit or null " +
      "for an indefinite mute. Expiry is applied **lazily** at push time, so a " +
      "timed mute lapses on its own — no sweeper, no refresh, no re-login.\n\n" +
      "Rooms the caller cannot mute (not a participant, no longer an active " +
      "member, room gone) are silently `skipped`, never fatal. Each updated " +
      "room emits `conv:muted` / `conv:unmuted` on the caller's own socket " +
      "channel so their other devices re-render without a refetch.",
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatBulkMuteRequest" },
          examples: {
            muteEightHours: {
              summary: "Mute two conversations for 8 hours",
              value: {
                action: "mute",
                roomIds: ["prv_abc123", "grp_aaa111"],
                durationMinutes: 480,
              },
            },
            unmute: {
              summary: "Unmute",
              value: { action: "unmute", roomIds: ["prv_abc123"] },
            },
          },
        },
      },
    },
    responses: {
      ...successResponse("Bulk mute/unmute result", "ChatBulkMuteResult"),
      "400": badRequest,
      "401": unauthorized,
    },
  },
};

const conversationsBulkRead = {
  post: {
    tags: ["Chat — Inbox"],
    operationId: "bulkMarkConversationsRead",
    summary: "Bulk mark conversations as read",
    description:
      "Zeroes the caller's unread count on multiple conversations. Each room " +
      "is read up to its CURRENT last message, resolved server-side — the " +
      "client sends no boundary id and therefore cannot mark a conversation " +
      "read past a message that arrived after the list rendered.\n\n" +
      "Runs the full read path per room, identical to " +
      "`POST /chat/private/rooms/{roomId}/read`: the read pointer advances " +
      "**forward-only**, `message:read` reaches the sender(s) so their ticks " +
      "turn blue, `read_sync` reaches the caller's other devices, the nav " +
      "badge total is recomputed and the tray notification is dismissed.\n\n" +
      "Nothing else changes: no messages are deleted, no timestamps are " +
      "rewritten and `lastActivity`/list ordering are untouched.",
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatBulkMarkReadRequest" },
          examples: {
            basic: {
              summary: "Mark four conversations read",
              value: {
                roomIds: [
                  "prv_abc123",
                  "prv_def456",
                  "grp_aaa111",
                  "grp_bbb222",
                ],
              },
            },
          },
        },
      },
    },
    responses: {
      ...successResponse("Bulk mark-as-read result", "ChatBulkMarkReadResult"),
      "400": badRequest,
      "401": unauthorized,
    },
  },
};

export const chatPaths = {
  // Unified inbox
  "/chat/inbox": chatInbox,
  "/chat/unread-summary": unreadSummary,

  // Unified inbox — bulk (multi-select) operations
  "/chat/conversations/leave/bulk": conversationsBulkLeave,
  "/chat/conversations/mute/bulk": conversationsBulkMute,
  "/chat/conversations/read/bulk": conversationsBulkRead,

  // Private messaging
  "/chat/private/conversations": privateConversations,
  "/chat/private/rooms/{peerId}": privateRoomByPeer,
  "/chat/private/rooms/{roomId}": privateRoomDelete,
  "/chat/private/rooms/{roomId}/clear": privateRoomClear,
  "/chat/private/rooms/{roomId}/messages": privateMessages,
  "/chat/private/rooms/{roomId}/media": privateMedia,
  "/chat/private/rooms/{roomId}/messages/search": privateSearch,
  "/chat/private/messages/{messageId}": privateMessageDelete,
  "/chat/private/messages/{messageId}/report": privateMessageReport,
  "/chat/private/rooms/{roomId}/mute": privateRoomMute,
  "/chat/private/rooms/{roomId}/unmute": privateRoomUnmute,
  "/chat/private/rooms/{roomId}/archive": privateRoomArchive,
  "/chat/private/rooms/{roomId}/unarchive": privateRoomUnarchive,
  "/chat/private/presence/{userId}": privatePresence,
  "/chat/private/rooms/{roomId}/pins": privatePins,

  // Group rooms
  "/chat/groups": groupCreate,
  "/chat/groups/my-groups": groupMyGroups,
  "/chat/groups/{roomId}": groupById,
  "/chat/groups/{roomId}/clear": groupClear,
  "/chat/groups/{roomId}/disband": groupDisband,
  "/chat/groups/{roomId}/archive": groupArchive,
  "/chat/groups/{roomId}/unarchive": groupUnarchive,
  "/chat/groups/{roomId}/messages": groupMessages,
  "/chat/groups/{roomId}/conversation": groupConversation,
  "/chat/groups/{roomId}/media": groupMedia,
  "/chat/groups/{roomId}/messages/search": groupSearch,
  "/chat/groups/messages/delete": groupMessageDelete,
  "/chat/groups/messages/{messageId}": groupMessageEdit,
  "/chat/groups/{roomId}/pins": groupPins,

  // Group members
  "/chat/group-members/add": groupMemberAdd,
  "/chat/group-members/{roomId}/leave": groupMemberLeave,
  "/chat/group-members/kick": groupMemberKick,
  "/chat/group-members/ban": groupMemberBan,
  "/chat/group-members/unban": groupMemberUnban,
  "/chat/group-members/report": groupMemberReport,
  "/chat/group-members/role": groupMemberRole,
  "/chat/group-members/{roomId}": groupMembers,
  "/chat/group-members/{roomId}/mute": groupMemberMute,
  "/chat/group-members/{roomId}/unmute": groupMemberUnmute,
  "/chat/group-members/mute-member": groupMemberMuteMember,
  "/chat/group-members/unmute-member": groupMemberUnmuteMember,

  // Group invite links
  "/chat/invite-links": inviteLinkCreate,
  "/chat/invite-links/revoke": inviteLinkRevoke,
  "/chat/invite-links/preview/{token}": inviteLinkPreview,
  "/chat/invite-links/join": inviteLinkJoin,
  "/chat/invite-links/room/{roomId}": inviteLinksByRoom,

  // Notifications
  "/chat/notifications": notifications,
  "/chat/notifications/read": notificationRead,
  "/chat/notifications/read-all": notificationReadAll,
  "/chat/notifications/unread-count": notificationUnreadCount,
  "/chat/notifications/{id}/action": notificationAction,

  // Community rooms
  "/chat/community/rooms": communityRooms,
  "/chat/community/rooms/search": communitySearch,
  "/chat/community/rooms/{roomId}/join": communityJoin,
  "/chat/community/rooms/{roomId}/leave": communityLeave,
  "/chat/community/rooms/{roomId}/sync": communityRoomSync,
  "/chat/community/rooms/{roomId}/messages": communityMessages,
  "/chat/community/rooms/{roomId}/conversation": communityConversation,
  "/chat/community/rooms/{roomId}/media": communityMedia,
  "/chat/community/rooms/{roomId}/messages/search": communitySearch2,
  "/chat/community/messages/{messageId}": {
    ...communityMessageDelete,
    ...communityMessageEdit,
  },
  "/chat/community/messages/{messageId}/react": communityMessageReact,
  "/chat/community/rooms/{roomId}/messages/{messageId}/pin":
    communityMessagePin,
  "/chat/community/rooms/{roomId}/pins": {
    ...communityPinMessage,
    ...communityGetPins,
  },
  "/chat/community/rooms/{roomId}/pins/{messageId}": communityUnpinMessage,
  "/chat/community/rooms/{roomId}/messages/{messageId}/context":
    communityMessageContext,
  "/chat/community/rooms/{roomId}/messages/{messageId}/forward":
    communityMessageForward,

  // Private — forward & reactions
  "/chat/private/rooms/{roomId}/messages/{messageId}/forward":
    privateMessageForward,
  "/chat/private/rooms/{roomId}/messages/{messageId}/reactions":
    privateMessageReactions,
  "/chat/private/rooms/{roomId}/messages/{messageId}/reactions/{emoji}":
    privateMessageRemoveReaction,

  // Groups — forward & reactions
  "/chat/groups/{roomId}/messages/{messageId}/forward": groupMessageForward,
  "/chat/groups/{roomId}/messages/{messageId}/reactions": groupMessageReactions,
  "/chat/groups/{roomId}/messages/{messageId}/reactions/{emoji}":
    groupMessageRemoveReaction,

  // Unified cross-conversation-type message navigation
  "/chat/messages/{messageId}/context": unifiedMessageContext,

  // Calls
  "/chat/calls": callHistory,
  "/chat/calls/{callId}": callById,
};
