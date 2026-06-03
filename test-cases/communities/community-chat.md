# Communities — Community Chat (chat-service side)

**Source:** `apps/chat-service/src/api/routes/community.routes.ts`, `controllers/community.controller.ts` (`CommunityController`), `controllers/community-message.controller.ts` (`CommunityMessageController`), `services/community-room.service.ts`, `services/community-message.service.ts`, `validators/community.validator.ts` (`editCommunityMessageSchema`), `validators/query.validator.ts`. Socket contract: `docs/SOCKET_EVENTS.md` §5 (`/community` namespace) + §4 list-bump (`community:updated`).

> **Service:** chat-service (MongoDB / Prisma; gRPC `4004`). This is the **community CHAT** surface — distinct from community-service which owns membership/roles/moderation. Here a community == one `GeneralRoom` (id === community.id). REST is mounted under the chat-service community router; real-time messaging flows over the gateway `/community` namespace.
>
> **Split-brain note:** chat-service `join`/`leave` here upsert a chat-room membership row and bump member count — they do **NOT** go through community-service's join-request/role pipeline. A user can be a chat-room member without a community-service membership and vice-versa. This is an ambiguity to flag (see `_index.md`).

REST base (chat-service): `/api/v1/.../community` (router from `createCommunityRoutes`).

---

### TC-COMM-117 — List community rooms

| Field                     | Value                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --- | -------------------------------------------------- |
| **Feature/Module**        | Community Chat / Rooms                                                                                                          |
| **API/Event Name**        | `GET /rooms`                                                                                                                    |
| **Test Scenario**         | List active community chat rooms with unread flags                                                                              |
| **Category**              | Pagination/Filter/Sort                                                                                                          |
| **Priority**              | Medium                                                                                                                          |
| **Preconditions**         | Active GeneralRooms exist (provisioned on community create)                                                                     |
| **Request Payload**       | query `page,limit`                                                                                                              |
| **Expected Response**     | `200` paginated rooms; each `hasUnread` computed from caller read timestamps                                                    |
| **Expected DB Changes**   | None                                                                                                                            |
| **Expected Socket/Event** | None                                                                                                                            |
| **Notes**                 | `GET /rooms` and `/rooms/search` are NOT authenticated in the router (no `authenticate`); userId derived from `req.auth?.userId |     | null`. Flag: roster/listing is effectively public. |

### TC-COMM-118 — Search community rooms

| Field                     | Value                                                            |
| ------------------------- | ---------------------------------------------------------------- |
| **Feature/Module**        | Community Chat / Rooms                                           |
| **API/Event Name**        | `GET /rooms/search?query=&page=&limit=`                          |
| **Test Scenario**         | Search rooms by name                                             |
| **Category**              | Pagination/Filter/Sort                                           |
| **Priority**              | Low                                                              |
| **Preconditions**         | —                                                                |
| **Request Payload**       | `query=rust`                                                     |
| **Expected Response**     | `200` paginated matches (or "no rooms found" message when empty) |
| **Expected DB Changes**   | None                                                             |
| **Expected Socket/Event** | None                                                             |
| **Notes**                 | Unauthenticated (see TC-COMM-117).                               |

### TC-COMM-119 — Join community room

| Field                     | Value                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Community Chat / Rooms                                                                     |
| **API/Event Name**        | `POST /rooms/:roomId/join`                                                                 |
| **Test Scenario**         | Authenticated user joins a chat room                                                       |
| **Category**              | Happy Path                                                                                 |
| **Priority**              | High                                                                                       |
| **Preconditions**         | Room exists; caller not banned in room                                                     |
| **Request Payload**       | —                                                                                          |
| **Expected Response**     | `200` `CHAT_ROOM_JOINED`                                                                   |
| **Expected DB Changes**   | RoomMember upsert (status active, role member, joinedAt); `memberNumber += 1`              |
| **Expected Socket/Event** | None emitted by this REST handler (member.joined is a community-service/socket flow)       |
| **Notes**                 | This is chat-service membership, separate from community-service membership (split-brain). |

### TC-COMM-120 — Join non-existent room

| Field                     | Value                       |
| ------------------------- | --------------------------- |
| **Feature/Module**        | Community Chat / Rooms      |
| **API/Event Name**        | `POST /rooms/:roomId/join`  |
| **Test Scenario**         | roomId does not exist       |
| **Category**              | Error Handling              |
| **Priority**              | Medium                      |
| **Preconditions**         | Unknown roomId              |
| **Request Payload**       | —                           |
| **Expected Response**     | `404` `CHAT_ROOM_NOT_FOUND` |
| **Expected DB Changes**   | None                        |
| **Expected Socket/Event** | None                        |
| **Notes**                 | —                           |

### TC-COMM-121 — Join when banned from room

| Field                     | Value                                    |
| ------------------------- | ---------------------------------------- |
| **Feature/Module**        | Community Chat / Rooms                   |
| **API/Event Name**        | `POST /rooms/:roomId/join`               |
| **Test Scenario**         | Banned user joins                        |
| **Category**              | Security / Business Rule                 |
| **Priority**              | High                                     |
| **Preconditions**         | Caller banned in room (chat-service ban) |
| **Request Payload**       | —                                        |
| **Expected Response**     | `400` `CHAT_BANNED_FROM_ROOM`            |
| **Expected DB Changes**   | None                                     |
| **Expected Socket/Event** | None                                     |
| **Notes**                 | `memberRepo.isBanned`.                   |

### TC-COMM-122 — Leave community room

| Field                     | Value                                                   |
| ------------------------- | ------------------------------------------------------- |
| **Feature/Module**        | Community Chat / Rooms                                  |
| **API/Event Name**        | `POST /rooms/:roomId/leave`                             |
| **Test Scenario**         | Member leaves chat room                                 |
| **Category**              | Happy Path                                              |
| **Priority**              | Medium                                                  |
| **Preconditions**         | Authenticated; active member                            |
| **Request Payload**       | —                                                       |
| **Expected Response**     | `200` `CHAT_ROOM_LEFT`                                  |
| **Expected DB Changes**   | member status updated (leftAt set); `memberNumber -= 1` |
| **Expected Socket/Event** | None                                                    |
| **Notes**                 | —                                                       |

### TC-COMM-123 — Get room messages (paginated)

| Field                     | Value                                              |
| ------------------------- | -------------------------------------------------- |
| **Feature/Module**        | Community Chat / Messages                          |
| **API/Event Name**        | `GET /rooms/:roomId/messages?cursor=&limit=&page=` |
| **Test Scenario**         | Fetch message history                              |
| **Category**              | Pagination/Filter/Sort                             |
| **Priority**              | High                                               |
| **Preconditions**         | Authenticated; room has messages                   |
| **Request Payload**       | query (validated by `messageListQuerySchema`)      |
| **Expected Response**     | `200` paginated messages keyed by createdAt cursor |
| **Expected DB Changes**   | None                                               |
| **Expected Socket/Event** | None                                               |
| **Notes**                 | `authenticate` required on message routes.         |

### TC-COMM-124 — Get conversation (timeline) / room media / search

| Field                     | Value                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Community Chat / Messages                                                                             |
| **API/Event Name**        | `GET /rooms/:roomId/conversation` · `GET /rooms/:roomId/media` · `GET /rooms/:roomId/messages/search` |
| **Test Scenario**         | Timeline pagination, media-only listing, message search                                               |
| **Category**              | Pagination/Filter/Sort                                                                                |
| **Priority**              | Medium                                                                                                |
| **Preconditions**         | Authenticated                                                                                         |
| **Request Payload**       | `conversation`: pageNumber/limit/timestamp; `media`: type/cursor/limit; `search`: q/limit/page        |
| **Expected Response**     | `200` paginated/cursor results; empty search `q` → empty list                                         |
| **Expected DB Changes**   | None                                                                                                  |
| **Expected Socket/Event** | None                                                                                                  |
| **Notes**                 | Validated by `conversationQuerySchema` / `mediaListQuerySchema` / `messageSearchQuerySchema`.         |

### TC-COMM-125 — Edit own community message (text, ≤15 min)

| Field                     | Value                                                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Community Chat / Messages                                                                                                                                      |
| **API/Event Name**        | `PATCH /messages/:messageId`                                                                                                                                   |
| **Test Scenario**         | Sender edits own text message within window                                                                                                                    |
| **Category**              | Happy Path                                                                                                                                                     |
| **Priority**              | High                                                                                                                                                           |
| **Preconditions**         | Caller is sender; text-only; within 15-min window                                                                                                              |
| **Request Payload**       | `{ "communityId": "<id>", "content": { "text": "fixed typo" } }`                                                                                               |
| **Expected Response**     | `200` `CHAT_MESSAGE_EDITED` with updated message                                                                                                               |
| **Expected DB Changes**   | message text/editedAt updated                                                                                                                                  |
| **Expected Socket/Event** | `/community`: `community:message:edited` published to `community:<communityId>` `{ messageId, communityId, roomId, senderId, message, contentType, editedAt }` |
| **Notes**                 | `communityId` required in body so broadcast reaches the right room. Rate-limited (`cm:send` 30/60s).                                                           |

### TC-COMM-126 — Edit message not owned / outside window / non-text

| Field                     | Value                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------- |
| **Feature/Module**        | Community Chat / Messages                                                              |
| **API/Event Name**        | `PATCH /messages/:messageId`                                                           |
| **Test Scenario**         | Edit another's message, expired window, or media message                               |
| **Category**              | Business Rule / Security                                                               |
| **Priority**              | High                                                                                   |
| **Preconditions**         | Not sender / >15 min / non-text                                                        |
| **Request Payload**       | `{ "communityId": "<id>", "content": { "text": "x" } }`                                |
| **Expected Response**     | `4xx` from `editMessage` (verify exact code/message in `community-message.service.ts`) |
| **Expected DB Changes**   | None                                                                                   |
| **Expected Socket/Event** | None                                                                                   |
| **Notes**                 | Confirm ownership + window + text-only enforcement in service.                         |

### TC-COMM-127 — Edit message empty / too-long text

| Field                     | Value                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------- |
| **Feature/Module**        | Community Chat / Messages                                                             |
| **API/Event Name**        | `PATCH /messages/:messageId`                                                          |
| **Test Scenario**         | content.text empty or exceeds CHAT_TEXT_MAX_CHARS                                     |
| **Category**              | Input Validation                                                                      |
| **Priority**              | Medium                                                                                |
| **Preconditions**         | —                                                                                     |
| **Request Payload**       | `{ "communityId":"x", "content": { "text": "" } }`                                    |
| **Expected Response**     | `400`                                                                                 |
| **Expected DB Changes**   | None                                                                                  |
| **Expected Socket/Event** | None                                                                                  |
| **Notes**                 | `editCommunityMessageSchema`: text min 1, max CHAT_TEXT_MAX_CHARS; communityId min 1. |

### TC-COMM-128 — Delete community message (forMe / forEveryone)

| Field                     | Value                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Community Chat / Messages                                                                                 |
| **API/Event Name**        | `DELETE /messages/:messageId?type=forEveryone`                                                            |
| **Test Scenario**         | Delete a community message                                                                                |
| **Category**              | Happy Path                                                                                                |
| **Priority**              | High                                                                                                      |
| **Preconditions**         | Authenticated; caller permitted to delete                                                                 |
| **Request Payload**       | query `type=forEveryone` (default forMe)                                                                  |
| **Expected Response**     | `200` with delete result                                                                                  |
| **Expected DB Changes**   | message soft-deleted (forEveryone) / per-user hidden (forMe)                                              |
| **Expected Socket/Event** | `message:delete` published to `conv:<roomId>` `{ messageId, type, deletedBy }` (NOT on community channel) |
| **Notes**                 | Rate-limited. Client hides forEveryone for all; forMe only when deletedBy===self.                         |

### TC-COMM-129 — New message bump-to-top (community:updated)

| Field                     | Value                                                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Community Chat / Realtime                                                                                                                          |
| **API/Event Name**        | event `community:updated` (socket)                                                                                                                 |
| **Test Scenario**         | A new community message bumps the community list for members                                                                                       |
| **Category**              | DB State / Realtime                                                                                                                                |
| **Priority**              | Medium                                                                                                                                             |
| **Preconditions**         | Members listening on `/chat`                                                                                                                       |
| **Request Payload**       | (driven by `community:message:send`)                                                                                                               |
| **Expected Response**     | n/a (socket)                                                                                                                                       |
| **Expected DB Changes**   | room lastMessage/lastMessageAt updated                                                                                                             |
| **Expected Socket/Event** | `community:updated` to `user:<id>` on **`/chat`** namespace `{ communityId, roomId, lastMessageId, lastMessage, lastMessageAt, senderId, unread }` |
| **Notes**                 | Intentionally on `/chat` (not `/community`) — see SOCKET_EVENTS §4. `community:message:new` is on `/community`.                                    |

### TC-COMM-130 — Send message rate limit

| Field                     | Value                                                        |
| ------------------------- | ------------------------------------------------------------ |
| **Feature/Module**        | Community Chat / Messages                                    |
| **API/Event Name**        | `PATCH /messages/:messageId` · `DELETE /messages/:messageId` |
| **Test Scenario**         | Exceed 30 message-mutations per 60s                          |
| **Category**              | Rate Limit                                                   |
| **Priority**              | Medium                                                       |
| **Preconditions**         | Authenticated                                                |
| **Request Payload**       | 31 rapid edit/delete calls                                   |
| **Expected Response**     | `429` after limit                                            |
| **Expected DB Changes**   | None beyond first 30                                         |
| **Expected Socket/Event** | None                                                         |
| **Notes**                 | `messageLimit` keyPrefix `cm:send`, window 60s, max 30.      |
