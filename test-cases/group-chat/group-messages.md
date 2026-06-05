# Group Chat — Messages (send / edit / delete / forward / reactions / media / pins / search)

**Source:** `apps/chat-service/src/api/routes/group-message.routes.ts` · `controllers/group-message.controller.ts` · `services/group-message.service.ts` · `services/group-pin.service.ts` · `validators/group-message.validator.ts`, `query.validator.ts` · `repositories/group-message.repository.ts` · `docs/SOCKET_EVENTS.md` §4

**HTTP endpoints (base `/api/chat/groups`):**

- `GET /:roomId/messages` — timestamp-paginated timeline (`before_ts`/`after_ts`, `limit≤100`)
- `GET /:roomId/conversation` — offset-paginated + advances read pointer
- `GET /:roomId/messages/search?q=` — text search
- `GET /:roomId/media?type=` — shared media cursor list
- `GET /:roomId/pins` — pinned messages
- `POST /messages/delete` — delete for everyone (own or admin) `{ messageId, roomId }`
- `PATCH /messages/:messageId` — edit own TEXT message `{ content:{ text, urls?, files? } }`
- `POST /:roomId/messages/:messageId/forward` — forward `{ targetRoomId, clientMessageId? }`
- `GET /:roomId/messages/:messageId/reactions` — reaction detail

**Sending a group message is socket-only** (`message:send` with `conversationType:"group"` → gRPC → `GroupMessageService.sendMessage`). See websocket-events tests for the send path; key server behaviors below.

**Rate limit:** `gm:send` — 30/min on delete, edit, forward.

**Message edit rules:** own message only (`CHAT_EDIT_OWN_MESSAGES_ONLY`); TEXT only (`CHAT_EDIT_TEXT_ONLY`); not deleted (`CHAT_MESSAGE_ALREADY_DELETED`); within `CHAT_EDIT_WINDOW_MS` (`CHAT_EDIT_WINDOW_EXPIRED`, 410); text ≤ `CHAT_TEXT_MAX_CHARS`.

**Delete rules:** own → `SELF_DELETE`; other's → requires `{OWNER, ADMIN, MODERATOR}` → `ADMIN_DELETE`, else `CHAT_INSUFFICIENT_PERMISSIONS`. Must be active member.

---

### TC-GCHAT-106 — Send group message (socket, happy path)

| Field                     | Value                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Send                                                                                                 |
| **API/Event Name**        | `message:send` (`/chat`, `conversationType:"group"`)                                                                         |
| **Test Scenario**         | Active member sends TEXT message                                                                                             |
| **Category**              | Happy Path                                                                                                                   |
| **Priority**              | High                                                                                                                         |
| **Preconditions**         | Sender is ACTIVE member of `conv:<roomId>`                                                                                   |
| **Request Payload**       | `{ conversationId, clientMessageId, contentType:"TEXT", contentText:"hi", conversationType:"group" }`                        |
| **Expected Response**     | ack `{ success:true, data:{ messageId, sequenceNumber, sentAt } }`                                                           |
| **Expected DB Changes**   | New `GroupMessage` with monotonic `sequenceNumber`; room `lastMessage*` bumped; `unreadCount`+1 for all other active members |
| **Expected Socket/Event** | `message:new` on `conv:<roomId>`; `conv:updated` to each active member's `user:<id>` (sender's copy `unread:false`)          |
| **Notes**                 | `clientMessageId` is idempotent; non-member → `CHAT_NOT_A_MEMBER`.                                                           |

### TC-GCHAT-107 — Send message idempotency (duplicate clientMessageId)

| Field                     | Value                                              |
| ------------------------- | -------------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Send                       |
| **API/Event Name**        | `message:send`                                     |
| **Test Scenario**         | Re-send same clientMessageId                       |
| **Category**              | Edge Case                                          |
| **Priority**              | High                                               |
| **Preconditions**         | A message with this clientMessageId already exists |
| **Request Payload**       | identical payload                                  |
| **Expected Response**     | ack returns the SAME `messageId` (no new row)      |
| **Expected DB Changes**   | None (idempotency cache + P2002 dup path)          |
| **Expected Socket/Event** | None (no duplicate fan-out)                        |
| **Notes**                 | Cache key `roomId:senderId:clientMessageId`.       |

### TC-GCHAT-108 — Non-member cannot send

| Field                     | Value                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Send                                         |
| **API/Event Name**        | `message:send`                                                       |
| **Test Scenario**         | Outsider sends to group                                              |
| **Category**              | Security                                                             |
| **Priority**              | High                                                                 |
| **Preconditions**         | Sender not an active member                                          |
| **Request Payload**       | group send payload                                                   |
| **Expected Response**     | ack `{ success:false, error:"SERVICE_ERROR" }` (`CHAT_NOT_A_MEMBER`) |
| **Expected DB Changes**   | None                                                                 |
| **Expected Socket/Event** | None                                                                 |
| **Notes**                 | Membership verified in `sendMessage`.                                |

### TC-GCHAT-109 — Send text exceeding max length

| Field                     | Value                                             |
| ------------------------- | ------------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Send                      |
| **API/Event Name**        | `message:send`                                    |
| **Test Scenario**         | content.text > CHAT_TEXT_MAX_CHARS                |
| **Category**              | Input Validation                                  |
| **Priority**              | Medium                                            |
| **Preconditions**         | Active member                                     |
| **Request Payload**       | very long text                                    |
| **Expected Response**     | `CHAT_TEXT_TOO_LONG`                              |
| **Expected DB Changes**   | None                                              |
| **Expected Socket/Event** | None                                              |
| **Notes**                 | Defensive cap in service (socket path skips Zod). |

### TC-GCHAT-110 — Edit own TEXT message within window

| Field                     | Value                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Edit                                                                            |
| **API/Event Name**        | `PATCH /api/chat/groups/messages/:messageId`                                                            |
| **Test Scenario**         | Author edits text shortly after sending                                                                 |
| **Category**              | Happy Path                                                                                              |
| **Priority**              | High                                                                                                    |
| **Preconditions**         | Caller authored a TEXT message < edit window ago                                                        |
| **Request Payload**       | `{ "content": { "text": "edited" } }`                                                                   |
| **Expected Response**     | `200` updated message, `editedAt` set (`CHAT_MESSAGE_EDITED`)                                           |
| **Expected DB Changes**   | `content.text` updated; `editedAt` set                                                                  |
| **Expected Socket/Event** | `message:edited` on `conv:<roomId>` `{ messageId, conversationId, contentText, contentJson, editedAt }` |
| **Notes**                 | `editGroupMessageSchema` requires `text` min 1.                                                         |

### TC-GCHAT-111 — Edit someone else's message (forbidden)

| Field                     | Value                                              |
| ------------------------- | -------------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Edit                       |
| **API/Event Name**        | `PATCH /api/chat/groups/messages/:messageId`       |
| **Test Scenario**         | Non-author (even admin) edits                      |
| **Category**              | RBAC                                               |
| **Priority**              | High                                               |
| **Preconditions**         | Message authored by another user                   |
| **Request Payload**       | `{ "content": { "text": "x" } }`                   |
| **Expected Response**     | `400` `CHAT_EDIT_OWN_MESSAGES_ONLY`                |
| **Expected DB Changes**   | None                                               |
| **Expected Socket/Event** | None                                               |
| **Notes**                 | Admins cannot edit others' messages (only delete). |

### TC-GCHAT-112 — Edit a non-TEXT message (forbidden)

| Field                     | Value                                        |
| ------------------------- | -------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Edit                 |
| **API/Event Name**        | `PATCH /api/chat/groups/messages/:messageId` |
| **Test Scenario**         | Edit an IMAGE/VIDEO message                  |
| **Category**              | Business Rule                                |
| **Priority**              | Medium                                       |
| **Preconditions**         | Own message, type ≠ TEXT                     |
| **Request Payload**       | `{ "content": { "text": "x" } }`             |
| **Expected Response**     | `400` `CHAT_EDIT_TEXT_ONLY`                  |
| **Expected DB Changes**   | None                                         |
| **Expected Socket/Event** | None                                         |
| **Notes**                 | —                                            |

### TC-GCHAT-113 — Edit after window expired

| Field                     | Value                                        |
| ------------------------- | -------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Edit                 |
| **API/Event Name**        | `PATCH /api/chat/groups/messages/:messageId` |
| **Test Scenario**         | Edit older than CHAT_EDIT_WINDOW_MS          |
| **Category**              | Business Rule                                |
| **Priority**              | High                                         |
| **Preconditions**         | Own TEXT message past edit window            |
| **Request Payload**       | `{ "content": { "text": "late" } }`          |
| **Expected Response**     | `410` `CHAT_EDIT_WINDOW_EXPIRED`             |
| **Expected DB Changes**   | None                                         |
| **Expected Socket/Event** | None                                         |
| **Notes**                 | `GoneError`.                                 |

### TC-GCHAT-114 — Edit a deleted message

| Field                     | Value                                        |
| ------------------------- | -------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Edit                 |
| **API/Event Name**        | `PATCH /api/chat/groups/messages/:messageId` |
| **Test Scenario**         | Message already deleted                      |
| **Category**              | Edge Case                                    |
| **Priority**              | Medium                                       |
| **Preconditions**         | Message `isDeleted=true`                     |
| **Request Payload**       | `{ "content": { "text": "x" } }`             |
| **Expected Response**     | `400` `CHAT_MESSAGE_ALREADY_DELETED`         |
| **Expected DB Changes**   | None                                         |
| **Expected Socket/Event** | None                                         |
| **Notes**                 | —                                            |

### TC-GCHAT-115 — Edit empty text (validation)

| Field                     | Value                                        |
| ------------------------- | -------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Edit                 |
| **API/Event Name**        | `PATCH /api/chat/groups/messages/:messageId` |
| **Test Scenario**         | text empty                                   |
| **Category**              | Input Validation                             |
| **Priority**              | Low                                          |
| **Preconditions**         | Own TEXT message                             |
| **Request Payload**       | `{ "content": { "text": "" } }`              |
| **Expected Response**     | `400` validation error (min 1)               |
| **Expected DB Changes**   | None                                         |
| **Expected Socket/Event** | None                                         |
| **Notes**                 | —                                            |

### TC-GCHAT-116 — Author deletes own message (SELF_DELETE)

| Field                     | Value                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Delete                                                                           |
| **API/Event Name**        | `POST /api/chat/groups/messages/delete`                                                                  |
| **Test Scenario**         | Author deletes their message for everyone                                                                |
| **Category**              | Happy Path                                                                                               |
| **Priority**              | High                                                                                                     |
| **Preconditions**         | Caller authored the message; active member                                                               |
| **Request Payload**       | `{ "messageId":"m1", "roomId":"grp_x" }`                                                                 |
| **Expected Response**     | `200` tombstoned message (`deletedType:"SELF_DELETE"`)                                                   |
| **Expected DB Changes**   | `isDeleted=true`, `deletedType="SELF_DELETE"`                                                            |
| **Expected Socket/Event** | `message:delete` on `conv:<roomId>` `{ messageId, type:"forEveryone", deletedBy }` (socket gateway path) |
| **Notes**                 | HTTP path persists tombstone; catch-up returns the tombstone.                                            |

### TC-GCHAT-117 — Admin deletes another member's message (ADMIN_DELETE)

| Field                     | Value                                                     |
| ------------------------- | --------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Delete                            |
| **API/Event Name**        | `POST /api/chat/groups/messages/delete`                   |
| **Test Scenario**         | Admin moderates a member's message                        |
| **Category**              | RBAC                                                      |
| **Priority**              | High                                                      |
| **Preconditions**         | Caller OWNER/ADMIN/MODERATOR; message authored by another |
| **Request Payload**       | `{ "messageId":"m1", "roomId":"grp_x" }`                  |
| **Expected Response**     | `200` `deletedType:"ADMIN_DELETE"`                        |
| **Expected DB Changes**   | `isDeleted=true`, `deletedType="ADMIN_DELETE"`            |
| **Expected Socket/Event** | `message:delete` `{ type:"forEveryone", deletedBy }`      |
| **Notes**                 | —                                                         |

### TC-GCHAT-118 — Member deletes another's message (forbidden)

| Field                     | Value                                       |
| ------------------------- | ------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Delete              |
| **API/Event Name**        | `POST /api/chat/groups/messages/delete`     |
| **Test Scenario**         | Plain member deletes someone else's message |
| **Category**              | RBAC                                        |
| **Priority**              | High                                        |
| **Preconditions**         | Caller MEMBER; message authored by another  |
| **Request Payload**       | `{ "messageId":"m1", "roomId":"grp_x" }`    |
| **Expected Response**     | `400` `CHAT_INSUFFICIENT_PERMISSIONS`       |
| **Expected DB Changes**   | None                                        |
| **Expected Socket/Event** | None                                        |
| **Notes**                 | —                                           |

### TC-GCHAT-119 — Delete by non-member

| Field                     | Value                                    |
| ------------------------- | ---------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Delete           |
| **API/Event Name**        | `POST /api/chat/groups/messages/delete`  |
| **Test Scenario**         | Non-member deletes a message             |
| **Category**              | Security                                 |
| **Priority**              | High                                     |
| **Preconditions**         | Caller not a member                      |
| **Request Payload**       | `{ "messageId":"m1", "roomId":"grp_x" }` |
| **Expected Response**     | `400` `CHAT_NOT_A_MEMBER`                |
| **Expected DB Changes**   | None                                     |
| **Expected Socket/Event** | None                                     |
| **Notes**                 | —                                        |

### TC-GCHAT-120 — Delete non-existent message

| Field                     | Value                                         |
| ------------------------- | --------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Delete                |
| **API/Event Name**        | `POST /api/chat/groups/messages/delete`       |
| **Test Scenario**         | messageId unknown                             |
| **Category**              | Error Handling                                |
| **Priority**              | Low                                           |
| **Preconditions**         | Active member                                 |
| **Request Payload**       | `{ "messageId":"missing", "roomId":"grp_x" }` |
| **Expected Response**     | `404` `CHAT_MESSAGE_NOT_FOUND`                |
| **Expected DB Changes**   | None                                          |
| **Expected Socket/Event** | None                                          |
| **Notes**                 | —                                             |

### TC-GCHAT-121 — Forward a message into another group

| Field                     | Value                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Forward                                                                           |
| **API/Event Name**        | `POST /api/chat/groups/:roomId/messages/:messageId/forward`                                               |
| **Test Scenario**         | Member forwards a message to a group they belong to                                                       |
| **Category**              | Happy Path                                                                                                |
| **Priority**              | High                                                                                                      |
| **Preconditions**         | Caller is ACTIVE member of `targetRoomId`; source message exists & not deleted                            |
| **Request Payload**       | `{ "targetRoomId":"grp_y", "clientMessageId":"c1" }`                                                      |
| **Expected Response**     | `201` new forwarded message (`CHAT_MESSAGE_FORWARDED`)                                                    |
| **Expected DB Changes**   | New `GroupMessage` in target with `forwardData`; target `lastMessage*` bumped; `sequenceNumber` allocated |
| **Expected Socket/Event** | `message:new` on `conv:<targetRoomId>` (`isForwarded:true`); `conv:updated` fan-out to target members     |
| **Notes**                 | `:roomId` is the source room; membership enforced on TARGET.                                              |

### TC-GCHAT-122 — Forward to a group you're not a member of

| Field                     | Value                                                       |
| ------------------------- | ----------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Forward                             |
| **API/Event Name**        | `POST /api/chat/groups/:roomId/messages/:messageId/forward` |
| **Test Scenario**         | Forward into a group outsider                               |
| **Category**              | Security                                                    |
| **Priority**              | High                                                        |
| **Preconditions**         | Caller not a member of `targetRoomId`                       |
| **Request Payload**       | `{ "targetRoomId":"grp_other" }`                            |
| **Expected Response**     | `403` `CHAT_NOT_A_MEMBER`                                   |
| **Expected DB Changes**   | None                                                        |
| **Expected Socket/Event** | None                                                        |
| **Notes**                 | `ForbiddenError`.                                           |

### TC-GCHAT-123 — Forward a deleted source message

| Field                     | Value                                                       |
| ------------------------- | ----------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Forward                             |
| **API/Event Name**        | `POST /api/chat/groups/:roomId/messages/:messageId/forward` |
| **Test Scenario**         | Source message tombstoned                                   |
| **Category**              | Edge Case                                                   |
| **Priority**              | Medium                                                      |
| **Preconditions**         | Source `isDeleted=true`                                     |
| **Request Payload**       | `{ "targetRoomId":"grp_y" }`                                |
| **Expected Response**     | `404` `CHAT_MESSAGE_NOT_FOUND`                              |
| **Expected DB Changes**   | None                                                        |
| **Expected Socket/Event** | None                                                        |
| **Notes**                 | —                                                           |

### TC-GCHAT-124 — Forward idempotency (duplicate clientMessageId)

| Field                     | Value                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Forward                                                                                                       |
| **API/Event Name**        | `POST /api/chat/groups/:roomId/messages/:messageId/forward`                                                                           |
| **Test Scenario**         | Re-forward same clientMessageId into target                                                                                           |
| **Category**              | Edge Case                                                                                                                             |
| **Priority**              | Medium                                                                                                                                |
| **Preconditions**         | Forward with this clientMessageId already exists in target                                                                            |
| **Request Payload**       | `{ "targetRoomId":"grp_y", "clientMessageId":"c1" }`                                                                                  |
| **Expected Response**     | `201` returns existing forwarded message (no new row)                                                                                 |
| **Expected DB Changes**   | None                                                                                                                                  |
| **Expected Socket/Event** | **NOTE:** controller still publishes `message:new` + `conv:updated` even on the idempotent return — possible duplicate fan-out. Flag. |
| **Notes**                 | Service returns existing; controller emits unconditionally.                                                                           |

### TC-GCHAT-125 — Get message reactions (detail)

| Field                     | Value                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Group Chat / Messages — Reactions                                                                            |
| **API/Event Name**        | `GET /api/chat/groups/:roomId/messages/:messageId/reactions`                                                 |
| **Test Scenario**         | List who reacted with each emoji                                                                             |
| **Category**              | Happy Path                                                                                                   |
| **Priority**              | Medium                                                                                                       |
| **Preconditions**         | Message has reactions                                                                                        |
| **Request Payload**       | —                                                                                                            |
| **Expected Response**     | `200` `{ reactions: { "<emoji>": { count, users:[{userId,displayName,avatar}], selfReacted } } }`            |
| **Expected DB Changes**   | None                                                                                                         |
| **Expected Socket/Event** | None                                                                                                         |
| **Notes**                 | `selfReacted` computed vs requester. Reactions are toggled via socket `message:react` (see websocket tests). |

### TC-GCHAT-126 — Reactions on non-existent message

| Field                     | Value                                                        |
| ------------------------- | ------------------------------------------------------------ |
| **Feature/Module**        | Group Chat / Messages — Reactions                            |
| **API/Event Name**        | `GET /api/chat/groups/:roomId/messages/:messageId/reactions` |
| **Test Scenario**         | messageId unknown                                            |
| **Category**              | Error Handling                                               |
| **Priority**              | Low                                                          |
| **Preconditions**         | Active member                                                |
| **Request Payload**       | —                                                            |
| **Expected Response**     | `404` `CHAT_MESSAGE_NOT_FOUND`                               |
| **Expected DB Changes**   | None                                                         |
| **Expected Socket/Event** | None                                                         |
| **Notes**                 | `getReactions` returns null → NotFound.                      |

### TC-GCHAT-127 — Toggle reaction via socket

| Field                     | Value                                                                  |
| ------------------------- | ---------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Reactions                                      |
| **API/Event Name**        | `message:react` (`/chat`, `conversationType:"group"`)                  |
| **Test Scenario**         | Add then remove an emoji                                               |
| **Category**              | Happy Path                                                             |
| **Priority**              | Medium                                                                 |
| **Preconditions**         | Active member; message exists                                          |
| **Request Payload**       | `{ messageId, conversationId, emoji:"👍" }`                            |
| **Expected Response**     | ack `{ success:true, data:{ messageId, reactions:[{userId,emoji}] } }` |
| **Expected DB Changes**   | `reactions` map updated on `GroupMessage`                              |
| **Expected Socket/Event** | `message:reaction` on `conv:<roomId>` with FULL current reaction set   |
| **Notes**                 | Re-emit same emoji toggles it off.                                     |

### TC-GCHAT-128 — Timeline pagination (before_ts)

| Field                     | Value                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Group Chat / Messages — Timeline                                                                                               |
| **API/Event Name**        | `GET /api/chat/groups/:roomId/messages?before_ts=<ms>&limit=30`                                                                |
| **Test Scenario**         | Newest-first page older than a timestamp                                                                                       |
| **Category**              | Pagination/Filter/Sort                                                                                                         |
| **Priority**              | High                                                                                                                           |
| **Preconditions**         | Room has >30 messages                                                                                                          |
| **Request Payload**       | query `before_ts`, `limit`                                                                                                     |
| **Expected Response**     | `200` timeline page, `hasMore`, `nextCursor` (epoch-ms of boundary)                                                            |
| **Expected DB Changes**   | None                                                                                                                           |
| **Expected Socket/Event** | None                                                                                                                           |
| **Notes**                 | Over-fetch +1 makes `hasMore` exact. **No membership gate** on this endpoint (matches getMessages comment) — see TC-GCHAT-133. |

### TC-GCHAT-129 — Timeline with both before_ts and after_ts (validation)

| Field                     | Value                                                          |
| ------------------------- | -------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Timeline                               |
| **API/Event Name**        | `GET /api/chat/groups/:roomId/messages?before_ts=1&after_ts=2` |
| **Test Scenario**         | Mutually-exclusive params both set                             |
| **Category**              | Input Validation                                               |
| **Priority**              | Medium                                                         |
| **Preconditions**         | —                                                              |
| **Request Payload**       | both timestamps                                                |
| **Expected Response**     | `400` "Provide either before_ts or after_ts, not both"         |
| **Expected DB Changes**   | None                                                           |
| **Expected Socket/Event** | None                                                           |
| **Notes**                 | `.refine`.                                                     |

### TC-GCHAT-130 — Timeline limit over max (validation)

| Field                     | Value                                             |
| ------------------------- | ------------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Timeline                  |
| **API/Event Name**        | `GET /api/chat/groups/:roomId/messages?limit=101` |
| **Test Scenario**         | limit > 100                                       |
| **Category**              | Input Validation                                  |
| **Priority**              | Low                                               |
| **Preconditions**         | —                                                 |
| **Request Payload**       | `limit=101`                                       |
| **Expected Response**     | `400` validation error                            |
| **Expected DB Changes**   | None                                              |
| **Expected Socket/Event** | None                                              |
| **Notes**                 | max 100.                                          |

### TC-GCHAT-131 — Conversation page advances read pointer

| Field                     | Value                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Group Chat / Messages — Conversation                                                                         |
| **API/Event Name**        | `GET /api/chat/groups/:roomId/conversation?pageNumber=1&limit=30`                                            |
| **Test Scenario**         | Member opens conversation, read pointer moves                                                                |
| **Category**              | DB State                                                                                                     |
| **Priority**              | High                                                                                                         |
| **Preconditions**         | Caller ACTIVE member with unread messages                                                                    |
| **Request Payload**       | query `pageNumber`, `limit`, `timestamp?`                                                                    |
| **Expected Response**     | `200` newest-first page + total                                                                              |
| **Expected DB Changes**   | `GroupMember.lastReadMessageId`/`lastReadAt` advanced to newest msg (forward-only); `unreadCount` recomputed |
| **Expected Socket/Event** | None                                                                                                         |
| **Notes**                 | Membership enforced (`ForbiddenError CHAT_NOT_A_MEMBER`). See read-unread.md.                                |

### TC-GCHAT-132 — Conversation by non-member (gated)

| Field                     | Value                                                             |
| ------------------------- | ----------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Conversation                              |
| **API/Event Name**        | `GET /api/chat/groups/:roomId/conversation`                       |
| **Test Scenario**         | Non-member reads conversation                                     |
| **Category**              | Security                                                          |
| **Priority**              | High                                                              |
| **Preconditions**         | Caller not a member                                               |
| **Request Payload**       | —                                                                 |
| **Expected Response**     | `403` `CHAT_NOT_A_MEMBER`                                         |
| **Expected DB Changes**   | None                                                              |
| **Expected Socket/Event** | None                                                              |
| **Notes**                 | This endpoint DOES gate membership (unlike `/messages` timeline). |

### TC-GCHAT-133 — Timeline by non-member (NO gate) — SECURITY

| Field                     | Value                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Timeline                                                                                                                                                |
| **API/Event Name**        | `GET /api/chat/groups/:roomId/messages`                                                                                                                                         |
| **Test Scenario**         | Non-member reads message history                                                                                                                                                |
| **Category**              | Security                                                                                                                                                                        |
| **Priority**              | High                                                                                                                                                                            |
| **Preconditions**         | Caller not a member of roomId                                                                                                                                                   |
| **Request Payload**       | query                                                                                                                                                                           |
| **Expected Response**     | `200` messages returned (CURRENT — `getMessagesTimeline` has no membership check)                                                                                               |
| **Expected DB Changes**   | None                                                                                                                                                                            |
| **Expected Socket/Event** | None                                                                                                                                                                            |
| **Notes**                 | **IDOR:** `/messages`, `/messages/search`, `/pins`, and `/messages/:id/reactions` lack a membership gate; `/conversation` and `/media` do gate. Inconsistent — flag for review. |

### TC-GCHAT-134 — Search messages by text

| Field                     | Value                                                  |
| ------------------------- | ------------------------------------------------------ |
| **Feature/Module**        | Group Chat / Messages — Search                         |
| **API/Event Name**        | `GET /api/chat/groups/:roomId/messages/search?q=hello` |
| **Test Scenario**         | Find messages containing a term                        |
| **Category**              | Happy Path                                             |
| **Priority**              | Medium                                                 |
| **Preconditions**         | Room has matching messages                             |
| **Request Payload**       | query `q`, `limit`, `page`                             |
| **Expected Response**     | `200` matching list (`CHAT_MESSAGES_SEARCHED`)         |
| **Expected DB Changes**   | None                                                   |
| **Expected Socket/Event** | None                                                   |
| **Notes**                 | Empty/whitespace `q` → empty list, no DB query.        |

### TC-GCHAT-135 — Search with empty q

| Field                     | Value                                             |
| ------------------------- | ------------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Search                    |
| **API/Event Name**        | `GET /api/chat/groups/:roomId/messages/search?q=` |
| **Test Scenario**         | Blank query                                       |
| **Category**              | Edge Case                                         |
| **Priority**              | Low                                               |
| **Preconditions**         | —                                                 |
| **Request Payload**       | `q=""`                                            |
| **Expected Response**     | `200` empty list, `CHAT_NO_MESSAGES_FOUND`        |
| **Expected DB Changes**   | None                                              |
| **Expected Socket/Event** | None                                              |
| **Notes**                 | Short-circuits before repo.                       |

### TC-GCHAT-136 — List shared media (filtered by type)

| Field                     | Value                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Media                                                                   |
| **API/Event Name**        | `GET /api/chat/groups/:roomId/media?type=IMAGE&limit=30`                                        |
| **Test Scenario**         | Media gallery for a group                                                                       |
| **Category**              | Pagination/Filter/Sort                                                                          |
| **Priority**              | Medium                                                                                          |
| **Preconditions**         | Caller ACTIVE member; room has media                                                            |
| **Request Payload**       | query `type`, `cursor`, `limit`                                                                 |
| **Expected Response**     | `200` cursor list (`buildCursorResponse`, key `createdAt`)                                      |
| **Expected DB Changes**   | None                                                                                            |
| **Expected Socket/Event** | None                                                                                            |
| **Notes**                 | Membership enforced (`CHAT_NOT_A_MEMBER`). `type` enum: IMAGE/VIDEO/GIF/VOICE/DOCUMENT/STICKER. |

### TC-GCHAT-137 — Media invalid type (validation)

| Field                     | Value                                         |
| ------------------------- | --------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Media                 |
| **API/Event Name**        | `GET /api/chat/groups/:roomId/media?type=XYZ` |
| **Test Scenario**         | Bad type enum                                 |
| **Category**              | Input Validation                              |
| **Priority**              | Low                                           |
| **Preconditions**         | —                                             |
| **Request Payload**       | `type=XYZ`                                    |
| **Expected Response**     | `400` validation error                        |
| **Expected DB Changes**   | None                                          |
| **Expected Socket/Event** | None                                          |
| **Notes**                 | —                                             |

### TC-GCHAT-138 — List pinned messages

| Field                     | Value                                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Pins                                                                                                              |
| **API/Event Name**        | `GET /api/chat/groups/:roomId/pins`                                                                                                       |
| **Test Scenario**         | Fetch pinned messages                                                                                                                     |
| **Category**              | Pagination/Filter/Sort                                                                                                                    |
| **Priority**              | Low                                                                                                                                       |
| **Preconditions**         | Room has pins                                                                                                                             |
| **Request Payload**       | query `limit`, `cursor`, `page`                                                                                                           |
| **Expected Response**     | `200` paginated pins (sort key `pinnedAt`)                                                                                                |
| **Expected DB Changes**   | None                                                                                                                                      |
| **Expected Socket/Event** | None                                                                                                                                      |
| **Notes**                 | **NOTE:** no pin/unpin HTTP endpoint is exposed in group routes (only list). Pin creation appears handled elsewhere/not wired — flag gap. |

### TC-GCHAT-139 — Media list by non-member (gated)

| Field                     | Value                                                |
| ------------------------- | ---------------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Media                        |
| **API/Event Name**        | `GET /api/chat/groups/:roomId/media`                 |
| **Test Scenario**         | Non-member lists media                               |
| **Category**              | Security                                             |
| **Priority**              | Medium                                               |
| **Preconditions**         | Caller not a member                                  |
| **Request Payload**       | —                                                    |
| **Expected Response**     | `400` `CHAT_NOT_A_MEMBER`                            |
| **Expected DB Changes**   | None                                                 |
| **Expected Socket/Event** | None                                                 |
| **Notes**                 | Confirms media is gated even though timeline is not. |

### TC-GCHAT-140 — Edit rate limit (gm:send 30/min)

| Field                     | Value                                          |
| ------------------------- | ---------------------------------------------- |
| **Feature/Module**        | Group Chat / Messages — Edit                   |
| **API/Event Name**        | `PATCH /api/chat/groups/messages/:messageId`   |
| **Test Scenario**         | >30 edit/delete/forward ops per minute         |
| **Category**              | Rate Limit                                     |
| **Priority**              | Low                                            |
| **Preconditions**         | Same user did 30 ops in window                 |
| **Request Payload**       | edit body                                      |
| **Expected Response**     | `429` Too Many Requests                        |
| **Expected DB Changes**   | None                                           |
| **Expected Socket/Event** | None                                           |
| **Notes**                 | Shared `sendLimit` across delete/edit/forward. |
