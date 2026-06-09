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
 */
function messageTimelineParams() {
  return [
    {
      name: "before_ts",
      in: "query" as const,
      required: false,
      schema: { type: "integer" as const, minimum: 1 },
      description:
        "Epoch ms. Returns messages with createdAt <= before_ts (newest-first).",
    },
    {
      name: "after_ts",
      in: "query" as const,
      required: false,
      schema: { type: "integer" as const, minimum: 1 },
      description:
        "Epoch ms. Returns messages with createdAt >= after_ts (oldest-first).",
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
      ...successResponse("Message edited"),
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
      ...successResponse("Message edited"),
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

// =============================================================================
// Private messaging
// =============================================================================
const privateConversations = {
  get: {
    tags: ["Chat — Private"],
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
      ...successResponse("Inbox list", "ChatInboxList"),
      "400": badRequest,
      "401": unauthorized,
    },
  },
};

const privateRoomByPeer = {
  post: {
    tags: ["Chat — Private"],
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
      ...successResponse("Messages", "ChatMessageList"),
      "401": unauthorized,
      "404": notFound,
    },
  },
};

const privateMessageDelete = {
  patch: {
    tags: ["Chat — Private"],
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
      ...successResponse("Message edited"),
      "400": badRequest,
      "401": unauthorized,
      "404": notFound,
    },
  },
  delete: {
    tags: ["Chat — Private"],
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
      ...successResponse("Message deleted"),
      "400": badRequest,
      "401": unauthorized,
    },
  },
};

const privateMessageReport = {
  post: {
    tags: ["Chat — Private"],
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
      ...successResponse("Messages", "ChatMessageList"),
      "401": unauthorized,
      "404": notFound,
    },
  },
};

const groupMessageDelete = {
  post: {
    tags: ["Chat — Groups"],
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
      ...successResponse("Message deleted"),
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
    },
  },
};

const groupPins = {
  get: {
    tags: ["Chat — Groups"],
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
    },
  },
};

const groupMemberLeave = {
  post: {
    tags: ["Chat — Groups"],
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
const notifications = {
  get: {
    tags: ["Chat — Notifications"],
    summary: "List notifications",
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

const communityMessages = {
  get: {
    tags: ["Chat — Community"],
    summary: "Get community room messages",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "roomId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      cursorParam(),
      limitParam(30),
    ],
    responses: {
      ...successResponse("Messages", "ChatCommunityMessageList"),
      "401": unauthorized,
      "404": notFound,
    },
  },
};

const communityMessageDelete = {
  delete: {
    tags: ["Chat — Community"],
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
      ...successResponse("Message deleted"),
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

const communityGetPins = {
  get: {
    tags: ["Chat — Community"],
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
// Media uploads
// =============================================================================
const mediaDownloadUrl = {
  post: {
    tags: ["Chat — Media"],
    summary: "Get presigned download URL",
    description:
      "Returns a short-lived presigned GET URL for playing/downloading an uploaded object (e.g. voice notes). Object key must start with chat-uploads/.",
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatDownloadUrlRequest" },
        },
      },
    },
    responses: {
      ...successResponse("Download URL", "ChatDownloadUrlData"),
      "400": badRequest,
      "401": unauthorized,
    },
  },
};

const mediaUploadUrl = {
  post: {
    tags: ["Chat — Media"],
    summary: "Get presigned upload URL",
    description:
      "Returns a presigned URL for uploading a file to object storage. Supports images, video, audio, and documents.",
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatUploadUrlRequest" },
        },
      },
    },
    responses: {
      ...successResponse("Upload URL", "ChatUploadUrlData"),
      "400": badRequest,
      "401": unauthorized,
    },
  },
};

// =============================================================================
// Private — forward & reactions
// =============================================================================
const privateMessageForward = {
  post: {
    tags: ["Chat — Private"],
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
      ...successResponse("Message forwarded", undefined, "201"),
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
};

// =============================================================================
// Groups — forward & reactions
// =============================================================================
const groupMessageForward = {
  post: {
    tags: ["Chat — Groups"],
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
      ...successResponse("Message forwarded", undefined, "201"),
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
};

// =============================================================================
// Calls
// =============================================================================
const callHistory = {
  get: {
    tags: ["Chat — Calls"],
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
  "/chat/community/rooms/{roomId}/messages": communityMessages,
  "/chat/community/rooms/{roomId}/conversation": communityConversation,
  "/chat/community/rooms/{roomId}/media": communityMedia,
  "/chat/community/rooms/{roomId}/messages/search": communitySearch2,
  "/chat/community/messages/{messageId}": {
    ...communityMessageDelete,
    ...communityMessageEdit,
  },
  "/chat/community/rooms/{roomId}/pins": {
    ...communityPinMessage,
    ...communityGetPins,
  },
  "/chat/community/rooms/{roomId}/pins/{messageId}": communityUnpinMessage,

  // Private — forward & reactions
  "/chat/private/rooms/{roomId}/messages/{messageId}/forward":
    privateMessageForward,
  "/chat/private/rooms/{roomId}/messages/{messageId}/reactions":
    privateMessageReactions,

  // Groups — forward & reactions
  "/chat/groups/{roomId}/messages/{messageId}/forward": groupMessageForward,
  "/chat/groups/{roomId}/messages/{messageId}/reactions": groupMessageReactions,

  // Calls
  "/chat/calls": callHistory,
  "/chat/calls/{callId}": callById,

  // WebRTC
  "/webrtc/rtc-config": rtcConfig,

  // Media
  "/chat/media/upload-url": mediaUploadUrl,
  "/chat/media/download-url": mediaDownloadUrl,

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
