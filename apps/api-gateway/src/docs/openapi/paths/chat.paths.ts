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
      "Cursor-paginated list of the authenticated user's private rooms, ordered by last message.",
    security: [{ bearerAuth: [] }],
    parameters: [cursorParam(), limitParam(20)],
    responses: {
      ...successResponse("Conversation list", "ChatPrivateRoomList"),
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
      "Fetch the user's in-app notification inbox. Real-time updates arrive via Socket.IO /notify namespace; use this endpoint for initial load and pagination.",
    security: [{ bearerAuth: [] }],
    parameters: [cursorParam(), limitParam(20)],
    responses: {
      ...successResponse("Notifications", "ChatNotificationList"),
      "401": unauthorized,
    },
  },
};

const notificationRead = {
  post: {
    tags: ["Chat — Notifications"],
    operationId: "markNotificationRead",
    summary: "Mark notification as read",
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatMarkReadRequest" },
        },
      },
    },
    responses: {
      ...successResponse("Marked as read"),
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
    security: [{ bearerAuth: [] }],
    responses: {
      ...successResponse("All marked as read"),
      "401": unauthorized,
    },
  },
};

const notificationUnreadCount = {
  get: {
    tags: ["Chat — Notifications"],
    operationId: "getUnreadNotificationCount",
    summary: "Get unread notification count",
    security: [{ bearerAuth: [] }],
    responses: {
      ...successResponse("Unread count", "ChatUnreadCountData"),
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
      "- **PRIVATE** communities: only ACTIVE members can read; non-members and banned users get `403 CHAT_NOT_A_MEMBER`.\n\n" +
      "**Personal system messages:** SYSTEM messages with `isPersonal: true` (e.g. COMMUNITY_JOINED, 'You joined this community') are returned ONLY to the target user — other members never see them in this history, even in PUBLIC communities.\n\n" +
      "**Scroll / history mode** (`before_ts` or neither):\n" +
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
      "- Returns ~limit/2 messages on each side of the anchor. Mutually exclusive with before_ts/after_ts.",
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
        name: "around",
        in: "query",
        required: false,
        schema: { type: "string", minLength: 1, maxLength: 100 },
        description:
          "Message ID to anchor a jump-to-message window. Returns ~limit/2 messages on each side. Mutually exclusive with before_ts/after_ts.",
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
                description:
                  "The community-service Community.id (used for the broadcast + activity bump).",
              },
              message: {
                type: "string" as const,
                maxLength: 4000,
                description: "Plain-text body (max 4000 chars).",
              },
              messageType: {
                type: "string" as const,
                description:
                  "Community message kind (accepted case-insensitively; lower-case spelling + 'custom'). Normalized to UPPER-CASE on the wire.",
              },
              parentMessageId: {
                type: "string" as const,
                nullable: true,
                description: "ID of the message being replied to.",
              },
              clientMessageId: {
                type: "string" as const,
                description: "Idempotency key.",
              },
              media: {
                type: "object" as const,
                description: "Structured media attachments.",
                properties: {
                  files: {
                    type: "array" as const,
                    items: { type: "object" as const },
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
        "Case-insensitive substring search over message text in the room.",
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
          description: "Search term.",
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
// WebRTC
// =============================================================================
const rtcConfig = {
  get: {
    tags: ["Chat — WebRTC"],
    operationId: "getIceServers",
    summary: "Get WebRTC ICE server configuration",
    description:
      "Returns STUN/TURN ICE server configuration for establishing WebRTC peer connections. Fetch at app startup or on `call:initiate`. Falls back to 503 if the config service is unavailable.",
    security: [{ bearerAuth: [] }],
    responses: {
      ...successResponse("ICE server configuration", "ChatRtcConfiguration"),
      "401": unauthorized,
      "503": {
        description: "Config service temporarily unavailable",
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
export const chatPaths = {
  // Unified inbox
  "/chat/inbox": chatInbox,

  // Private messaging
  "/chat/private/conversations": privateConversations,
  "/chat/private/rooms/{peerId}": privateRoomByPeer,
  "/chat/private/rooms/{roomId}": privateRoomDelete,
  "/chat/private/rooms/{roomId}/messages": privateMessages,
  "/chat/private/rooms/{roomId}/media": privateMedia,
  "/chat/private/rooms/{roomId}/messages/search": privateSearch,
  "/chat/private/messages/{messageId}": privateMessageDelete,
  "/chat/private/messages/{messageId}/report": privateMessageReport,
  "/chat/private/rooms/{roomId}/mute": privateRoomMute,
  "/chat/private/rooms/{roomId}/unmute": privateRoomUnmute,
  "/chat/private/presence/{userId}": privatePresence,
  "/chat/private/rooms/{roomId}/pins": privatePins,

  // Group rooms
  "/chat/groups": groupCreate,
  "/chat/groups/my-groups": groupMyGroups,
  "/chat/groups/{roomId}": groupById,
  "/chat/groups/{roomId}/disband": groupDisband,
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
  "/chat/group-members/role": groupMemberRole,
  "/chat/group-members/{roomId}": groupMembers,

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

  // Calls
  "/chat/calls": callHistory,
  "/chat/calls/{callId}": callById,

  // WebRTC
  "/webrtc/rtc-config": rtcConfig,

  // TODO(notifications): The notifications-service exposes device-token
  // registration endpoints — `POST /v1/devices` and `DELETE /v1/devices/:token`
  // (FCM token store + event-driven push). They are intentionally NOT documented
  // here because the API gateway does not currently proxy notifications-service:
  // the versioned service registry (apps/api-gateway/src/versioning/registry.ts)
  // only routes `auth`, `users`, `communities`, and `chat`. Once a
  // `notifications` segment is added to the registry, document these under a
  // "Notifications — Devices" tag with the public gateway path (e.g.
  // `/notifications/v1/devices`).
};
