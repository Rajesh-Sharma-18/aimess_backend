# Group Chat — Read / Unread

**Source:** `apps/chat-service/src/services/group-message.service.ts` (`getConversation` read-pointer side effect) · `repositories/group-member.repository.ts` (`markRead`, `advanceReadPointer`, `incUnreadForRoom`, `countUnreadAfter`) · `services/group-member.service.ts` (`markRead`) · `services/group-room.service.ts` (`getInboxGroups` unread enrichment) · `docs/SOCKET_EVENTS.md` §4 (`message:read`)

**How unread works in group chat:**

- On a real (non-SYSTEM) send, `incUnreadForRoom` increments `unreadCount` for **all other active members**.
- SYSTEM messages do **not** raise unread (see system-messages.md).
- Reading is driven by **`GET /api/chat/groups/rooms/:roomId/conversation`** which, as a side effect, advances the caller's read pointer (`lastReadMessageId`, `lastReadAt`) to the newest message in the page and recomputes `unreadCount` (`countUnreadAfter`). Forward-only — never regresses.
- `GroupMemberService.markRead` exists (`{ roomId, userId, lastMessageId }`, zeroes unread) but **has no HTTP route in group-member.routes.ts** — reachable only via socket `message:read` through the gateway. Flagged.

> **Socket `message:read`** (`/chat`): client emits `{ conversationId, upToMessageId }`; server publishes `message:read` `{ conversationId, readerId, upToMessageId }` to `conv:<roomId>`. (Group has no `message:delivered` — delivery receipts are private-only.)

---

### TC-GCHAT-155 — Sending a message increments others' unread

| Field                     | Value                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Read-Unread                                                              |
| **API/Event Name**        | `message:send` (group)                                                                |
| **Test Scenario**         | Real message raises unread for all other active members                               |
| **Category**              | DB State                                                                              |
| **Priority**              | High                                                                                  |
| **Preconditions**         | Group with 3 active members                                                           |
| **Request Payload**       | TEXT send by member A                                                                 |
| **Expected Response**     | ack success                                                                           |
| **Expected DB Changes**   | `unreadCount`+1 for B and C; A unchanged                                              |
| **Expected Socket/Event** | `message:new` on `conv:<roomId>`; `conv:updated` per member (A's copy `unread:false`) |
| **Notes**                 | `incUnreadForRoom(roomId, excludeSender)`.                                            |

### TC-GCHAT-156 — Opening conversation zeroes/recomputes unread

| Field                     | Value                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Read-Unread                                                                                                  |
| **API/Event Name**        | `GET /api/chat/groups/rooms/:roomId/conversation`                                                                         |
| **Test Scenario**         | Reading newest page clears unread                                                                                         |
| **Category**              | DB State                                                                                                                  |
| **Priority**              | High                                                                                                                      |
| **Preconditions**         | Caller has unreadCount>0; fetches page 1 (newest)                                                                         |
| **Request Payload**       | `pageNumber=1&limit=30`                                                                                                   |
| **Expected Response**     | `200` page                                                                                                                |
| **Expected DB Changes**   | `lastReadMessageId`/`lastReadAt` = newest message; `unreadCount` = `countUnreadAfter(newest)` (typically 0 on first page) |
| **Expected Socket/Event** | None (HTTP path; socket `message:read` is the realtime variant)                                                           |
| **Notes**                 | Read pointer advances only to index-0 (newest) of the page.                                                               |

### TC-GCHAT-157 — Reading an OLD page does not wrongly zero unread

| Field                     | Value                                                                         |
| ------------------------- | ----------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Read-Unread                                                      |
| **API/Event Name**        | `GET /api/chat/groups/rooms/:roomId/conversation?pageNumber=3`                |
| **Test Scenario**         | Viewing an older page when newer unread messages exist                        |
| **Category**              | Edge Case                                                                     |
| **Priority**              | High                                                                          |
| **Preconditions**         | Many unread; caller requests an old page                                      |
| **Request Payload**       | `pageNumber=3&limit=30`                                                       |
| **Expected Response**     | `200` older page                                                              |
| **Expected DB Changes**   | `unreadCount` = count of messages still newer than that page's newest (NOT 0) |
| **Expected Socket/Event** | None                                                                          |
| **Notes**                 | `countUnreadAfter` prevents incorrect zeroing — key correctness case.         |

### TC-GCHAT-158 — Read pointer is forward-only

| Field                     | Value                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Read-Unread                                                                             |
| **API/Event Name**        | `GET /api/chat/groups/rooms/:roomId/conversation`                                                    |
| **Test Scenario**         | Re-reading an older page after a newer read does not regress the pointer                             |
| **Category**              | Business Rule                                                                                        |
| **Priority**              | Medium                                                                                               |
| **Preconditions**         | `lastReadAt` already at newest; then fetch an older page                                             |
| **Request Payload**       | old page                                                                                             |
| **Expected Response**     | `200`                                                                                                |
| **Expected DB Changes**   | Pointer NOT moved backward (`advanceReadPointer` skips when stored `lastReadAt >= messageCreatedAt`) |
| **Expected Socket/Event** | None                                                                                                 |
| **Notes**                 | —                                                                                                    |

### TC-GCHAT-159 — Socket message:read broadcasts read receipt

| Field                     | Value                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Read-Unread                                                                |
| **API/Event Name**        | `message:read` (`/chat`)                                                                |
| **Test Scenario**         | Member marks read up to a message                                                       |
| **Category**              | Happy Path                                                                              |
| **Priority**              | Medium                                                                                  |
| **Preconditions**         | Active member in `conv:<roomId>`                                                        |
| **Request Payload**       | `{ conversationId, upToMessageId }`                                                     |
| **Expected Response**     | ack success                                                                             |
| **Expected DB Changes**   | `markRead` sets `lastReadMessageId`, `lastReadAt`, `unreadCount=0` (ACTIVE member only) |
| **Expected Socket/Event** | `message:read` on `conv:<roomId>` `{ conversationId, readerId, upToMessageId }`         |
| **Notes**                 | Socket path zeroes unread (vs HTTP conversation which recomputes).                      |

### TC-GCHAT-160 — message:read by non-active member is a no-op

| Field                     | Value                                             |
| ------------------------- | ------------------------------------------------- |
| **Feature/Module**        | Group Chat / Read-Unread                          |
| **API/Event Name**        | `message:read` (`/chat`)                          |
| **Test Scenario**         | LEFT/KICKED user marks read                       |
| **Category**              | Edge Case                                         |
| **Priority**              | Low                                               |
| **Preconditions**         | Caller membership not ACTIVE                      |
| **Request Payload**       | `{ conversationId, upToMessageId }`               |
| **Expected Response**     | ack (no error) but no update                      |
| **Expected DB Changes**   | None (`markRead` returns null when not ACTIVE)    |
| **Expected Socket/Event** | Possibly `message:read` re-emit with no DB effect |
| **Notes**                 | —                                                 |

### TC-GCHAT-161 — No group-chat HTTP mark-read route (gap assertion)

| Field                     | Value                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Read-Unread                                                                                                                    |
| **API/Event Name**        | (no route) e.g. `POST /api/chat/group-members/read`                                                                                         |
| **Test Scenario**         | Mark-read via REST                                                                                                                          |
| **Category**              | Error Handling                                                                                                                              |
| **Priority**              | Low                                                                                                                                         |
| **Preconditions**         | Authenticated                                                                                                                               |
| **Request Payload**       | `{ roomId, lastMessageId }` (`markReadSchema` exists in validator)                                                                          |
| **Expected Response**     | `404` route not found                                                                                                                       |
| **Expected DB Changes**   | None                                                                                                                                        |
| **Expected Socket/Event** | None                                                                                                                                        |
| **Notes**                 | **Gap:** `markReadSchema` + `GroupMemberService.markRead` exist but are not wired to any HTTP route; only socket `message:read` reaches it. |

### TC-GCHAT-162 — Inbox reflects per-member unread count

| Field                     | Value                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Read-Unread                                                           |
| **API/Event Name**        | `GET /api/chat/inbox`                                                              |
| **Test Scenario**         | Inbox group item shows correct unreadCount + isMuted + role                        |
| **Category**              | DB State                                                                           |
| **Priority**              | Medium                                                                             |
| **Preconditions**         | Caller has unread in a group                                                       |
| **Request Payload**       | —                                                                                  |
| **Expected Response**     | Inbox item enriched: `unreadCount`, `isMuted`, `role` from the caller's membership |
| **Expected DB Changes**   | None                                                                               |
| **Expected Socket/Event** | None                                                                               |
| **Notes**                 | `getInboxGroups` joins memberships per room.                                       |

### TC-GCHAT-163 — Concurrent reads do not corrupt unread

| Field                     | Value                                                                          |
| ------------------------- | ------------------------------------------------------------------------------ |
| **Feature/Module**        | Group Chat / Read-Unread                                                       |
| **API/Event Name**        | `GET /api/chat/groups/rooms/:roomId/conversation` (×2) + socket `message:read` |
| **Test Scenario**         | Same user reads via HTTP and socket simultaneously                             |
| **Category**              | Concurrency                                                                    |
| **Priority**              | Low                                                                            |
| **Preconditions**         | Caller active member with unread                                               |
| **Request Payload**       | parallel reads                                                                 |
| **Expected Response**     | Both succeed                                                                   |
| **Expected DB Changes**   | `unreadCount` converges to a non-negative value; pointer never regresses       |
| **Expected Socket/Event** | `message:read` (socket path)                                                   |
| **Notes**                 | Forward-only guard mitigates regression; verify no negative unread.            |
